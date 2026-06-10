import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  extractEditableText,
  extractReadOnlyBlocks,
  parseJsonLine,
  readJsonlPage,
  setTextAtPath,
  toConversationRecord
} from "./jsonl.js";

describe("Claude JSONL parsing", () => {
  it("extracts editable string content from UUID-backed user messages", () => {
    expect(
      extractEditableText({
        uuid: "one",
        message: { role: "user", content: "hello" }
      })
    ).toEqual([{ path: "message.content", text: "hello" }]);
  });

  it("extracts text arrays and leaves structured content read-only", () => {
    const record = {
      uuid: "one",
      message: {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "private" },
          { type: "text", text: "visible" },
          { type: "tool_use", name: "Read", input: { file: "a.ts" } }
        ]
      }
    };
    expect(extractEditableText(record)).toEqual([
      { path: "message.content[1].text", text: "visible" }
    ]);
    expect(extractReadOnlyBlocks(record).map((block) => block.type)).toEqual([
      "thinking",
      "tool_use"
    ]);
  });

  it("exposes nested assistant message IDs as read-only record metadata", () => {
    const record = toConversationRecord(
      {
        type: "assistant",
        uuid: "local-uuid",
        message: { id: "msg_01Example", role: "assistant", content: "hello" }
      },
      12
    );

    expect(record.messageId).toBe("msg_01Example");
  });

  it("does not edit records without UUIDs or unsupported roles", () => {
    expect(extractEditableText({ message: { role: "user", content: "hello" } })).toEqual([]);
    expect(
      extractEditableText({ uuid: "one", message: { role: "system", content: "hello" } })
    ).toEqual([]);
  });

  it("reports malformed JSON", () => {
    expect(parseJsonLine("{bad").error).toBeTruthy();
  });

  it("shows the full record for system rows without a message, pretty-printed", () => {
    const record = {
      parentUuid: "aa3faaf4-e922-46fe-a8ac-c2c2a838727b",
      isSidechain: false,
      type: "system",
      subtype: "turn_duration",
      durationMs: 19653,
      note: "this value sits well past the old 140 character truncation boundary so it proves the full record is present"
    };
    const [block] = extractReadOnlyBlocks(record);
    expect(block.type).toBe("system");
    expect(block.summary).not.toContain("...");
    // The whole record round-trips, including fields past the old cutoff.
    expect(block.summary).toContain('"durationMs": 19653');
    expect(block.summary).toContain(record.note);
    // Pretty-printed: indented, multi-line JSON.
    expect(block.summary).toContain("\n  ");
    expect(JSON.parse(block.summary)).toEqual(record);
  });

  it("shows full thinking text without truncation", () => {
    const thinking = "x".repeat(400);
    const record = {
      uuid: "one",
      message: { role: "assistant", content: [{ type: "thinking", thinking }] }
    };
    const [block] = extractReadOnlyBlocks(record);
    expect(block.type).toBe("thinking");
    expect(block.summary).toBe(thinking);
  });

  it("shows full tool_use input as pretty-printed JSON", () => {
    const record = {
      uuid: "one",
      message: {
        role: "assistant",
        content: [
          {
            type: "tool_use",
            name: "Read",
            input: { file: "a.ts", reason: "y".repeat(200) }
          }
        ]
      }
    };
    const [block] = extractReadOnlyBlocks(record);
    expect(block.type).toBe("tool_use");
    expect(block.summary).not.toContain("...");
    expect(block.summary).toContain("y".repeat(200));
    expect(block.summary).toContain("\n  ");
  });

  it("updates only strict editable content paths", () => {
    const record = {
      message: { role: "assistant", content: [{ type: "text", text: "before" }] }
    };
    setTextAtPath(record, "message.content[0].text", "before", "after");
    expect(record.message.content[0].text).toBe("after");
    expect(() => setTextAtPath(record, "message.content[1].text", "", "x")).toThrow(
      /not editable/
    );
  });
});

describe("paginated session reads", () => {
  let dir: string;
  let file: string;

  beforeEach(async () => {
    dir = await fsp.mkdtemp(path.join(os.tmpdir(), "jsonl-page-"));
    file = path.join(dir, "session.jsonl");
    const lines = Array.from({ length: 7 }, (_, i) =>
      JSON.stringify({ uuid: `u${i}`, type: "system", subtype: "turn_duration" })
    );
    await fsp.writeFile(file, `${lines.join("\n")}\n`, "utf8");
  });

  afterEach(async () => {
    await fsp.rm(dir, { recursive: true, force: true });
  });

  it("flags records whose parentUuid points to a uuid that exists nowhere in the file", async () => {
    const lines = [
      JSON.stringify({ uuid: "root", message: { role: "user", content: "hi" } }),
      JSON.stringify({ uuid: "child", parentUuid: "root", message: { role: "assistant", content: "yo" } }),
      JSON.stringify({ uuid: "lost", parentUuid: "missing", message: { role: "user", content: "huh" } })
    ];
    const orphanFile = path.join(dir, "orphan.jsonl");
    await fsp.writeFile(orphanFile, `${lines.join("\n")}\n`, "utf8");

    const page = await readJsonlPage(orphanFile, 0, 10);
    const byUuid = Object.fromEntries(page.records.map((record) => [record.uuid, record]));
    // Root has no parent, child points at an existing uuid: neither is orphaned.
    expect(byUuid.root.orphaned).toBe(false);
    expect(byUuid.child.orphaned).toBe(false);
    // "lost" references a parent that was never written: orphaned.
    expect(byUuid.lost.orphaned).toBe(true);
    expect(byUuid.lost.parentUuid).toBe("missing");
  });

  it("reports the total physical record count regardless of page size", async () => {
    const firstPage = await readJsonlPage(file, 0, 3);
    expect(firstPage.records).toHaveLength(3);
    expect(firstPage.total).toBe(7);
    expect(firstPage.nextOffset).toBe(3);

    const lastPage = await readJsonlPage(file, 6, 3);
    expect(lastPage.records).toHaveLength(1);
    expect(lastPage.total).toBe(7);
    expect(lastPage.nextOffset).toBeNull();
  });
});
