import crypto from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import zlib from "node:zlib";
import { parseJsonLine, setTextAtPath, validateJsonl } from "./jsonl.js";

export class EditConflictError extends Error {
  constructor(message = "The session changed after it was loaded. Reload it before saving.") {
    super(message);
    this.name = "EditConflictError";
  }
}

export type EditRequest = {
  sessionPath: string;
  uuid: string;
  contentPath: string;
  originalText: string;
  newText: string;
  fingerprint: string;
};

export type DeleteMessageRequest = {
  sessionPath: string;
  uuid: string;
  fingerprint: string;
};

export async function fileFingerprint(filePath: string): Promise<string> {
  const stat = await fsp.stat(filePath, { bigint: true });
  return `${stat.size.toString()}:${stat.mtimeNs.toString()}`;
}

export async function editMessageText(
  filePath: string,
  backupRoot: string,
  request: Omit<EditRequest, "sessionPath">
): Promise<{ fingerprint: string; backupPath: string }> {
  if ((await fileFingerprint(filePath)) !== request.fingerprint) {
    throw new EditConflictError();
  }

  const source = await fsp.readFile(filePath);
  const replacement = replaceTargetLine(source, request);
  const stat = await fsp.stat(filePath);
  const tempPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;

  try {
    await fsp.writeFile(tempPath, replacement, { flag: "wx", mode: stat.mode });
    await validateJsonl(tempPath);
    if ((await fileFingerprint(filePath)) !== request.fingerprint) {
      throw new EditConflictError();
    }
    const backupPath = await createBackup(filePath, backupRoot);
    await replaceValidatedFile(tempPath, filePath);
    await pruneBackups(path.dirname(backupPath), 5);
    return { fingerprint: await fileFingerprint(filePath), backupPath };
  } catch (error) {
    await fsp.rm(tempPath, { force: true }).catch(() => undefined);
    throw error;
  }
}

export async function deleteMessageBranch(
  filePath: string,
  backupRoot: string,
  request: Omit<DeleteMessageRequest, "sessionPath">
): Promise<{ fingerprint: string; backupPath: string; deletedRecords: number }> {
  if ((await fileFingerprint(filePath)) !== request.fingerprint) {
    throw new EditConflictError();
  }

  const source = await fsp.readFile(filePath);
  const { replacement, deletedRecords } = removeTargetBranch(source, request.uuid);
  const stat = await fsp.stat(filePath);
  const tempPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;

  try {
    await fsp.writeFile(tempPath, replacement, { flag: "wx", mode: stat.mode });
    await validateJsonl(tempPath);
    if ((await fileFingerprint(filePath)) !== request.fingerprint) {
      throw new EditConflictError();
    }
    const backupPath = await createBackup(filePath, backupRoot);
    await replaceValidatedFile(tempPath, filePath);
    await pruneBackups(path.dirname(backupPath), 5);
    return {
      fingerprint: await fileFingerprint(filePath),
      backupPath,
      deletedRecords
    };
  } catch (error) {
    await fsp.rm(tempPath, { force: true }).catch(() => undefined);
    throw error;
  }
}

async function pathExists(target: string): Promise<boolean> {
  try {
    await fsp.access(target);
    return true;
  } catch {
    return false;
  }
}

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
  if (await pathExists(newPath)) {
    throw new Error(`A session file named ${request.newId}.jsonl already exists.`);
  }
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

async function replaceValidatedFile(tempPath: string, filePath: string): Promise<void> {
  try {
    await fsp.rename(tempPath, filePath);
    return;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (process.platform !== "win32" || (code !== "EPERM" && code !== "EEXIST")) {
      throw error;
    }
  }

  // Windows cannot reliably rename over an existing file. Keep a rollback copy
  // beside it so a failed promotion can restore the original immediately.
  const rollbackPath = `${filePath}.${process.pid}.${Date.now()}.rollback`;
  await fsp.rename(filePath, rollbackPath);
  try {
    await fsp.rename(tempPath, filePath);
  } catch (error) {
    await fsp.rename(rollbackPath, filePath).catch(() => undefined);
    throw error;
  }
  await fsp.rm(rollbackPath, { force: true });
}

function replaceTargetLine(
  source: Buffer,
  request: Omit<EditRequest, "sessionPath">
): Buffer {
  const parts: Buffer[] = [];
  let start = 0;
  let matches = 0;

  for (let cursor = 0; cursor <= source.length; cursor += 1) {
    if (cursor !== source.length && source[cursor] !== 0x0a) continue;
    const hasNewline = cursor < source.length;
    const contentEnd = hasNewline && cursor > start && source[cursor - 1] === 0x0d
      ? cursor - 1
      : cursor;
    const newline = hasNewline
      ? source.subarray(contentEnd, cursor + 1)
      : Buffer.alloc(0);
    const rawLine = source.subarray(start, contentEnd);
    let outputLine = rawLine;

    if (rawLine.length > 0) {
      const parsed = parseJsonLine(rawLine.toString("utf8"));
      if (!parsed.value) {
        throw new Error(`Cannot edit a session containing invalid JSON: ${parsed.error}`);
      }
      if (parsed.value.uuid === request.uuid) {
        matches += 1;
        setTextAtPath(
          parsed.value,
          request.contentPath,
          request.originalText,
          request.newText
        );
        outputLine = Buffer.from(JSON.stringify(parsed.value), "utf8");
      }
    }

    parts.push(outputLine, newline);
    start = cursor + 1;
  }

  if (matches === 0) throw new Error("The selected message UUID was not found.");
  if (matches > 1) throw new Error("The selected message UUID is not unique.");
  return Buffer.concat(parts);
}

