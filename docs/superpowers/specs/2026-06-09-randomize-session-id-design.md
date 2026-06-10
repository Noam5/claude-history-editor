# Randomize Session ID — Design

## Summary

Add a feature that replaces a session's id with a freshly generated random
UUIDv4, rewriting **every** occurrence of the old id throughout the session
file, renaming the `.jsonl` file to match, and re-keying the search index.
Triggered by a "Randomize ID" button in the session header.

## Motivation

A user wants to give a session a new identity. In Claude Code's history, a
session's id appears in three distinct places, all of which must stay
consistent:

1. The structured `sessionId` field — present on every record, across all
   observed record types (`assistant`, `user`, `system`, `attachment`,
   `permission-mode`, `ai-title`, `last-prompt`, `mode`, `queue-operation`,
   `agent-name`, `custom-title`).
2. The filename — `<sessionId>.jsonl`. The SQLite index derives its
   `session_id` column from the filename basename
   (`indexer.ts` `refreshFile`), **not** from the field, so the filename is
   authoritative for the index.
3. Embedded as a substring inside content — bash commands
   (`message.content[].input.command`), tool-output paths
   (`toolUseResult.outputFile`, `persistedOutputPath`, `originalFile`),
   captured text, and attachments.

## Decisions (from brainstorming)

- **Replace scope:** Global — every occurrence of the old id string anywhere
  in the file, not just the structured field.
- **Filename:** Rename `<oldId>.jsonl` → `<newId>.jsonl` and re-key the index.
- **New id format:** Random UUIDv4 via `crypto.randomUUID()` (matches the shape
  of real Claude Code session ids; 36 chars; negligible collision chance).
- **Trigger:** A "Randomize ID" button in the session header, beside "Reload".

## Architecture

### Server: `randomizeSessionId` (in `server/editor.ts`)

A transactional operation that mirrors the existing edit/delete safety
pipeline. Randomness is injected by the caller (the route), so the transform
is deterministic and unit-testable.

Signature (shape):

```
randomizeSessionId(
  filePath: string,         // resolved absolute path to <oldId>.jsonl
  backupRoot: string,
  request: { newId: string; fingerprint: string }
): Promise<{ newSessionId: string; newPath: string; fingerprint: string }>
```

Steps:

1. **Fingerprint guard** — `fileFingerprint(filePath)` must equal
   `request.fingerprint`; else throw `EditConflictError` (409). Prevents
   clobbering a file Claude changed since it was loaded.
2. **Derive `oldId`** from the filename basename (authoritative for the index).
3. **Global replace** — read the file as a buffer/utf8 string and
   `replaceAll(oldId, newId)`. Both ids are 36-char UUIDs, so byte length is
   unchanged and all occurrences (field + embedded) flip.
4. **Temp write** — write the rewritten content to
   `<dir>/<newId>.jsonl.<pid>.<ts>.tmp` in the **same directory** as the
   original (so the step-8 rename is an atomic same-filesystem move), then
   `validateJsonl(temp)` to guarantee no broken JSON is produced.
5. **Collision guard** — the destination `<newId>.jsonl` is created with the
   `wx` flag; if it already exists, fail rather than overwrite.
6. **Re-check fingerprint** on the original; throw `EditConflictError` if it
   changed during the operation.
7. **Backup** — gzip the original via the existing `createBackup`, then
   `pruneBackups`.
8. **Atomic promote** — rename temp → `<newId>.jsonl` (new file exists before
   the old one is removed), then delete `<oldId>.jsonl`.
9. **Return** the new id, new relative path, and the new file's fingerprint.

### Index re-keying

After a successful rewrite, the route calls:

- a new **public** `HistoryIndex.removeSessionByPath(relativeOldPath)` (today
  only a private `removeSession` exists), then
- `index.refreshFile(newFullPath, true)` to index the renamed file.

### Route: `POST /api/session/randomize-id`

- Body: `{ sessionPath: string, fingerprint: string }`.
- Validates body fields are strings (same guard style as the edit/delete
  routes); resolves the path via `resolveSessionPath` (rejects traversal /
  non-`.jsonl` with `UnsafePathError` → 400).
- Generates `newId = crypto.randomUUID()`.
- Calls `randomizeSessionId`, then re-keys the index.
- Responds `{ newSessionId, newPath, fingerprint }`.

### Client

- `api.ts`: add `randomizeId({ sessionPath, fingerprint })`.
- `App.tsx`: a **Randomize ID** button in the session header next to
  **Reload**. On click: `window.confirm` (destructive-action warning, like
  delete) → call the API → on success, select the returned `newPath` so the
  view reloads on the renamed session, then `loadLibrary` to refresh the
  sidebar. Surface `EditConflictError` via the existing error toast.

## Error Handling

- Stale file → `EditConflictError` → 409 (existing handler).
- Bad/unsafe path → `UnsafePathError` → 400 (existing handler).
- Destination already exists → operation fails before any destructive step
  (temp + `wx`), original left intact.
- Invalid JSON produced (should be impossible from a pure string replace, but
  guarded) → `validateJsonl` throws, temp removed, original untouched.

## Testing (TDD)

Unit test `randomizeSessionId` against a temp-dir fixture whose JSONL embeds
the id in multiple places (structured field + a `toolUseResult.originalFile`
substring):

- New file `<newId>.jsonl` exists; old file gone.
- Zero occurrences of `oldId` remain anywhere in the new file.
- `newId` appears in the `sessionId` field of every record AND in the embedded
  substring location.
- Output is valid JSON (line count unchanged).
- A gzip backup of the original was created.
- Stale fingerprint → throws `EditConflictError`, no filesystem change.

Then rebuild and verify end-to-end in the browser: click Randomize ID on a
real session, confirm the file renames, the view reloads under the new id, the
sidebar updates, and search still finds the session.

## Risks / Trade-offs

- **Destructive.** The old path is renamed and the old file deleted. Mitigated
  by the gzip backup, but the original filename no longer exists.
- **Historical references get rewritten.** Global replace changes mentions like
  `originSessionId: <oldId>` baked into captured tool output, even though a
  file under the old id may still exist elsewhere on disk. This is the explicit
  consequence of the "every occurrence" choice and is irreversible from the app.
- **Substring safety.** A v4 UUID is specific enough that accidental collisions
  with unrelated text are effectively impossible.

## Out of Scope

- Updating references to this session id that live in *other* session files or
  outside the history root.
- Undo from within the app (recovery is via the gzip backup).
