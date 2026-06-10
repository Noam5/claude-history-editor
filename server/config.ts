import os from "node:os";
import path from "node:path";

export type AppConfig = {
  historyRoot: string;
  dataRoot: string;
  port: number;
};

export function getConfig(overrides: Partial<AppConfig> = {}): AppConfig {
  const localAppData =
    process.env.LOCALAPPDATA ?? path.join(os.homedir(), ".local", "share");

  return {
    historyRoot:
      overrides.historyRoot ??
      process.env.CLAUDE_HISTORY_ROOT ??
      path.join(os.homedir(), ".claude", "projects"),
    dataRoot:
      overrides.dataRoot ??
      process.env.CLAUDE_HISTORY_EDITOR_DATA ??
      path.join(localAppData, "claude-history-editor"),
    port: overrides.port ?? Number(process.env.PORT ?? 4317)
  };
}
