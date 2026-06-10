import fsp from "node:fs/promises";
import path from "node:path";
import { buildApp } from "../../server/app.js";

const root = path.resolve(".e2e-data");
const historyRoot = path.join(root, "history");
const dataRoot = path.join(root, "data");
const project = path.join(historyRoot, "C--workspace-test");
const session = path.join(project, "browser-session.jsonl");

await fsp.rm(root, { recursive: true, force: true });
await fsp.mkdir(project, { recursive: true });
await fsp.writeFile(
  session,
  [
    JSON.stringify({ type: "system", content: "read-only metadata" }),
    JSON.stringify({
      type: "user",
      uuid: "browser-user",
      parentUuid: null,
      timestamp: "2026-06-08T10:00:00.000Z",
      message: { role: "user", content: "Where is the lighthouse sentence?" }
    }),
    JSON.stringify({
      type: "assistant",
      uuid: "browser-assistant",
      parentUuid: "browser-user",
      timestamp: "2026-06-08T10:00:01.000Z",
      message: {
        id: "msg-browser-answer",
        role: "assistant",
        content: [{ type: "text", text: "The unique lighthouse sentence is here." }]
      }
    }),
    JSON.stringify({
      type: "system",
      subtype: "turn_duration",
      uuid: "browser-turn-duration",
      parentUuid: "browser-assistant"
    }),
    JSON.stringify({
      type: "user",
      uuid: "browser-follow-up",
      parentUuid: "browser-turn-duration",
      timestamp: "2026-06-08T10:00:02.000Z",
      message: { role: "user", content: "This dependent prompt should be deleted too." }
    }),
    JSON.stringify({
      type: "assistant",
      uuid: "browser-follow-up-answer",
      parentUuid: "browser-follow-up",
      timestamp: "2026-06-08T10:00:03.000Z",
      message: {
        id: "msg-browser-follow-up",
        role: "assistant",
        content: [{ type: "text", text: "This dependent answer should be deleted too." }]
      }
    }),
    JSON.stringify({
      type: "last-prompt",
      leafUuid: "browser-follow-up-answer",
      sessionId: "browser-session"
    })
  ].join("\n") + "\n"
);

const app = await buildApp({
  config: { historyRoot, dataRoot, port: 4318 },
  clientRoot: path.resolve("dist-client"),
  logger: false
});
await app.listen({ host: "127.0.0.1", port: 4318 });
