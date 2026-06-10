import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildApp } from "./app.js";
import { getConfig } from "./config.js";

const currentDirectory = path.dirname(fileURLToPath(import.meta.url));
const config = getConfig();
const app = await buildApp({
  config,
  clientRoot: path.resolve(currentDirectory, "..", "dist-client"),
  logger: true
});

await app.listen({ host: "127.0.0.1", port: config.port });
