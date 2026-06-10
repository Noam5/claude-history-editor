import { useEffect, useMemo, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { api } from "./api";
import type {
  ConversationRecord,
  Project,
  SearchResult,
  Session,
  SessionPage,
  TextBlock
} from "./types";

const PAGE_SIZE = 100;

function formatBytes(bytes: number): string {
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function formatDate(value?: string | number): string {
  if (!value) return "Unknown time";
  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit"
  }).format(new Date(value));
}

function displayProject(project: string): string {
  return project.replace(/--/g, ":\\").replace(/-/g, " ");
}

function sessionIdFromPath(sessionPath?: string): string | undefined {
  return sessionPath?.split("/").at(-1)?.replace(/\.jsonl$/i, "");
}

function App() {
  const [projects, setProjects] = useState<Project[]>([]);
  const [sessions, setSessions] = useState<Session[]>([]);
  const [selectedProject, setSelectedProject] = useState<string>();
  const [selectedPath, setSelectedPath] = useState<string>();
  const [offset, setOffset] = useState(0);
  const [page, setPage] = useState<SessionPage>();
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<SearchResult[]>([]);
  const [searching, setSearching] = useState(false);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [notice, setNotice] = useState<string>();
  const [error, setError] = useState<string>();
  const [focusUuid, setFocusUuid] = useState<string>();

  const selectedSession = useMemo(
    () => sessions.find((session) => session.path === selectedPath),
    [sessions, selectedPath]
  );
  const selectedSessionId = selectedSession?.sessionId ?? sessionIdFromPath(selectedPath);

  async function loadLibrary(project?: string) {
    setError(undefined);
    try {
      const [nextProjects, nextSessions] = await Promise.all([
        api.projects(),
        api.sessions(project)
      ]);
      setProjects(nextProjects);
      setSessions(nextSessions);
    } catch (caught) {
      setError((caught as Error).message);
    } finally {
      setLoading(false);
    }
  }

  async function loadSession(path: string, nextOffset: number) {
    setLoading(true);
    setError(undefined);
    try {
      setPage(await api.session(path, nextOffset));
    } catch (caught) {
      setError((caught as Error).message);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void loadLibrary();
  }, []);

  useEffect(() => {
    if (selectedPath) void loadSession(selectedPath, offset);
  }, [selectedPath, offset]);

  useEffect(() => {
    if (!focusUuid || !page) return;
    const element = document.getElementById(`message-${focusUuid}`);
    element?.scrollIntoView({ behavior: "smooth", block: "center" });
  }, [focusUuid, page]);

  async function chooseProject(project?: string) {
    setSelectedProject(project);
    setSelectedPath(undefined);
    setPage(undefined);
    setOffset(0);
    await loadLibrary(project);
  }

  function chooseSession(path: string, nextOffset = 0, uuid?: string) {
    setSelectedPath(path);
    setOffset(nextOffset);
    setFocusUuid(uuid);
    setResults([]);
  }

  async function search(event: React.FormEvent) {
    event.preventDefault();
    if (!query.trim()) {
      setResults([]);
      return;
    }
    setSearching(true);
    setError(undefined);
    try {
      setResults(await api.search(query));
    } catch (caught) {
      setError((caught as Error).message);
    } finally {
      setSearching(false);
    }
  }

  async function refreshIndex() {
    setRefreshing(true);
    setError(undefined);
    try {
      const result = await api.refresh();
      setNotice(
        `Index refreshed: ${result.indexed} changed, ${result.unchanged} unchanged, ${result.removed} removed.`
      );
      await loadLibrary(selectedProject);
    } catch (caught) {
      setError((caught as Error).message);
    } finally {
      setRefreshing(false);
    }
  }

  async function saveBlock(record: ConversationRecord, block: TextBlock, newText: string) {
    if (!selectedPath || !record.uuid || !page) return;
    setError(undefined);
    const result = await api.edit({
      sessionPath: selectedPath,
      uuid: record.uuid,
      contentPath: block.path,
      originalText: block.text,
      newText,
      fingerprint: page.fingerprint
    });
    setPage({
      ...page,
      fingerprint: result.fingerprint,
      records: page.records.map((candidate) =>
        candidate.uuid !== record.uuid
          ? candidate
          : {
              ...candidate,
              editable: candidate.editable.map((candidateBlock) =>
                candidateBlock.path === block.path
                  ? { ...candidateBlock, text: newText }
                  : candidateBlock
              )
            }
      )
    });
    setNotice("Message saved. A compressed backup was created.");
    await loadLibrary(selectedProject);
  }

  async function deleteMessage(record: ConversationRecord) {
    if (!selectedPath || !record.uuid || !page) return;
    setError(undefined);
    const result = await api.deleteMessage({
      sessionPath: selectedPath,
      uuid: record.uuid,
      fingerprint: page.fingerprint
    });
    const nextOffset = Math.max(0, Math.floor((record.line - 2) / PAGE_SIZE) * PAGE_SIZE);
    setNotice(
      `${result.deletedRecords} linked ${result.deletedRecords === 1 ? "record" : "records"} deleted. A compressed backup was created.`
    );
    await loadLibrary(selectedProject);
    if (nextOffset === offset) {
      await loadSession(selectedPath, nextOffset);
    } else {
      setOffset(nextOffset);
    }
  }

  async function randomizeMessageId(record: ConversationRecord) {
    if (!selectedPath || !record.messageId || !page) return;
    const oldMessageId = record.messageId;
    const result = await api.randomizeMessageId({
      sessionPath: selectedPath,
      messageId: oldMessageId,
      fingerprint: page.fingerprint
    });
    setPage({
      ...page,
      fingerprint: result.fingerprint,
      records: page.records.map((candidate) =>
        candidate.messageId === oldMessageId
          ? { ...candidate, messageId: result.newMessageId }
          : candidate
      )
    });
    setNotice(
      `Message id changed to ${result.newMessageId} in ${result.updatedRecords} ${result.updatedRecords === 1 ? "record" : "records"}. A compressed backup was created.`
    );
    await loadLibrary(selectedProject);
  }

  async function randomizeId() {
    if (!selectedPath || !page) return;
    const confirmed = window.confirm(
      "Replace this session's id with a new random one?\n\n" +
        "Every occurrence of the id is rewritten and the file is renamed. " +
        "This cannot be undone from the app, but a compressed backup will be created."
    );
    if (!confirmed) return;
    setError(undefined);
    try {
      const result = await api.randomizeId({
        sessionPath: selectedPath,
        fingerprint: page.fingerprint
      });
      await loadLibrary(selectedProject);
      setNotice(`Session id changed to ${result.newSessionId}. A compressed backup was created.`);
      chooseSession(result.newPath);
    } catch (caught) {
      setError((caught as Error).message);
    }
  }

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div className="brand">
          <div className="brand-mark">H</div>
          <div>
            <strong>History Editor V2</strong>
            <span>Edit and delete, locally</span>
          </div>
        </div>

        <form className="search-form" onSubmit={search}>
          <input
            aria-label="Search all history"
            placeholder="Search all history..."
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
          <button type="submit" disabled={searching}>
            {searching ? "Searching" : "Search"}
          </button>
        </form>

        {results.length > 0 ? (
          <nav className="nav-section search-results" aria-label="Search results">
            <div className="section-heading">
              <span>Results</span>
              <button className="text-button" onClick={() => setResults([])}>
                Clear
              </button>
            </div>
            {results.map((result) => (
              <button
                className="result-item"
                key={`${result.sessionPath}:${result.uuid}:${result.contentPath}`}
                onClick={() =>
                  chooseSession(
                    result.sessionPath,
                    Math.floor((result.line - 1) / PAGE_SIZE) * PAGE_SIZE,
                    result.uuid
                  )
                }
              >
                <span className={`role-dot ${result.role}`} />
                <span>
                  <strong>{displayProject(result.project)}</strong>
                  <small>{result.snippet.replace(/<\/?mark>/g, "")}</small>
                </span>
              </button>
            ))}
          </nav>
        ) : (
          <>
            <nav className="nav-section projects" aria-label="Projects">
              <div className="section-heading">
                <span>Projects</span>
                <button className="icon-button" onClick={refreshIndex} disabled={refreshing}>
                  {refreshing ? "..." : "↻"}
                </button>
              </div>
              <button
                className={!selectedProject ? "nav-item active" : "nav-item"}
                onClick={() => void chooseProject()}
              >
                <span>All sessions</span>
                <small>{projects.reduce((sum, project) => sum + project.sessions, 0)}</small>
              </button>
              {projects.map((project) => (
                <button
                  key={project.project}
                  className={selectedProject === project.project ? "nav-item active" : "nav-item"}
                  onClick={() => void chooseProject(project.project)}
                >
                  <span>{displayProject(project.project)}</span>
                  <small>{project.sessions}</small>
                </button>
              ))}
            </nav>

            <nav className="nav-section sessions" aria-label="Sessions">
              <div className="section-heading">
                <span>Recent sessions</span>
              </div>
              {sessions.map((session) => (
                <button
                  key={session.path}
                  className={selectedPath === session.path ? "session-item active" : "session-item"}
                  onClick={() => chooseSession(session.path)}
                >
                  <strong>{session.preview || session.sessionId}</strong>
                  <small>
                    {formatDate(session.mtimeMs)} · {formatBytes(session.size)}
                  </small>
                </button>
              ))}
            </nav>
          </>
        )}
      </aside>

      <main className="main">
        {error && (
          <div className="toast error" role="alert">
            {error}
            <button onClick={() => setError(undefined)}>×</button>
          </div>
        )}
        {notice && (
          <div className="toast success">
            {notice}
            <button onClick={() => setNotice(undefined)}>×</button>
          </div>
        )}

        {!selectedPath ? (
          <section className="empty-state">
            <div className="empty-icon">⌕</div>
            <h1>Find the moment you want to change.</h1>
            <p>
              Search across every local Claude Code session, or choose a recent conversation from
              the sidebar. Edit text, or delete a message and its dependent branch.
            </p>
          </section>
        ) : (
          <>
            <header className="session-header">
              <div>
                <span className="eyebrow">{displayProject(selectedSession?.project ?? "")}</span>
                <h1 className="session-id-title">{selectedSessionId || "Conversation"}</h1>
                {selectedSession?.preview && (
                  <p className="session-preview">{selectedSession.preview}</p>
                )}
                <p>
                  {selectedSession?.messageCount ?? "—"} editable text blocks ·{" "}
                  {formatBytes(selectedSession?.size ?? 0)}
                </p>
              </div>
              <div className="header-actions">
                <button className="secondary-button" onClick={() => void randomizeId()}>
                  Randomize ID
                </button>
                <button className="secondary-button" onClick={() => void loadSession(selectedPath, offset)}>
                  Reload
                </button>
              </div>
            </header>

            <div className="page-controls">
              <button disabled={offset === 0} onClick={() => setOffset(Math.max(0, offset - PAGE_SIZE))}>
                Previous
              </button>
              <span>Records {offset + 1}–{offset + (page?.records.length ?? 0)}</span>
              <button disabled={page?.nextOffset == null} onClick={() => setOffset(page!.nextOffset!)}>
                Next
              </button>
              <button
                disabled={page?.nextOffset == null}
                onClick={() => setOffset(Math.floor(((page?.total ?? 1) - 1) / PAGE_SIZE) * PAGE_SIZE)}
              >
                Last
              </button>
            </div>

            <section className="conversation" aria-busy={loading}>
              {loading && !page ? <div className="loading">Loading conversation...</div> : null}
              {page?.records.map((record) => (
                <MessageCard
                  key={`${record.line}:${record.uuid ?? record.type}`}
                  record={record}
                  onSave={saveBlock}
                  onDelete={deleteMessage}
                  onRandomizeMessageId={randomizeMessageId}
                />
              ))}
            </section>

            <div className="page-controls bottom">
              <button disabled={offset === 0} onClick={() => setOffset(Math.max(0, offset - PAGE_SIZE))}>
                Previous
              </button>
              <span>Page {Math.floor(offset / PAGE_SIZE) + 1}</span>
              <button disabled={page?.nextOffset == null} onClick={() => setOffset(page!.nextOffset!)}>
                Next
              </button>
              <button
                disabled={page?.nextOffset == null}
                onClick={() => setOffset(Math.floor(((page?.total ?? 1) - 1) / PAGE_SIZE) * PAGE_SIZE)}
              >
                Last
              </button>
            </div>
          </>
        )}
      </main>
    </div>
  );
}

