import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { HistoryIndex } from "./indexer.js";

describe("history index", () => {
  let root: string;
  let data: string;
  let index: HistoryIndex;

  beforeEach(async () => {
    root = await fsp.mkdtemp(path.join(os.tmpdir(), "history-index-"));
    data = await fsp.mkdtemp(path.join(os.tmpdir(), "history-data-"));
    const project = path.join(root, "C--workspace-example");
    await fsp.mkdir(project);
    await fsp.writeFile(
      path.join(project, "session-one.jsonl"),
      [
        JSON.stringify({
          uuid: "u1",
          type: "user",
          timestamp: "2026-01-01T00:00:00Z",
          message: { role: "user", content: "Find this self-documenting phrase" }
        }),
        JSON.stringify({
          uuid: "a1",
          type: "assistant",
          timestamp: "2026-01-01T00:00:01Z",
          message: { role: "assistant", content: [{ type: "text", text: "A reply" }] }
        })
      ].join("\n") + "\n"
    );
    index = new HistoryIndex(root, path.join(data, "index.sqlite"));
  });

  afterEach(async () => {
    index.close();
    await fsp.rm(root, { recursive: true, force: true });
    await fsp.rm(data, { recursive: true, force: true });
  });

  it("discovers sessions, searches text, and skips unchanged files", async () => {
    expect(await index.refreshAll()).toMatchObject({ indexed: 1, unchanged: 0 });
    expect(index.listProjects()[0]).toMatchObject({
      project: "C--workspace-example",
      sessions: 1,
      messages: 2
    });
    expect(index.search("self-documenting")[0]).toMatchObject({
      uuid: "u1",
      role: "user"
    });
    expect(await index.refreshAll()).toMatchObject({ indexed: 0, unchanged: 1 });
  });

  it("searches conversations by full or partial session id", async () => {
    await index.refreshAll();

    expect(index.search("session-one")[0]).toMatchObject({
      kind: "session",
      sessionId: "session-one",
      sessionPath: "C--workspace-example/session-one.jsonl"
    });
    expect(index.search("ONE")[0]).toMatchObject({
      kind: "session",
      sessionId: "session-one"
    });
  });
});
