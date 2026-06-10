export type TextBlock = {
  path: string;
  text: string;
};

export type ReadOnlyBlock = {
  type: string;
  summary: string;
};

export type ConversationRecord = {
  line: number;
  type: string;
  uuid?: string;
  parentUuid?: string;
  messageId?: string;
  role?: string;
  timestamp?: string;
  editable: TextBlock[];
  readOnly: ReadOnlyBlock[];
  // True when parentUuid references a uuid that exists nowhere in the file,
  // which breaks the parent-linked chain Claude Code walks when resuming.
  orphaned: boolean;
};

export type SessionSummary = {
  path: string;
  project: string;
  sessionId: string;
  size: number;
  mtimeMs: number;
  messageCount: number;
  firstTimestamp?: string;
  lastTimestamp?: string;
  preview?: string;
};