type PhysicalLine = {
  rawLine: Buffer;
  newline: Buffer;
  value?: Record<string, unknown>;
};

function parsePhysicalLines(source: Buffer): PhysicalLine[] {
  const lines: PhysicalLine[] = [];
  let start = 0;

  for (let cursor = 0; cursor <= source.length; cursor += 1) {
    if (cursor !== source.length && source[cursor] !== 0x0a) continue;
    const hasNewline = cursor < source.length;
    const contentEnd = hasNewline && cursor > start && source[cursor - 1] === 0x0d
      ? cursor - 1
      : cursor;
    const newline = hasNewline
      ? source.subarray(contentEnd, cursor + 1)
      : Buffer.alloc(0);
    const rawLine = source.subarray(start, contentEnd);
    let value: Record<string, unknown> | undefined;

    if (rawLine.length > 0) {
      const parsed = parseJsonLine(rawLine.toString("utf8"));
      if (!parsed.value) {
        throw new Error(`Cannot delete from a session containing invalid JSON: ${parsed.error}`);
      }
      value = parsed.value;
    }

    lines.push({ rawLine, newline, value });
    start = cursor + 1;
  }

  return lines;
}

function removeTargetBranch(
  source: Buffer,
  targetUuid: string
): { replacement: Buffer; deletedRecords: number } {
  const lines = parsePhysicalLines(source);
  const targets = lines.filter((line) => line.value?.uuid === targetUuid);
  if (targets.length === 0) throw new Error("The selected message UUID was not found.");
  if (targets.length > 1) throw new Error("The selected message UUID is not unique.");

  const target = targets[0].value!;
  const targetMessage = target.message as Record<string, unknown> | undefined;
  const targetMessageId =
    targetMessage?.role === "assistant" && typeof targetMessage.id === "string"
      ? targetMessage.id
      : undefined;
  const parentByUuid = new Map<string, string | undefined>();
  const deletedUuids = new Set<string>([targetUuid]);

  for (const line of lines) {
    const value = line.value;
    if (!value || typeof value.uuid !== "string") continue;
    parentByUuid.set(
      value.uuid,
      typeof value.parentUuid === "string" ? value.parentUuid : undefined
    );
    const message = value.message as Record<string, unknown> | undefined;
    if (
      targetMessageId &&
      message?.role === "assistant" &&
      message.id === targetMessageId
    ) {
      deletedUuids.add(value.uuid);
    }
  }

  let changed = true;
  while (changed) {
    changed = false;
    for (const line of lines) {
      const value = line.value;
      if (
        value &&
        typeof value.uuid === "string" &&
        typeof value.parentUuid === "string" &&
        deletedUuids.has(value.parentUuid) &&
        !deletedUuids.has(value.uuid)
      ) {
        deletedUuids.add(value.uuid);
        changed = true;
      }
    }
  }

  function nearestRetainedAncestor(uuid: string): string | undefined {
    const seen = new Set<string>();
    let current: string | undefined = uuid;
    while (current && deletedUuids.has(current)) {
      if (seen.has(current)) return undefined;
      seen.add(current);
      current = parentByUuid.get(current);
    }
    return current;
  }

  const parts: Buffer[] = [];
  let deletedRecords = 0;

  for (const line of lines) {
    const value = line.value;
    if (!value) {
      parts.push(line.rawLine, line.newline);
      continue;
    }

    const uuid = typeof value.uuid === "string" ? value.uuid : undefined;
    const parentUuid =
      typeof value.parentUuid === "string" ? value.parentUuid : undefined;
    const snapshotMessageId =
      value.type === "file-history-snapshot" && typeof value.messageId === "string"
        ? value.messageId
        : undefined;

    if (
      (uuid && deletedUuids.has(uuid)) ||
      (parentUuid && deletedUuids.has(parentUuid)) ||
      (snapshotMessageId && deletedUuids.has(snapshotMessageId))
    ) {
      deletedRecords += 1;
      continue;
    }

    if (
      value.type === "last-prompt" &&
      typeof value.leafUuid === "string" &&
      deletedUuids.has(value.leafUuid)
    ) {
      const leafUuid = nearestRetainedAncestor(value.leafUuid);
      if (!leafUuid) {
        deletedRecords += 1;
        continue;
      }
      parts.push(Buffer.from(JSON.stringify({ ...value, leafUuid }), "utf8"), line.newline);
      continue;
    }

    parts.push(line.rawLine, line.newline);
  }

  return { replacement: Buffer.concat(parts), deletedRecords };
}

async function createBackup(filePath: string, backupRoot: string): Promise<string> {
  const key = crypto.createHash("sha256").update(filePath).digest("hex").slice(0, 20);
  const directory = path.join(backupRoot, key);
  await fsp.mkdir(directory, { recursive: true });
  const stamp = new Date().toISOString().replaceAll(":", "-").replaceAll(".", "-");
  const backupPath = path.join(directory, `${stamp}-${path.basename(filePath)}.gz`);
  await pipeline(fs.createReadStream(filePath), zlib.createGzip(), fs.createWriteStream(backupPath));
  return backupPath;
}

async function pruneBackups(directory: string, keep: number): Promise<void> {
  const entries = (await fsp.readdir(directory, { withFileTypes: true }))
    .filter((entry) => entry.isFile() && entry.name.endsWith(".gz"))
    .map((entry) => entry.name)
    .sort()
    .reverse();
  await Promise.all(entries.slice(keep).map((name) => fsp.rm(path.join(directory, name))));
}
