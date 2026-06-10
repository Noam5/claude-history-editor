import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import readline from "node:readline";
import { DatabaseSync } from "node:sqlite";
import { extractEditableText, parseJsonLine } from "./jsonl.js";
import { toSessionRelativePath } from "./paths.js";
import type { SessionSummary } from "./types.js";

type SessionRow = SessionSummary & { mtimeNs: string };

export class HistoryIndex {
  private readonly db: DatabaseSync;

  constructor(
    private readonly historyRoot: string,
    databasePath: string
  ) {
    fs.mkdirSync(path.dirname(databasePath), { recursive: true });
    this.db = new DatabaseSync(databasePath);
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA synchronous = NORMAL;
      CREATE TABLE IF NOT EXISTS sessions (
        session_path TEXT PRIMARY KEY,
        project TEXT NOT NULL,
        session_id TEXT NOT NULL,
        size INTEGER NOT NULL,
        mtime_ns TEXT NOT NULL,
        mtime_ms REAL NOT NULL,
        message_count INTEGER NOT NULL,
        first_timestamp TEXT,
        last_timestamp TEXT,
        preview TEXT,
        indexed_at TEXT NOT NULL
      );
      CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5(
        session_path UNINDEXED,
        uuid UNINDEXED,
        content_path UNINDEXED,
        line UNINDEXED,
        project,
        role,
        timestamp UNINDEXED,
        text,
        tokenize = 'unicode61'
      );
    `);
  }

  close(): void {
    this.db.close();
  }

  async refreshAll(): Promise<{ indexed: number; unchanged: number; removed: number }> {
    await fsp.mkdir(this.historyRoot, { recursive: true });
    const files = await discoverSessionFiles(this.historyRoot);
    const existing = new Set(files.map((file) => toSessionRelativePath(this.historyRoot, file)));
    const known = this.db.prepare("SELECT session_path FROM sessions").all() as Array<{
      session_path: string;
    }>;
    let removed = 0;
    for (const row of known) {
      if (!existing.has(row.session_path)) {
        this.removeSession(row.session_path);
        removed += 1;
      }
    }

    let indexed = 0;
    let unchanged = 0;
    for (const file of files) {
      const changed = await this.refreshFile(file);
      if (changed) indexed += 1;
      else unchanged += 1;
    }
    return { indexed, unchanged, removed };
  }

  async refreshFile(fullPath: string, force = false): Promise<boolean> {
    const relativePath = toSessionRelativePath(this.historyRoot, fullPath);
    const stat = await fsp.stat(fullPath, { bigint: true });
    const known = this.db
      .prepare("SELECT size, mtime_ns FROM sessions WHERE session_path = ?")
      .get(relativePath) as { size: number; mtime_ns: string } | undefined;

    if (
      !force &&
      known &&
      Number(known.size) === Number(stat.size) &&
      known.mtime_ns === stat.mtimeNs.toString()
    ) {
      return false;
    }

    const project = relativePath.split("/")[0] ?? "unknown";
    const sessionId = path.basename(relativePath, ".jsonl");
    const stream = fs.createReadStream(fullPath, { encoding: "utf8" });
    const reader = readline.createInterface({ input: stream, crlfDelay: Infinity });
    const messages: Array<{
      uuid: string;
      contentPath: string;
      line: number;
      role: string;
      timestamp: string;
      text: string;
    }> = [];
    let line = 0;
    let firstTimestamp: string | undefined;
    let lastTimestamp: string | undefined;
    let preview: string | undefined;

    try {
      for await (const raw of reader) {
        line += 1;
        const parsed = parseJsonLine(raw);
        if (!parsed.value) continue;
        const record = parsed.value;
        const uuid = typeof record.uuid === "string" ? record.uuid : undefined;
        const timestamp = typeof record.timestamp === "string" ? record.timestamp : "";
        const message = record.message as Record<string, unknown> | undefined;
        const role = typeof message?.role === "string" ? message.role : "";
        for (const block of extractEditableText(record)) {
          if (!uuid) continue;
          messages.push({
            uuid,
            contentPath: block.path,
            line,
            role,
            timestamp,
            text: block.text
          });
          if (!preview && role === "user" && block.text.trim()) {
            preview = block.text.replace(/\s+/g, " ").slice(0, 180);
          }
        }
        if (timestamp) {
          firstTimestamp ??= timestamp;
          lastTimestamp = timestamp;
        }
      }
    } finally {
      reader.close();
      stream.destroy();
    }

    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db.prepare("DELETE FROM messages_fts WHERE session_path = ?").run(relativePath);
      const insertMessage = this.db.prepare(`
        INSERT INTO messages_fts
          (session_path, uuid, content_path, line, project, role, timestamp, text)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `);
      for (const message of messages) {
        insertMessage.run(
          relativePath,
          message.uuid,
          message.contentPath,
          message.line,
          project,
          message.role,
          message.timestamp,
          message.text
        );
      }
      this.db
        .prepare(`
          INSERT INTO sessions
            (session_path, project, session_id, size, mtime_ns, mtime_ms, message_count,
             first_timestamp, last_timestamp, preview, indexed_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(session_path) DO UPDATE SET
            project = excluded.project,
            session_id = excluded.session_id,
            size = excluded.size,
            mtime_ns = excluded.mtime_ns,
            mtime_ms = excluded.mtime_ms,
            message_count = excluded.message_count,
            first_timestamp = excluded.first_timestamp,
            last_timestamp = excluded.last_timestamp,
            preview = excluded.preview,
            indexed_at = excluded.indexed_at
        `)
        .run(
          relativePath,
          project,
          sessionId,
          Number(stat.size),
          stat.mtimeNs.toString(),
          Number(stat.mtimeMs),
          messages.length,
          firstTimestamp ?? null,
          lastTimestamp ?? null,
          preview ?? null,
          new Date().toISOString()
        );
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
    return true;
  }

  listProjects(): Array<{ project: string; sessions: number; messages: number; size: number }> {
    return this.db
      .prepare(`
        SELECT project, COUNT(*) AS sessions, SUM(message_count) AS messages, SUM(size) AS size
        FROM sessions
        GROUP BY project
        ORDER BY MAX(mtime_ms) DESC
      `)
      .all() as Array<{ project: string; sessions: number; messages: number; size: number }>;
  }

  listSessions(project?: string): SessionSummary[] {
    const sql = `
      SELECT session_path AS path, project, session_id AS sessionId, size, mtime_ms AS mtimeMs,
             message_count AS messageCount, first_timestamp AS firstTimestamp,
             last_timestamp AS lastTimestamp, preview
      FROM sessions
      ${project ? "WHERE project = ?" : ""}
      ORDER BY mtime_ms DESC
    `;
    const rows = (project ? this.db.prepare(sql).all(project) : this.db.prepare(sql).all()) as SessionRow[];
    return rows;
  }

  search(query: string, limit = 50): Array<Record<string, unknown>> {
    const trimmedQuery = query.trim();
    if (!trimmedQuery) return [];
    const safeLimit = Math.min(Math.max(limit, 1), 200);
    const sessionMatches = this.db
      .prepare(`
        SELECT 'session' AS kind, session_path AS sessionPath, project, session_id AS sessionId,
               preview, last_timestamp AS timestamp
        FROM sessions
        WHERE instr(lower(session_id), lower(?)) > 0
        ORDER BY CASE WHEN lower(session_id) = lower(?) THEN 0 ELSE 1 END, mtime_ms DESC
        LIMIT ?
      `)
      .all(trimmedQuery, trimmedQuery, safeLimit) as Array<Record<string, unknown>>;

    const matchQuery = toFtsQuery(query);
    if (!matchQuery || sessionMatches.length >= safeLimit) return sessionMatches;
    const messageMatches = this.db
      .prepare(`
        SELECT 'message' AS kind, session_path AS sessionPath, uuid, content_path AS contentPath,
               line, project, role, timestamp, text,
               snippet(messages_fts, 7, '<mark>', '</mark>', '...', 24) AS snippet
        FROM messages_fts
        WHERE messages_fts MATCH ?
        ORDER BY rank
        LIMIT ?
      `)
      .all(matchQuery, safeLimit - sessionMatches.length) as Array<Record<string, unknown>>;
    return [...sessionMatches, ...messageMatches];
  }

  private removeSession(relativePath: string): void {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db.prepare("DELETE FROM messages_fts WHERE session_path = ?").run(relativePath);
      this.db.prepare("DELETE FROM sessions WHERE session_path = ?").run(relativePath);
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  removeSessionByPath(relativePath: string): void {
    this.removeSession(relativePath);
  }
}

export async function discoverSessionFiles(historyRoot: string): Promise<string[]> {
  const files: string[] = [];
  const projects = await fsp.readdir(historyRoot, { withFileTypes: true });
  for (const project of projects) {
    if (!project.isDirectory()) continue;
    const projectPath = path.join(historyRoot, project.name);
    const entries = await fsp.readdir(projectPath, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isFile() && entry.name.toLowerCase().endsWith(".jsonl")) {
        files.push(path.join(projectPath, entry.name));
      }
    }
  }
  return files;
}

function toFtsQuery(query: string): string {
  return query
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .map((token) => `"${token.replaceAll('"', '""')}"*`)
    .join(" AND ");
}