function MessageCard({
  record,
  onSave,
  onDelete,
  onRandomizeMessageId
}: {
  record: ConversationRecord;
  onSave: (record: ConversationRecord, block: TextBlock, newText: string) => Promise<void>;
  onDelete: (record: ConversationRecord) => Promise<void>;
  onRandomizeMessageId: (record: ConversationRecord) => Promise<void>;
}) {
  const isMeta = record.editable.length === 0;
  const canDelete = Boolean(record.uuid && (record.role === "user" || record.role === "assistant"));
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState<string>();
  const [randomizingMessageId, setRandomizingMessageId] = useState(false);
  const [messageIdError, setMessageIdError] = useState<string>();

  async function remove() {
    const confirmed = window.confirm(
      `Delete this ${record.role} message and every dependent message after it?\n\nClaude Code stores conversations as a parent-linked graph. This cannot be undone from the app, but a compressed backup will be created.`
    );
    if (!confirmed) return;
    setDeleting(true);
    setDeleteError(undefined);
    try {
      await onDelete(record);
    } catch (caught) {
      setDeleteError((caught as Error).message);
    } finally {
      setDeleting(false);
    }
  }

  async function randomizeId() {
    const confirmed = window.confirm(
      `Replace ${record.messageId} with a new random message.id?\n\nEvery JSON record that shares this message.id will be updated. This cannot be undone from the app, but a compressed backup will be created.`
    );
    if (!confirmed) return;
    setRandomizingMessageId(true);
    setMessageIdError(undefined);
    try {
      await onRandomizeMessageId(record);
    } catch (caught) {
      setMessageIdError((caught as Error).message);
    } finally {
      setRandomizingMessageId(false);
    }
  }

  return (
    <article
      id={record.uuid ? `message-${record.uuid}` : undefined}
      className={`message-card ${record.role ?? "meta"} ${isMeta ? "compact" : ""} ${record.orphaned ? "orphaned" : ""}`}
    >
      <header>
        <div>
          <span className={`role-dot ${record.role ?? "meta"}`} />
          <strong>{record.role ?? record.type}</strong>
          <span className="line-number">line {record.line}</span>
          {record.orphaned && (
            <span
              className="orphan-badge"
              title={`This message's parent (${record.parentUuid}) is not present in this file, so resuming will not reach the conversation before it.`}
            >
              ⚠ orphaned
            </span>
          )}
        </div>
        <div className="card-actions">
          <time>{formatDate(record.timestamp)}</time>
          {canDelete && (
            <button className="delete-button" onClick={() => void remove()} disabled={deleting}>
              {deleting ? "Deleting..." : "Delete from here"}
            </button>
          )}
        </div>
      </header>
      {deleteError && <p className="inline-error">{deleteError}</p>}
      {messageIdError && <p className="inline-error">{messageIdError}</p>}
      {record.messageId && (
        <div className="message-id" title={record.messageId}>
          <span>message.id</span>
          <code>{record.messageId}</code>
          <button
            className="message-id-button"
            onClick={() => void randomizeId()}
            disabled={randomizingMessageId}
          >
            {randomizingMessageId ? "Randomizing..." : "Randomize"}
          </button>
        </div>
      )}
      {record.editable.map((block) => (
        <EditableBlock key={block.path} record={record} block={block} onSave={onSave} />
      ))}
      {record.readOnly.length > 0 && (
        <details className="readonly">
          <summary>
            {record.readOnly.length} read-only {record.readOnly.length === 1 ? "block" : "blocks"}
          </summary>
          {record.readOnly.map((block, index) => (
            <div className="readonly-block" key={`${block.type}:${index}`}>
              <strong>{block.type}</strong>
              <pre>{block.summary}</pre>
            </div>
          ))}
        </details>
      )}
    </article>
  );
}

