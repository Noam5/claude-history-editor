export type Project = {
  project: string;
  sessions: number;
  messages: number;
  size: number;
};

export type Session = {
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

export type TextBlock = { path: string; text: string };
export type ReadOnlyBlock = { type: string; summary: string };
export type ConversationRecord = {
  line: number;
  type: string;
  uuid?: string;
  parentUuid?: string;
  role?: string;
  timestamp?: string;
  editable: TextBlock[];
  readOnly: ReadOnlyBlock[];
  orphaned: boolean;
};

export type SessionPage = {
  records: ConversationRecord[];
  offset: number;
  nextOffset: number | null;
  total: number;
  fingerprint: string;
};

export type SearchResult = {
  sessionPath: string;
  uuid: string;
  contentPath: string;
  line: number;
  project: string;
  role: string;
  timestamp: string;
  text: string;
  snippet: string;
};
