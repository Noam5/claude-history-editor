# Randomize Session ID Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a "Randomize ID" feature that replaces a session's id with a fresh UUIDv4 everywhere it appears in the file, renames the `.jsonl` file to match, and re-keys the search index.

**Architecture:** A transactional server function (`randomizeSessionId` in `server/editor.ts`) performs a whole-file string replace of the old id → new id, validates the result, gzip-backs-up the original, atomically promotes the renamed file, and deletes the old one — mirroring the existing edit/delete safety pipeline (fingerprint guard, temp write, `validateJsonl`, backup, atomic rename). A thin `POST /api/session/randomize-id` route generates the UUID and re-keys the index. A header button drives it from the client.

**Tech Stack:** Node 24 (built-in `crypto.randomUUID`, `node:sqlite` FTS5), Fastify, React 19 + Vite, Vitest.

---

## Environment Note (read first)

This project requires **Node 24** (Node 22's bundled SQLite lacks FTS5, so the server won't start). Before running anything:

```bash
export NVM_DIR="$HOME/.nvm"; . "$NVM_DIR/nvm.sh"; nvm use 24
```

The project is **not** a git repository, so there are no per-task commits. Each task ends with a **save/verify checkpoint** (run the test suite) instead. Run tests via `node node_modules/vitest/vitest.mjs` (the `node_modules/.bin` shims may lack the execute bit).

## File Structure

- **Modify** `server/editor.ts` — add `randomizeSessionId()` (new exported function). This is the core transactional operation.
- **Modify** `server/indexer.ts` — add a public `removeSessionByPath()` method (today only a private `removeSession` exists) so the route can drop the old path's index rows.
- **Modify** `server/app.ts` — add the `POST /api/session/randomize-id` route.
- **Modify** `client/src/api.ts` — add `randomizeId()`.
- **Modify** `client/src/App.tsx` — add the "Randomize ID" button + handler in the session header.
- **Test** `server/editor.test.ts` — unit tests for `randomizeSessionId`.

---

## Task 1: Core `randomizeSessionId` — happy path (field + embedded rewrite, rename, backup)

**Files:**
- Modify: `server/editor.ts`
- Test: `server/editor.test.ts`

- [ ] **Step 1: Write the failing test**

Add this `describe` block to the end of `server/editor.test.ts` (after the existing `describe("safe message editing", ...)` block closes). It builds a fixture whose id appears both as the structured `sessionId` field and embedded inside a `toolUseResult.originalFile` string, then asserts the rename + full rewrite + backup.

```typescript
describe("randomizing a session id", () => {
  let root: string;
  let backups: string;
  const oldId = "f119e2d5-600e-42c5-a63f-7b8e05bdc59e";
  const newId = "a7c3e901-4f2b-4c8d-9e1a-2b6f0d3c5e74";

  function fixtureLines(id: string): string {
    const user = JSON.stringify({
      type: "user",
      uuid: "u1",
      sessionId: id,
      message: { role: "user", content: "hello" }
    });
    const assistant = JSON.stringify({
      type: "assistant",
      uuid: "a1",
      parentUuid: "u1",
      sessionId: id,
      message: { role: "assistant", content: [{ type: "text", text: "hi" }] },
      toolUseResult: { originalFile: `/data/${id}/notes.md (originSessionId: ${id})` }
    });
    const meta = JSON.stringify({ type: "last-prompt", sessionId: id, leafUuid: "a1" });
    return `${user}\n${assistant}\n${meta}\n`;
  }

  beforeEach(async () => {
    root = await fsp.mkdtemp(path.join(os.tmpdir(), "randomize-id-"));
    backups = path.join(root, "backups");
    await fsp.writeFile(path.join(root, `${oldId}.jsonl`), fixtureLines(oldId));
  });

  afterEach(async () => {
    await fsp.rm(root, { recursive: true, force: true });
  });

  it("renames the file and replaces every occurrence of the id, with a backup", async () => {
    const oldPath = path.join(root, `${oldId}.jsonl`);
    const result = await randomizeSessionId(oldPath, backups, {
      newId,
      fingerprint: await fileFingerprint(oldPath)
    });

    // Returns the new identity.
    expect(result.newSessionId).toBe(newId);
    expect(result.newPath).toBe(path.join(root, `${newId}.jsonl`));

    // Old file gone, new file present.
    await expect(fsp.access(oldPath)).rejects.toBeTruthy();
    const content = await fsp.readFile(result.newPath, "utf8");

    // Zero occurrences of the old id remain anywhere.
    expect(content).not.toContain(oldId);

    // New id is in the structured field of every record AND the embedded substring.
    const lines = content.trimEnd().split("\n").map((l) => JSON.parse(l));
    expect(lines).toHaveLength(3);
    for (const record of lines) {
      expect(record.sessionId).toBe(newId);
    }
    expect(lines[1].toolUseResult.originalFile).toBe(
      `/data/${newId}/notes.md (originSessionId: ${newId})`
    );

    // A gzip backup of the original was created.
    const backupDirectories = await fsp.readdir(backups);
    const backupFiles = await fsp.readdir(path.join(backups, backupDirectories[0]));
    expect(backupFiles).toHaveLength(1);
    expect(backupFiles[0]).toMatch(/\.gz$/);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
export NVM_DIR="$HOME/.nvm"; . "$NVM_DIR/nvm.sh"; nvm use 24
node node_modules/vitest/vitest.mjs run server/editor.test.ts
```