function EditableBlock({
  record,
  block,
  onSave
}: {
  record: ConversationRecord;
  block: TextBlock;
  onSave: (record: ConversationRecord, block: TextBlock, newText: string) => Promise<void>;
}) {
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(block.text);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string>();

  useEffect(() => setValue(block.text), [block.text]);

  async function save() {
    setSaving(true);
    setSaveError(undefined);
    try {
      await onSave(record, block, value);
      setEditing(false);
    } catch (caught) {
      setSaveError((caught as Error).message);
    } finally {
      setSaving(false);
    }
  }

  if (editing) {
    return (
      <div className="editor">
        <textarea
          aria-label={`Edit ${record.role} message`}
          value={value}
          onChange={(event) => setValue(event.target.value)}
          rows={Math.min(24, Math.max(6, value.split("\n").length + 2))}
          autoFocus
        />
        {saveError && <p className="inline-error">{saveError}</p>}
        <div className="editor-actions">
          <button
            className="secondary-button"
            onClick={() => {
              setValue(block.text);
              setEditing(false);
              setSaveError(undefined);
            }}
            disabled={saving}
          >
            Cancel
          </button>
          <button className="primary-button" onClick={save} disabled={saving || value === block.text}>
            {saving ? "Saving..." : "Save message"}
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="message-content">
      <ReactMarkdown remarkPlugins={[remarkGfm]}>{block.text}</ReactMarkdown>
      <button className="edit-button" onClick={() => setEditing(true)}>
        Edit
      </button>
    </div>
  );
}

export default App;
