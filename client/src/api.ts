import type { Project, SearchResult, Session, SessionPage } from "./types";

async function request<T>(url: string, options?: RequestInit): Promise<T> {
  const response = await fetch(url, {
    ...options,
    headers: { "content-type": "application/json", ...options?.headers }
  });
  const body = (await response.json()) as T & { error?: string; code?: string };
  if (!response.ok) {
    const error = new Error(body.error ?? `Request failed (${response.status})`) as Error & {
      code?: string;
    };
    error.code = body.code;
    throw error;
  }
  return body;
}

export const api = {
  projects: () => request<Project[]>("/api/projects"),
  sessions: (project?: string) =>
    request<Session[]>(`/api/sessions${project ? `?project=${encodeURIComponent(project)}` : ""}`),
  search: (query: string) =>
    request<SearchResult[]>(`/api/search?q=${encodeURIComponent(query)}&limit=100`),
  session: (path: string, offset: number) =>
    request<SessionPage>(
      `/api/session?path=${encodeURIComponent(path)}&offset=${offset}&limit=100`
    ),
  refresh: () =>
    request<{ indexed: number; unchanged: number; removed: number }>("/api/index/refresh", {
      method: "POST"
    }),
  edit: (body: {
    sessionPath: string;
    uuid: string;
    contentPath: string;
    originalText: string;
    newText: string;
    fingerprint: string;
  }) =>
    request<{ fingerprint: string }>("/api/session/message", {
      method: "PATCH",
      body: JSON.stringify(body)
    }),
  deleteMessage: (body: {
    sessionPath: string;
    uuid: string;
    fingerprint: string;
  }) =>
    request<{ fingerprint: string; deletedRecords: number }>("/api/session/message", {
      method: "DELETE",
      body: JSON.stringify(body)
    }),
  randomizeMessageId: (body: {
    sessionPath: string;
    messageId: string;
    fingerprint: string;
  }) =>
    request<{ newMessageId: string; fingerprint: string; updatedRecords: number }>(
      "/api/session/message/randomize-id",
      { method: "POST", body: JSON.stringify(body) }
    ),
  randomizeId: (body: { sessionPath: string; fingerprint: string }) =>
    request<{ newSessionId: string; newPath: string; fingerprint: string }>(
      "/api/session/randomize-id",
      { method: "POST", body: JSON.stringify(body) }
    )
};