Expected: FAIL — `randomizeSessionId is not exported` / `is not a function` (the function doesn't exist yet).

- [ ] **Step 3: Write the minimal implementation**

Add this exported function to `server/editor.ts`. Place it after `deleteMessageBranch` (around line 98), before the `replaceValidatedFile` helper. It reuses the existing `createBackup`, `pruneBackups`, `fileFingerprint`, `EditConflictError`, and `validateJsonl` (already imported at the top of the file).

```typescript
export async function randomizeSessionId(
  filePath: string,
  backupRoot: string,
  request: { newId: string; fingerprint: string }
): Promise<{ newSessionId: string; newPath: string; fingerprint: string }> {
  if ((await fileFingerprint(filePath)) !== request.fingerprint) {
    throw new EditConflictError();
  }

  const directory = path.dirname(filePath);
  const oldId = path.basename(filePath, ".jsonl");
  const newPath = path.join(directory, `${request.newId}.jsonl`);
  const source = await fsp.readFile(filePath, "utf8");
  const replacement = source.split(oldId).join(request.newId);
  const stat = await fsp.stat(filePath);
  const tempPath = `${newPath}.${process.pid}.${Date.now()}.tmp`;

  try {
    await fsp.writeFile(tempPath, replacement, { flag: "wx", mode: stat.mode });
    await validateJsonl(tempPath);
    if ((await fileFingerprint(filePath)) !== request.fingerprint) {
      throw new EditConflictError();
    }
    const backupPath = await createBackup(filePath, backupRoot);
    // Promote the renamed file, then remove the original. New file exists before old is gone.
    await fsp.rename(tempPath, newPath);
    await fsp.rm(filePath, { force: true });
    await pruneBackups(path.dirname(backupPath), 5);
    return {
      newSessionId: request.newId,
      newPath,
      fingerprint: await fileFingerprint(newPath)
    };
  } catch (error) {
    await fsp.rm(tempPath, { force: true }).catch(() => undefined);
    throw error;
  }
}
```

Then update the test-file import at the top of `server/editor.test.ts` to include the new function:

```typescript
import {
  deleteMessageBranch,
  EditConflictError,
  editMessageText,
  fileFingerprint,
  randomizeSessionId
} from "./editor.js";
```

- [ ] **Step 4: Run the test to verify it passes**

```bash
node node_modules/vitest/vitest.mjs run server/editor.test.ts
```

Expected: PASS — the new test plus all existing editor tests are green.

- [ ] **Step 5: Checkpoint — full suite**

```bash
node node_modules/vitest/vitest.mjs run
```

Expected: all test files pass (no regressions).

---

## Task 2: `randomizeSessionId` — stale fingerprint and collision guards

**Files:**
- Test: `server/editor.test.ts`
- (No new implementation expected — the Task 1 code should already satisfy these. If a test fails, fix `randomizeSessionId`.)

- [ ] **Step 1: Write the failing tests**

Add these two `it` blocks inside the `describe("randomizing a session id", ...)` block from Task 1.

```typescript
  it("rejects a stale fingerprint without touching the filesystem", async () => {
    const oldPath = path.join(root, `${oldId}.jsonl`);
    const fingerprint = await fileFingerprint(oldPath);
    // Claude changes the file after it was loaded.
    await fsp.appendFile(oldPath, `${JSON.stringify({ type: "system", content: "new" })}\n`);
    const before = await fsp.readFile(oldPath, "utf8");

    await expect(
      randomizeSessionId(oldPath, backups, { newId, fingerprint })
    ).rejects.toBeInstanceOf(EditConflictError);

    // Original untouched; no new file created.
    expect(await fsp.readFile(oldPath, "utf8")).toBe(before);
    await expect(fsp.access(path.join(root, `${newId}.jsonl`))).rejects.toBeTruthy();
  });

  it("refuses to overwrite an existing destination file", async () => {
    const oldPath = path.join(root, `${oldId}.jsonl`);
    // A file already occupies the target name.
    await fsp.writeFile(path.join(root, `${newId}.jsonl`), "PRE-EXISTING\n");

    await expect(
      randomizeSessionId(oldPath, backups, {
        newId,
        fingerprint: await fileFingerprint(oldPath)
      })
    ).rejects.toBeTruthy();

    // The original still exists and the pre-existing destination is unchanged.
    await expect(fsp.access(oldPath)).resolves.toBeUndefined();
    expect(await fsp.readFile(path.join(root, `${newId}.jsonl`), "utf8")).toBe("PRE-EXISTING\n");
  });
```

- [ ] **Step 2: Run the tests**

```bash
node node_modules/vitest/vitest.mjs run server/editor.test.ts
```

Expected: PASS. The `wx` flag on the temp write makes the collision case fail before any destructive step; the fingerprint guard handles staleness. If either fails, fix `randomizeSessionId` (do not weaken the test).

- [ ] **Step 3: Checkpoint — full suite**

```bash
node node_modules/vitest/vitest.mjs run
```

Expected: all green.

---

## Task 3: Public index method to drop a session by path

**Files:**
- Modify: `server/indexer.ts`

- [ ] **Step 1: Add a public `removeSessionByPath` method**

In `server/indexer.ts`, the class has a `private removeSession(relativePath)` used by `refreshAll`. Add a public wrapper so the route can drop the old path's rows after a rename. Insert this method right after the `search(...)` method (before the `private removeSession` declaration):

```typescript
  removeSessionByPath(relativePath: string): void {
    this.removeSession(relativePath);
  }
```

- [ ] **Step 2: Verify it compiles**

```bash
export NVM_DIR="$HOME/.nvm"; . "$NVM_DIR/nvm.sh"; nvm use 24
npx tsc -p tsconfig.server.json --noEmit
```

Expected: no type errors. (If `npx tsc` hits a permission error, run `chmod +x node_modules/.bin/*` first.)

---

## Task 4: `POST /api/session/randomize-id` route

**Files:**
- Modify: `server/app.ts`

- [ ] **Step 1: Add the route**

In `server/app.ts`, add the import for `randomizeSessionId` to the existing `./editor.js` import block (which already imports `deleteMessageBranch`, `EditConflictError`, `editMessageText`, `fileFingerprint`):

```typescript
import {
  deleteMessageBranch,
  EditConflictError,
  editMessageText,
  fileFingerprint,
  randomizeSessionId
} from "./editor.js";
```

Add `import crypto from "node:crypto";` at the top with the other node imports.

Then add this route handler immediately after the `DELETE "/api/session/message"` handler closes (before the `if (options.clientRoot)` block):

```typescript
  app.post<{
    Body: { sessionPath?: string; fingerprint?: string };
  }>("/api/session/randomize-id", async (request, reply) => {
    const body = request.body ?? {};
    if (typeof body.sessionPath !== "string" || typeof body.fingerprint !== "string") {
      return reply.code(400).send({ error: "The randomize request is incomplete." });
    }
    const oldFullPath = await resolveSessionPath(config.historyRoot, body.sessionPath);
    const oldRelativePath = toSessionRelativePath(config.historyRoot, oldFullPath);
    const newId = crypto.randomUUID();
    const result = await randomizeSessionId(oldFullPath, path.join(config.dataRoot, "backups"), {
      newId,
      fingerprint: body.fingerprint
    });
    index.removeSessionByPath(oldRelativePath);
    await index.refreshFile(result.newPath, true);
    return {
      newSessionId: result.newSessionId,
      newPath: toSessionRelativePath(config.historyRoot, result.newPath),
      fingerprint: result.fingerprint
    };
  });
```

Add the `toSessionRelativePath` import. The file currently imports `resolveSessionPath, UnsafePathError` from `./paths.js`; change it to:

```typescript
import { resolveSessionPath, toSessionRelativePath, UnsafePathError } from "./paths.js";
```

- [ ] **Step 2: Build the server and verify it compiles**

```bash
export NVM_DIR="$HOME/.nvm"; . "$NVM_DIR/nvm.sh"; nvm use 24
npx tsc -p tsconfig.server.json --noEmit
```

Expected: no type errors.

- [ ] **Step 3: Smoke-test the route against a throwaway copy**

Build, start the server, and exercise the endpoint on a **copy** of a real session so we don't disturb originals. (The route operates on whatever `CLAUDE_HISTORY_ROOT` points to; here we point it at a temp dir.)

```bash
npm run build
TMPROOT=$(mktemp -d)
mkdir -p "$TMPROOT/test-project"
# copy one small real session in (or craft a minimal one)
SRC=$(find "$HOME/.claude/projects" -name '*.jsonl' | head -1)
OLDID=$(basename "$SRC" .jsonl)
cp "$SRC" "$TMPROOT/test-project/$OLDID.jsonl"
CLAUDE_HISTORY_ROOT="$TMPROOT" CLAUDE_HISTORY_EDITOR_DATA="$TMPROOT/.data" PORT=4319 node dist-server/index.js >/tmp/randomize-smoke.log 2>&1 &
SRV=$!
sleep 2
SP="test-project/$OLDID.jsonl"
FP=$(curl -sS "http://127.0.0.1:4319/api/session?path=$(python3 -c 'import urllib.parse,sys;print(urllib.parse.quote(sys.argv[1]))' "$SP")&offset=0&limit=1" | python3 -c 'import json,sys;print(json.load(sys.stdin)["fingerprint"])')
echo "old fingerprint: $FP"
curl -sS -X POST http://127.0.0.1:4319/api/session/randomize-id -H 'content-type: application/json' \
  -d "{\"sessionPath\":\"$SP\",\"fingerprint\":\"$FP\"}"
echo
echo "--- files after ---"; ls "$TMPROOT/test-project"
kill $SRV
rm -rf "$TMPROOT"
```

Expected: JSON response `{"newSessionId":"<uuid>","newPath":"test-project/<uuid>.jsonl","fingerprint":"..."}`; the directory now contains `<uuid>.jsonl` and **not** the old name.

---

## Task 5: Client API method

**Files:**
- Modify: `client/src/api.ts`

- [ ] **Step 1: Add `randomizeId` to the `api` object**

In `client/src/api.ts`, add this method to the `api` object (after `deleteMessage`):

```typescript
  randomizeId: (body: { sessionPath: string; fingerprint: string }) =>
    request<{ newSessionId: string; newPath: string; fingerprint: string }>(
      "/api/session/randomize-id",
      { method: "POST", body: JSON.stringify(body) }
    )
```

(Remember to add a comma after the previous `deleteMessage` entry.)

- [ ] **Step 2: Verify the client type-checks**

```bash
export NVM_DIR="$HOME/.nvm"; . "$NVM_DIR/nvm.sh"; nvm use 24
npx tsc -p tsconfig.json --noEmit
```

Expected: no type errors.

---

## Task 6: "Randomize ID" button in the session header

**Files:**
- Modify: `client/src/App.tsx`

- [ ] **Step 1: Add the handler**

In `client/src/App.tsx`, add this function inside the `App` component, right after the `deleteMessage` function (around line 196, before the `return (`):

```typescript
  async function randomizeId() {
    if (!selectedPath || !page) return;
    const confirmed = window.confirm(
      "Replace this session's id with a new random one?\n\n" +
        "Every occurrence of the id is rewritten and the file is renamed. " +
        "This cannot be undone from the app, but a compressed backup will be created."
    );
    if (!confirmed) return;
    setError(undefined);
    try {
      const result = await api.randomizeId({
        sessionPath: selectedPath,
        fingerprint: page.fingerprint
      });
      await loadLibrary(selectedProject);
      setNotice(`Session id changed to ${result.newSessionId}. A compressed backup was created.`);
      chooseSession(result.newPath);
    } catch (caught) {
      setError((caught as Error).message);
    }
  }
```

- [ ] **Step 2: Add the button to the header**

In the session header (the `<header className="session-header">` block, around line 332), there is a single `Reload` button. Replace that button with the Reload button plus a Randomize ID button:

Find:

```tsx
              <button className="secondary-button" onClick={() => void loadSession(selectedPath, offset)}>
                Reload
              </button>
```

Replace with:

```tsx
              <div className="header-actions">
                <button className="secondary-button" onClick={() => void randomizeId()}>
                  Randomize ID
                </button>
                <button className="secondary-button" onClick={() => void loadSession(selectedPath, offset)}>
                  Reload
                </button>
              </div>
```

- [ ] **Step 3: Verify the client type-checks**

```bash
export NVM_DIR="$HOME/.nvm"; . "$NVM_DIR/nvm.sh"; nvm use 24
npx tsc -p tsconfig.json --noEmit
```

Expected: no type errors.

- [ ] **Step 4: Build**

```bash
npm run build
```

Expected: client + server build succeeds.

---

## Task 7: End-to-end browser verification

**Files:** none (manual verification)

- [ ] **Step 1: Start the server on a throwaway copy of history**

To avoid renaming a real session, run against a temp history root containing a copied session (same setup as Task 4 Step 3, but leave the server running):

```bash
export NVM_DIR="$HOME/.nvm"; . "$NVM_DIR/nvm.sh"; nvm use 24
TMPROOT=$(mktemp -d); mkdir -p "$TMPROOT/test-project"
SRC=$(find "$HOME/.claude/projects" -name '*.jsonl' | head -1)
OLDID=$(basename "$SRC" .jsonl)
cp "$SRC" "$TMPROOT/test-project/$OLDID.jsonl"
CLAUDE_HISTORY_ROOT="$TMPROOT" CLAUDE_HISTORY_EDITOR_DATA="$TMPROOT/.data" PORT=4317 node dist-server/index.js &
```

- [ ] **Step 2: Drive the UI**

Open `http://127.0.0.1:4317`, select the session, click **Randomize ID**, accept the confirm. Verify:
- The view reloads and the session header shows the conversation under the new id (the sidebar entry updates).
- On disk, `ls "$TMPROOT/test-project"` shows `<newUuid>.jsonl` and the old name is gone.
- Search still finds the session (the index was re-keyed).
- A backup exists under `"$TMPROOT/.data/backups"`.

- [ ] **Step 3: Clean up**

```bash
rm -rf "$TMPROOT"
```

---

## Self-Review Notes

- **Spec coverage:** field rewrite + embedded rewrite (Task 1), filename rename (Task 1), index re-key (Tasks 3+4), UUIDv4 generation (Task 4 route), header button (Task 6), fingerprint/collision/validation guards (Tasks 1–2). All spec sections map to a task.
- **Type consistency:** `randomizeSessionId(filePath, backupRoot, { newId, fingerprint })` returns `{ newSessionId, newPath, fingerprint }` — used identically in editor, route, api, and App. `removeSessionByPath` name is consistent across indexer + app.
- **No git:** commit steps replaced with suite/compile checkpoints, since the project is not under version control.
