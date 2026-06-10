#!/usr/bin/env bash
#
# Build and run the Claude History Editor, then open it in a browser.
# Linux/macOS counterpart to run-website.bat.
#
# Usage:
#   ./run-website.sh                # build + start, open http://127.0.0.1:4317
#   ./run-website.sh --no-browser   # build + start without opening a browser
#   PORT=5000 ./run-website.sh      # override the port
#
set -euo pipefail

# Always run from the directory this script lives in.
cd "$(dirname "$0")"

PORT="${PORT:-4317}"
URL="http://127.0.0.1:${PORT}"

# ---------------------------------------------------------------------------
# 1. Node 24+ is required.
#    The server builds a SQLite FTS5 full-text index on startup. Node's bundled
#    SQLite only ships the FTS5 extension on Node 24+, so older Node (e.g. 22)
#    crashes immediately with "no such module: fts5".
# ---------------------------------------------------------------------------

# If nvm is available, prefer a Node 24 it manages.
if [ -s "${NVM_DIR:-$HOME/.nvm}/nvm.sh" ]; then
  export NVM_DIR="${NVM_DIR:-$HOME/.nvm}"
  # shellcheck disable=SC1091
  . "$NVM_DIR/nvm.sh"
  if ! nvm use 24 >/dev/null 2>&1; then
    echo "Installing Node 24 via nvm (required for SQLite FTS5)..."
    nvm install 24 >/dev/null
    nvm use 24 >/dev/null
  fi
fi

if ! command -v node >/dev/null 2>&1; then
  echo "Error: Node.js was not found in PATH. Install Node.js 24+ and try again." >&2
  exit 1
fi

NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
if [ "$NODE_MAJOR" -lt 24 ]; then
  echo "Error: Node $(node -v) found, but Node 24+ is required (SQLite FTS5)." >&2
  echo "       Install Node 24+ (e.g. 'nvm install 24') and re-run." >&2
  exit 1
fi

echo "Using Node $(node -v)"

# ---------------------------------------------------------------------------
# 2. Dependencies.
# ---------------------------------------------------------------------------
if [ ! -d node_modules ]; then
  echo "Installing dependencies..."
  npm install
fi

# On some filesystems the node_modules/.bin shims lose their execute bit, which
# breaks 'tsc'/'vite' during the build. Restore it defensively.
chmod +x node_modules/.bin/* 2>/dev/null || true

# Work around the known npm optional-dependency bug where rollup's platform
# native module is missing (vite build fails with
# "Cannot find module @rollup/rollup-linux-x64-gnu"). Only install when absent.
if [ ! -d node_modules/@rollup ] && \
   node -e 'require("rollup")' >/dev/null 2>&1; then
  : # rollup loads fine, nothing to do
fi
if ! node -e 'require("rollup/dist/native.js")' >/dev/null 2>&1; then
  ROLLUP_VER="$(node -p 'require("./node_modules/rollup/package.json").version' 2>/dev/null || echo '')"
  if [ -n "$ROLLUP_VER" ]; then
    echo "Installing missing rollup native module (npm optional-deps workaround)..."
    npm install --no-save "@rollup/rollup-linux-x64-gnu@${ROLLUP_VER}" >/dev/null 2>&1 || \
      npm install --no-save "@rollup/rollup-linux-x64-musl@${ROLLUP_VER}" >/dev/null 2>&1 || true
  fi
fi

# ---------------------------------------------------------------------------
# 3. Build.
# ---------------------------------------------------------------------------
echo "Building Claude History Editor..."
npm run build

# ---------------------------------------------------------------------------
# 4. Start, optionally opening a browser once the server is up.
# ---------------------------------------------------------------------------
echo "Starting at ${URL}"

if [ "${1:-}" != "--no-browser" ]; then
  (
    # Wait for the server to accept connections, then open the default browser.
    for _ in $(seq 1 30); do
      if curl -sf "${URL}/" >/dev/null 2>&1; then break; fi
      sleep 0.5
    done
    if command -v xdg-open >/dev/null 2>&1; then
      xdg-open "${URL}" >/dev/null 2>&1 || true
    elif command -v open >/dev/null 2>&1; then
      open "${URL}" >/dev/null 2>&1 || true
    fi
  ) &
fi

# Run the server in the foreground (Ctrl-C to stop).
PORT="$PORT" exec node dist-server/index.js
