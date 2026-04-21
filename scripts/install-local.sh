#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
CODEX_HOME="${CODEX_HOME:-$HOME/.codex}"
TARGET_DIR="$CODEX_HOME/plugins/playwright-openai-plugin"

mkdir -p "$CODEX_HOME/plugins"
ln -sfn "$REPO_ROOT" "$TARGET_DIR"

cd "$REPO_ROOT"
npm install

echo "Installed symlink: $TARGET_DIR -> $REPO_ROOT"
echo "Verify with: $TARGET_DIR/scripts/poai --help"
