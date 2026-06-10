import crypto from "node:crypto";
import fsp from "node:fs/promises";
import path from "node:path";
import fastify, { type FastifyInstance } from "fastify";
import fastifyStatic from "@fastify/static";
import { getConfig, type AppConfig } from "./config.js";
import {
  deleteMessageBranch,
  EditConflictError,
  editMessageText,
  fileFingerprint,
  generateMessageId,
  randomizeMessageId,
  randomizeSessionId
} from "./editor.js";
import { HistoryIndex } from "./indexer.js";
import { readJsonlPage } from "./jsonl.js";
import { resolveSessionPath, toSessionRelativePath, UnsafePathError } from "./paths.js";

type BuildOptions = {
  config?: Partial<AppConfig>;
  refreshOnStart?: boolean;
  clientRoot?: string;
  logger?: boolean;
};

export async function buildApp(options: BuildOptions = {}): Promise<FastifyInstance> {
  const config = getConfig(options.config);
  await fsp.mkdir(config.dataRoot, { recursive: true });
  const app = fastify({ logger: options.logger ?? false });
  const index = new HistoryIndex(config.historyRoot, path.join(config.dataRoot, "history-index.sqlite"));

  app.decorate("historyIndex", index);
  app.addHook("onClose", async () => index.close());

  app.setErrorHandler((error: Error, _request, reply) => {
    if (error instanceof UnsafePathError) {
      return reply.code(400).send({ error: error.message });
    }
    if (error instanceof EditConflictError) {
      return reply.code(409).send({ error: error.message, code: "STALE_SESSION" });
    }
    app.log.error(error);
    return reply.code(500).send({ error: error.message });
  });

  app.get("/api/config", async () => ({
    historyRoot: config.historyRoot,
    localhostOnly: true
  }));

  app.post("/api/index/refresh", async () => index.refreshAll());
  app.get("/api/projects", async () => index.listProjects());
  app.get<{ Querystring: { project?: string } }>("/api/sessions", async (request) =>
    index.listSessions(request.query.project)
  );
  app.get<{ Querystring: { q?: string; limit?: string } }>("/api/search", async (request) =>
    index.search(request.query.q ?? "", Number(request.query.limit ?? 50))
  );

  app.get<{
    Querystring: { path?: string; offset?: string; limit?: string };
  }>("/api/session", async (request, reply) => {
    const relativePath = request.query.path;
    if (!relativePath) return reply.code(400).send({ error: "A session path is required." });
    const fullPath = await resolveSessionPath(config.historyRoot, relativePath);
    const offset = Math.max(Number(request.query.offset ?? 0), 0);
    const limit = Math.min(Math.max(Number(request.query.limit ?? 100), 1), 250);
    const page = await readJsonlPage(fullPath, offset, limit);
    return {
      ...page,
      offset,
      fingerprint: await fileFingerprint(fullPath)
    };
  });

  app.patch<{
    Body: {
      sessionPath?: string;
      uuid?: string;
      contentPath?: string;
      originalText?: string;
      newText?: string;
      fingerprint?: string;
    };
  }>("/api/session/message", async (request, reply) => {
    const body = request.body ?? {};
    if (
      typeof body.sessionPath !== "string" ||
      typeof body.uuid !== "string" ||
      typeof body.contentPath !== "string" ||
      typeof body.originalText !== "string" ||
      typeof body.newText !== "string" ||
      typeof body.fingerprint !== "string"
    ) {
      return reply.code(400).send({ error: "The edit request is incomplete." });
    }
    const fullPath = await resolveSessionPath(config.historyRoot, body.sessionPath);
    const result = await editMessageText(fullPath, path.join(config.dataRoot, "backups"), {
      uuid: body.uuid,
      contentPath: body.contentPath,
      originalText: body.originalText,
      newText: body.newText,
      fingerprint: body.fingerprint
    });
    await index.refreshFile(fullPath, true);
    return { fingerprint: result.fingerprint };
  });

  app.delete<{
    Body: {
      sessionPath?: string;
      uuid?: string;
      fingerprint?: string;
    };
  }>("/api/session/message", async (request, reply) => {
    const body = request.body ?? {};
    if (
      typeof body.sessionPath !== "string" ||
      typeof body.uuid !== "string" ||
      typeof body.fingerprint !== "string"
    ) {
      return reply.code(400).send({ error: "The delete request is incomplete." });
    }
    const fullPath = await resolveSessionPath(config.historyRoot, body.sessionPath);
    const result = await deleteMessageBranch(fullPath, path.join(config.dataRoot, "backups"), {
      uuid: body.uuid,
      fingerprint: body.fingerprint
    });
    await index.refreshFile(fullPath, true);
    return {
      fingerprint: result.fingerprint,
      deletedRecords: result.deletedRecords
    };
  });

  app.post<{
    Body: { sessionPath?: string; messageId?: string; fingerprint?: string };
  }>("/api/session/message/randomize-id", async (request, reply) => {
    const body = request.body ?? {};
    if (
      typeof body.sessionPath !== "string" ||
      typeof body.messageId !== "string" ||
      typeof body.fingerprint !== "string"
    ) {
      return reply.code(400).send({ error: "The message id randomize request is incomplete." });
    }
    const fullPath = await resolveSessionPath(config.historyRoot, body.sessionPath);
    const result = await randomizeMessageId(fullPath, path.join(config.dataRoot, "backups"), {
      oldMessageId: body.messageId,
      newMessageId: generateMessageId(),
      fingerprint: body.fingerprint
    });
    await index.refreshFile(fullPath, true);
    return result;
  });

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

  if (options.clientRoot) {
    try {
      await fsp.access(path.join(options.clientRoot, "index.html"));
      await app.register(fastifyStatic, { root: options.clientRoot });
      app.setNotFoundHandler((request, reply) => {
        if (request.url.startsWith("/api/")) {
          return reply.code(404).send({ error: "Not found." });
        }
        return reply.sendFile("index.html");
      });
    } catch {
      // Development uses Vite's proxy, so a missing production build is expected.
    }
  }

  if (options.refreshOnStart !== false) {
    await index.refreshAll();
  }
  return app;
}
