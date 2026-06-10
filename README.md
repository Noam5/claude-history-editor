# Claude History Editor V2

A localhost-only browser for searching messages or conversation IDs, editing, deleting, and
randomizing message IDs in Claude Code JSONL history.

Deleting a message uses Claude Code's parent-linked conversation graph. It removes the selected
logical message and every dependent descendant. Assistant records that share one Anthropic message
ID are deleted together so signed thinking, text, and tool-use fragments cannot be split apart.

## Run

```powershell
npm install
npm run dev
```

Open `http://127.0.0.1:5173`. The production server can be built and run with:

```powershell
npm run build
npm start
```

On Windows, double-click `run-website.bat` to install missing dependencies, build the app,
start the production server, and open `http://127.0.0.1:4317`.

It reads `%USERPROFILE%\.claude\projects` by default. Override locations with:

```powershell
$env:CLAUDE_HISTORY_ROOT = "C:\path\to\projects"
$env:CLAUDE_HISTORY_EDITOR_DATA = "C:\path\to\editor-data"
```

The server binds only to `127.0.0.1`. Every successful edit, deletion, or ID randomization
validates the complete JSONL file, creates a gzip backup, and refuses to save if Claude changed
the file after it was loaded.

Randomizing a `message.id` updates every JSON record that shares the selected ID so one logical
assistant response remains internally consistent.

## Verify

```powershell
npm test
npm run test:e2e
```
