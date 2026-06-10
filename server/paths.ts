import fs from "node:fs/promises";
import path from "node:path";

export class UnsafePathError extends Error {
  constructor(message = "The requested path is outside the Claude history root.") {
    super(message);
    this.name = "UnsafePathError";
  }
}

export async function resolveSessionPath(
  historyRoot: string,
  relativeSessionPath: string
): Promise<string> {
  if (!relativeSessionPath || path.isAbsolute(relativeSessionPath)) {
    throw new UnsafePathError();
  }

  const root = await fs.realpath(historyRoot);
  const candidate = path.resolve(root, relativeSessionPath);
  const resolved = await fs.realpath(candidate);
  const relative = path.relative(root, resolved);

  if (
    relative.startsWith(`..${path.sep}`) ||
    relative === ".." ||
    path.isAbsolute(relative) ||
    path.extname(resolved).toLowerCase() !== ".jsonl"
  ) {
    throw new UnsafePathError();
  }

  return resolved;
}

export function toSessionRelativePath(historyRoot: string, fullPath: string): string {
  return path.relative(historyRoot, fullPath).split(path.sep).join("/");
}
