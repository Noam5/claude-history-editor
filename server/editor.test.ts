import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  deleteMessageBranch,
  EditConflictError,
  editMessageText,
  fileFingerprint,
  generateMessageId,
  randomizeMessageId,
  randomizeSessionId
} from "./editor.js";

const first = JSON.stringify({ type: "system", content: "keep exactly" });
const target = JSON.stringify({
  type: "assistant",
  uuid: "target-uuid",
  timestamp: "2026-06-08T12:00:00.000Z",
  message: {
    role: "assistant",
    content: [
      { type: "thinking", thinking: "leave private" },
      { type: "text", text: "original sentence" }
    ]
  }
});
const last = JSON.stringify({ type: "last-prompt", sessionId: "session" });

describe("safe message editing", () => {
  let root: string;
  let session: string;
  let backups: string;

  beforeEach(async () => {
    root = await fsp.mkdtemp(path.join(os.tmpdir(), "history-editor-"));
    session = path.join(root, "session.jsonl");
    backups = path.join(root, "backups");
    await fsp.writeFile(session, `${first}\n${target}\n${last}\n`);
  });

  afterEach(async () => {
    await fsp.rm(root, { recursive: true, force: true });
  });

  it("changes only the selected JSONL line and creates a gzip backup", async () => {
    const before = await fsp.readFile(session, "utf8");
    await editMessageText(session, backups, {
      uuid: "target-uuid",
      contentPath: "message.content[1].text",
      originalText: "original sentence",
      newText: "edited sentence",
      fingerprint: await fileFingerprint(session)
    });
    const after = await fsp.readFile(session, "utf8");
    const beforeLines = before.split("\n");
    const afterLines = after.split("\n");
    expect(afterLines[0]).toBe(beforeLines[0]);
    expect(afterLines[2]).toBe(beforeLines[2]);
    expect(JSON.parse(afterLines[1]).message.content[1].text).toBe("edited sentence");
    const backupDirectories = await fsp.readdir(backups);
    const backupFiles = await fsp.readdir(path.join(backups, backupDirectories[0]));
    expect(backupFiles).toHaveLength(1);
    expect(backupFiles[0]).toMatch(/\.gz$/);
  });

  it("rejects stale fingerprints without changing the source", async () => {
    const fingerprint = await fileFingerprint(session);
    await fsp.appendFile(session, `${JSON.stringify({ type: "system", content: "new" })}\n`);
    const before = await fsp.readFile(session, "utf8");
    await expect(
      editMessageText(session, backups, {
        uuid: "target-uuid",
        contentPath: "message.content[1].text",
        originalText: "original sentence",
        newText: "edited",
        fingerprint
      })
    ).rejects.toBeInstanceOf(EditConflictError);
    expect(await fsp.readFile(session, "utf8")).toBe(before);
  });

  it("rejects missing UUIDs and malformed JSON without changing the source", async () => {
    const before = await fsp.readFile(session, "utf8");
    await expect(
      editMessageText(session, backups, {
        uuid: "missing",
        contentPath: "message.content",
        originalText: "",
        newText: "edited",
        fingerprint: await fileFingerprint(session)
      })
    ).rejects.toThrow(/not found/);
    expect(await fsp.readFile(session, "utf8")).toBe(before);

    await fsp.appendFile(session, "{bad json\n");
    const malformed = await fsp.readFile(session, "utf8");
    await expect(
      editMessageText(session, backups, {
        uuid: "target-uuid",
        contentPath: "message.content[1].text",
        originalText: "original sentence",
        newText: "edited",
        fingerprint: await fileFingerprint(session)
      })
    ).rejects.toThrow(/invalid JSON/);
    expect(await fsp.readFile(session, "utf8")).toBe(malformed);
  });

  it("retains only the latest five backups", async () => {
    let current = "original sentence";
    for (let index = 0; index < 6; index += 1) {
      const next = `edit ${index}`;
      await editMessageText(session, backups, {
        uuid: "target-uuid",
        contentPath: "message.content[1].text",
        originalText: current,
        newText: next,
        fingerprint: await fileFingerprint(session)
      });
      current = next;
      await new Promise((resolve) => setTimeout(resolve, 2));
    }
    const [directory] = await fsp.readdir(backups);
    expect(await fsp.readdir(path.join(backups, directory))).toHaveLength(5);
  });

  it("deletes a logical assistant message and all descendants", async () => {
    const graph = [
      JSON.stringify({ type: "system", content: "keep exactly" }),
      JSON.stringify({
        type: "user",
        uuid: "user-root",
        parentUuid: null,
        message: { role: "user", content: "keep this prompt" }
      }),
      JSON.stringify({
        type: "assistant",
        uuid: "assistant-thinking",
        parentUuid: "user-root",
        message: {
          id: "msg-one",
          role: "assistant",
          content: [{ type: "thinking", thinking: "", signature: "signed" }]
        }
      }),
      JSON.stringify({
        type: "assistant",
        uuid: "assistant-text",
        parentUuid: "assistant-thinking",
        message: {
          id: "msg-one",
          role: "assistant",
          content: [{ type: "text", text: "delete this answer" }]
        }
      }),
      JSON.stringify({
        type: "system",
        subtype: "turn_duration",
        uuid: "turn-duration",
        parentUuid: "assistant-text"
      }),
      JSON.stringify({
        type: "file-history-snapshot",
        messageId: "next-user",
        snapshot: {}
      }),
      JSON.stringify({
        type: "user",
        uuid: "next-user",
        parentUuid: "turn-duration",
        message: { role: "user", content: "delete this descendant" }
      }),
      JSON.stringify({
        type: "assistant",
        uuid: "next-assistant",
        parentUuid: "next-user",
        message: {
          id: "msg-two",
          role: "assistant",
          content: [{ type: "text", text: "delete this too" }]
        }
      }),
      JSON.stringify({ type: "last-prompt", leafUuid: "next-assistant", sessionId: "session" })
    ];
    await fsp.writeFile(session, `${graph.join("\n")}\n`);

    const result = await deleteMessageBranch(session, backups, {
      uuid: "assistant-text",
      fingerprint: await fileFingerprint(session)
    });
    const remaining = (await fsp.readFile(session, "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));

    expect(result.deletedRecords).toBe(6);
    expect(remaining).toHaveLength(3);
    expect(remaining.map((record) => record.uuid).filter(Boolean)).toEqual(["user-root"]);
    expect(remaining.at(-1)).toMatchObject({ type: "last-prompt", leafUuid: "user-root" });
    const [backupDirectory] = await fsp.readdir(backups);
    expect(await fsp.readdir(path.join(backups, backupDirectory))).toHaveLength(1);
  });

  it("deletes a user branch and repairs the last-prompt pointer", async () => {
    const graph = [
      JSON.stringify({
        type: "assistant",
        uuid: "previous",
        parentUuid: null,
        message: { id: "msg-zero", role: "assistant", content: [{ type: "text", text: "keep" }] }
      }),
      JSON.stringify({ type: "file-history-snapshot", messageId: "target-user", snapshot: {} }),
      JSON.stringify({
        type: "user",
        uuid: "target-user",
        parentUuid: "previous",
        message: { role: "user", content: "delete" }
      }),
      JSON.stringify({
        type: "assistant",
        uuid: "descendant",
        parentUuid: "target-user",
        message: { id: "msg-one", role: "assistant", content: [{ type: "text", text: "delete" }] }
      }),
      JSON.stringify({ type: "last-prompt", leafUuid: "descendant", sessionId: "session" })
    ];
    await fsp.writeFile(session, `${graph.join("\n")}\n`);

    const result = await deleteMessageBranch(session, backups, {
      uuid: "target-user",
      fingerprint: await fileFingerprint(session)
    });
    const remaining = (await fsp.readFile(session, "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));

    expect(result.deletedRecords).toBe(3);
    expect(remaining).toHaveLength(2);
    expect(remaining.at(-1)).toMatchObject({ type: "last-prompt", leafUuid: "previous" });
  });

  it("rejects a stale delete without changing the source", async () => {
    const fingerprint = await fileFingerprint(session);
    await fsp.appendFile(session, `${JSON.stringify({ type: "system", content: "new" })}\n`);
    const before = await fsp.readFile(session, "utf8");

    await expect(
      deleteMessageBranch(session, backups, {
        uuid: "target-uuid",
        fingerprint
      })
    ).rejects.toBeInstanceOf(EditConflictError);
    expect(await fsp.readFile(session, "utf8")).toBe(before);
  });
});

describe("randomizing a message id", () => {
  let root: string;
  let session: string;
  let backups: string;
  const oldMessageId = "msg_01AAAAAAAAAAAAAAAAAAAAAA";
  const newMessageId = "msg_01BBBBBBBBBBBBBBBBBBBBBB";

  function fixtureLines(): string {
    return [
      JSON.stringify({ type: "system", note: `Leave embedded ${oldMessageId} text unchanged.` }),
      JSON.stringify({
        type: "assistant",
        uuid: "thinking",
        message: {
          id: oldMessageId,
          role: "assistant",
          content: [{ type: "thinking", thinking: "private" }]
        }
      }),
      JSON.stringify({
        type: "assistant",
        uuid: "text",
        parentUuid: "thinking",
        message: {
          id: oldMessageId,
          role: "assistant",
          content: [{ type: "text", text: "visible" }]
        }
      }),
      JSON.stringify({
        type: "assistant",
        uuid: "other",
        message: {
          id: "msg_01CCCCCCCCCCCCCCCCCCCCCC",
          role: "assistant",
          content: [{ type: "text", text: "other" }]
        }
      })
    ].join("\n") + "\n";
  }

  beforeEach(async () => {
    root = await fsp.mkdtemp(path.join(os.tmpdir(), "randomize-message-id-"));
    session = path.join(root, "session.jsonl");
    backups = path.join(root, "backups");
    await fsp.writeFile(session, fixtureLines());
  });

  afterEach(async () => {
    await fsp.rm(root, { recursive: true, force: true });
  });

  it("generates canonical-looking random message IDs", () => {
    const generated = Array.from({ length: 20 }, () => generateMessageId());
    expect(generated.every((id) => /^msg_01[A-Za-z0-9]{22}$/.test(id))).toBe(true);
    expect(new Set(generated).size).toBe(generated.length);
  });

  it("updates every JSON record sharing the selected message id and creates a backup", async () => {
    const result = await randomizeMessageId(session, backups, {
      oldMessageId,
      newMessageId,
      fingerprint: await fileFingerprint(session)
    });
    const records = (await fsp.readFile(session, "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));

    expect(result.newMessageId).toBe(newMessageId);
    expect(result.updatedRecords).toBe(2);
    expect(records[0].note).toContain(oldMessageId);
    expect(records[1].message.id).toBe(newMessageId);
    expect(records[2].message.id).toBe(newMessageId);
    expect(records[3].message.id).toBe("msg_01CCCCCCCCCCCCCCCCCCCCCC");

    const [backupDirectory] = await fsp.readdir(backups);
    expect(await fsp.readdir(path.join(backups, backupDirectory))).toHaveLength(1);
  });

  it("rejects a stale fingerprint without changing the source", async () => {
    const fingerprint = await fileFingerprint(session);
    await fsp.appendFile(session, `${JSON.stringify({ type: "system", content: "new" })}\n`);
    const before = await fsp.readFile(session, "utf8");

    await expect(
      randomizeMessageId(session, backups, {
        oldMessageId,
        newMessageId,
        fingerprint
      })
    ).rejects.toBeInstanceOf(EditConflictError);
    expect(await fsp.readFile(session, "utf8")).toBe(before);
  });

  it("refuses to collide with another message id", async () => {
    const before = await fsp.readFile(session, "utf8");
    await expect(
      randomizeMessageId(session, backups, {
        oldMessageId,
        newMessageId: "msg_01CCCCCCCCCCCCCCCCCCCCCC",
        fingerprint: await fileFingerprint(session)
      })
    ).rejects.toThrow(/already exists/);
    expect(await fsp.readFile(session, "utf8")).toBe(before);
  });
});

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
});
