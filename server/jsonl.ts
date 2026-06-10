import fs from "node:fs";
import readline from "node:readline";
import type { ConversationRecord, ReadOnlyBlock, TextBlock } from "./types.js";

export type ParsedLine = {
  raw: string;
  value?: Record<string, unknown>;
  error?: string;
};

export function parseJsonLine(raw: string): ParsedLine {
  try {
    const value = JSON.parse(raw) as Record<string, unknown>;
    return { raw, value };
  } catch (error) {
    return { raw, error: error instanceof Error ? error.message : String(error) };
  }
}

function summarize(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

export function extractEditableText(record: Record<string, unknown>): TextBlock[] {
  const uuid = typeof record.uuid === "string" ? record.uuid : undefined;
  const message = record.message as Record<string, unknown> | undefined;
  const role = typeof message?.role === "string" ? message.role : undefined;

  if (!uuid || (role !== "user" && role !== "assistant")) {
    return [];
  }

  const content = message?.content;
  if (typeof content === "string") {
    return [{ path: "message.content", text: content }];
  }
  if (!Array.isArray(content)) {
    return [];
  }

  const blocks: TextBlock[] = [];
  content.forEach((block, index) => {
    if (
      block &&
      typeof block === "object" &&
      (block as Record<string, unknown>).type === "text" &&
      typeof (block as Record<string, unknown>).text === "string"
    ) {
      blocks.push({
        path: `message.content[${index}].text`,
        text: (block as Record<string, unknown>).text as string
      });
    }
  });
  return blocks;
}

export function extractReadOnlyBlocks(record: Record<string, unknown>): ReadOnlyBlock[] {
  const message = record.message as Record<string, unknown> | undefined;
  const content = message?.content;
  const blocks: ReadOnlyBlock[] = [];

  if (Array.isArray(content)) {
    content.forEach((block) => {
      if (!block || typeof block !== "object") {
        blocks.push({ type: "content", summary: summarize(block) });
        return;
      }
      const object = block as Record<string, unknown>;
      if (object.type !== "text") {
        blocks.push({
          type: typeof object.type === "string" ? object.type : "content",
          summary: summarize(
            object.type === "thinking"
              ? object.thinking
              : object.type === "tool_result"
                ? object.content
                : object
          )
        });
      }
    });
  }

  if (!message) {
    blocks.push({
      type: typeof record.type === "string" ? record.type : "metadata",
      summary: summarize(record)
    });
  }
  return blocks;
}

export function toConversationRecord(
  record: Record<string, unknown>,
  line: number
): ConversationRecord {
  const message = record.message as Record<string, unknown> | undefined;
  return {
    line,
    type: typeof record.type === "string" ? record.type : "unknown",
    uuid: typeof record.uuid === "string" ? record.uuid : undefined,
    parentUuid: typeof record.parentUuid === "string" ? record.parentUuid : undefined,
    role: typeof message?.role === "string" ? message.role : undefined,
    timestamp: typeof record.timestamp === "string" ? record.timestamp : undefined,
    editable: extractEditableText(record),
    readOnly: extractReadOnlyBlocks(record),
    orphaned: false
  };
}

// Collect every uuid in the file so a parentUuid can be checked against it.
// Orphan detection needs the whole file, not just the requested page window.
async function collectUuids(filePath: string): Promise<Set<string>> {
  const stream = fs.createReadStream(filePath, { encoding: "utf8" });
  const reader = readline.createInterface({ input: stream, crlfDelay: Infinity });
  const uuids = new Set<string>();
  try {
    for await (const raw of reader) {
      if (!raw.trim()) continue;
      const parsed = parseJsonLine(raw);
      const uuid = parsed.value?.uuid;
      if (typeof uuid === "string") uuids.add(uuid);
    }
  } finally {
    reader.close();
    stream.destroy();
  }
  return uuids;
}

export async function readJsonlPage(
  filePath: string,
  offset: number,
  limit: number
): Promise<{ records: ConversationRecord[]; nextOffset: number | null; total: number }> {
  const knownUuids = await collectUuids(filePath);
  const stream = fs.createReadStream(filePath, { encoding: "utf8" });
  const reader = readline.createInterface({ input: stream, crlfDelay: Infinity });
  const records: ConversationRecord[] = [];
  let line = 0;

  try {
    for await (const raw of reader) {
      line += 1;
      if (line <= offset) continue;
      if (records.length >= limit) continue;
      const parsed = parseJsonLine(raw);
      if (parsed.value) {
        const record = toConversationRecord(parsed.value, line);
        record.orphaned = Boolean(record.parentUuid && !knownUuids.has(record.parentUuid));
        records.push(record);
      } else {
        records.push({
          line,
          type: "malformed",
          editable: [],
          readOnly: [{ type: "malformed", summary: parsed.error ?? "Invalid JSON" }],
          orphaned: false
        });
      }
    }
  } finally {
    reader.close();
    stream.destroy();
  }

  const total = line;
  const nextOffset = offset + records.length < total ? offset + records.length : null;
  return { records, nextOffset, total };
}

export async function validateJsonl(filePath: string): Promise<void> {
  const stream = fs.createReadStream(filePath, { encoding: "utf8" });
  const reader = readline.createInterface({ input: stream, crlfDelay: Infinity });
  let line = 0;
  try {
    for await (const raw of reader) {
      line += 1;
      if (!raw.trim()) continue;
      const parsed = parseJsonLine(raw);
      if (!parsed.value) {
        throw new Error(`Invalid JSON on line ${line}: ${parsed.error}`);
      }
    }
  } finally {
    reader.close();
    stream.destroy();
  }
}

export function setTextAtPath(
  record: Record<string, unknown>,
  contentPath: string,
  expectedOriginal: string,
  replacement: string
): void {
  const message = record.message as Record<string, unknown> | undefined;
  if (!message) throw new Error("The selected record has no message.");

  if (contentPath === "message.content") {
    if (typeof message.content !== "string") {
      throw new Error("The selected content path is not editable text.");
    }
    if (message.content !== expectedOriginal) {
      throw new Error("The message text changed before it could be saved.");
    }
    message.content = replacement;
    return;
  }

  const match = /^message\.content\[(\d+)]\.text$/.exec(contentPath);
  const content = message.content;
  if (!match || !Array.isArray(content)) {
    throw new Error("The selected content path is not editable text.");
  }
  const index = Number(match[1]);
  const block = content[index] as Record<string, unknown> | undefined;
  if (!block || block.type !== "text" || typeof block.text !== "string") {
    throw new Error("The selected content path is not editable text.");
  }
  if (block.text !== expectedOriginal) {
    throw new Error("The message text changed before it could be saved.");
  }
  block.text = replacement;
}
