#!/usr/bin/env bash
# Local-only Agentpack ledger backup.
#
# By default backs up ONLY this project's own .agentpack/ ledger and writes
# the result into ./.backups/ inside the project. External paths (Claude
# Desktop config, other repos) are touched only when explicitly requested
# via flags.
#
# Usage:
#   scripts/backup.sh                          # this project only → ./.backups/
#   scripts/backup.sh --include-desktop        # + Claude Desktop config
#   scripts/backup.sh --include-repo <path>    # + another repo's .agentpack/
#   scripts/backup.sh --dest <dir>             # custom destination
#
# Flags can be combined. --include-repo can be repeated.

set -euo pipefail

PROJECT_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DEST="$PROJECT_ROOT/.backups/agentpack-backup-$(date +%Y%m%d-%H%M%S)"
INCLUDE_DESKTOP=0
EXTRA_REPOS=()

while [[ $# -gt 0 ]]; do
  case "$1" in
    --include-desktop)
      INCLUDE_DESKTOP=1
      shift
      ;;
    --include-repo)
      [[ $# -ge 2 ]] || { echo "--include-repo requires a path" >&2; exit 64; }
      EXTRA_REPOS+=("$2")
      shift 2
      ;;
    --dest)
      [[ $# -ge 2 ]] || { echo "--dest requires a path" >&2; exit 64; }
      DEST="$2"
      shift 2
      ;;
    -h|--help)
      sed -n '2,18p' "$0"
      exit 0
      ;;
    *)
      echo "Unknown flag: $1" >&2
      exit 64
      ;;
  esac
done

mkdir -p "$DEST"
echo "Backup destination: $DEST"
echo ""

# 1. This project's own .agentpack/.
echo "== This project =="
if [[ -d "$PROJECT_ROOT/.agentpack" ]]; then
  cp -R "$PROJECT_ROOT/.agentpack" "$DEST/self.agentpack"
  echo "  ✓ self.agentpack ($(du -sh "$DEST/self.agentpack" | awk '{print $1}'))"
else
  echo "  (no .agentpack at $PROJECT_ROOT)"
fi

# This project's own .mcp.json (local-ignored integration file).
if [[ -f "$PROJECT_ROOT/.mcp.json" ]]; then
  cp "$PROJECT_ROOT/.mcp.json" "$DEST/self.mcp.json"
  echo "  ✓ self.mcp.json"
fi

# 2. Extra repos, only if explicitly requested.
if [[ ${#EXTRA_REPOS[@]} -gt 0 ]]; then
  echo ""
  echo "== Extra repos =="
  mkdir -p "$DEST/extra-repos"
  for repo in "${EXTRA_REPOS[@]}"; do
    if [[ ! -d "$repo" ]]; then
      echo "  ! $repo: not a directory, skipping"
      continue
    fi
    repo_abs="$(cd "$repo" && pwd)"
    slug="$(basename "$repo_abs")"
    target="$DEST/extra-repos/$slug"
    mkdir -p "$target"
    if [[ -d "$repo_abs/.agentpack" ]]; then
      cp -R "$repo_abs/.agentpack" "$target/.agentpack"
      echo "  ✓ $slug/.agentpack"
    fi
    if [[ -f "$repo_abs/.mcp.json" ]]; then
      cp "$repo_abs/.mcp.json" "$target/.mcp.json"
      echo "  ✓ $slug/.mcp.json"
    fi
    echo "$repo_abs" >> "$target/SOURCE_PATH.txt"
  done
fi

# 3. Claude Desktop config, only if explicitly requested.
if [[ $INCLUDE_DESKTOP -eq 1 ]]; then
  echo ""
  echo "== Claude Desktop =="
  desktop_config="$HOME/Library/Application Support/Claude/claude_desktop_config.json"
  if [[ -f "$desktop_config" ]]; then
    cp "$desktop_config" "$DEST/claude_desktop_config.json"
    echo "  ✓ claude_desktop_config.json"
  else
    echo "  (no Desktop config found at $desktop_config)"
  fi
fi

# 4. Manifest.
{
  echo "Agentpack backup"
  echo "Created: $(date)"
  echo "Project: $PROJECT_ROOT"
  echo "Agentpack version: $(agentpack --version 2>/dev/null || echo unknown)"
  echo "Binary path: $(command -v agentpack 2>/dev/null || echo unknown)"
  echo ""
  echo "Flags:"
  echo "  --include-desktop: $INCLUDE_DESKTOP"
  echo "  --include-repo: ${EXTRA_REPOS[*]:-<none>}"
  echo ""
  echo "=== Contents ==="
  find "$DEST" -type f | sed "s|$DEST/||" | sort
} > "$DEST/MANIFEST.txt"

echo ""
echo "Done."
echo "Backup at: $DEST"
echo "Size:      $(du -sh "$DEST" | awk '{print $1}')"
echo ""
echo "To restore: scripts/restore.sh \"$DEST\""
