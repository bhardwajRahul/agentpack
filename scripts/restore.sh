#!/usr/bin/env bash
# Restore an Agentpack backup produced by scripts/backup.sh.
#
# Restores the project's own .agentpack/ in-place. Extra repos and Desktop
# config are reported and require an explicit flag to be touched, because:
#   - re-installed agentpack binary path is likely different in Desktop args
#   - extra repos may already have current ledgers that should not be clobbered
#
# Never overwrites an existing .agentpack/ — skips and warns.
#
# Usage:
#   scripts/restore.sh <backup-dir>
#   scripts/restore.sh <backup-dir> --extra-repos          # also restore extra-repos/*
#   scripts/restore.sh <backup-dir> --desktop              # also copy Desktop config back

set -euo pipefail

if [[ $# -lt 1 ]]; then
  sed -n '2,17p' "$0" >&2
  exit 64
fi

SRC="$1"; shift
RESTORE_EXTRAS=0
RESTORE_DESKTOP=0

while [[ $# -gt 0 ]]; do
  case "$1" in
    --extra-repos) RESTORE_EXTRAS=1; shift ;;
    --desktop)     RESTORE_DESKTOP=1; shift ;;
    *) echo "Unknown flag: $1" >&2; exit 64 ;;
  esac
done

if [[ ! -d "$SRC" ]]; then
  echo "Backup directory not found: $SRC" >&2
  exit 65
fi

PROJECT_ROOT="$(cd "$(dirname "$0")/.." && pwd)"

echo "Restoring from: $SRC"
echo "Into project:   $PROJECT_ROOT"
echo ""

# 1. This project's own .agentpack/.
echo "== This project =="
if [[ -d "$SRC/self.agentpack" ]]; then
  if [[ -d "$PROJECT_ROOT/.agentpack" ]]; then
    echo "  ! $PROJECT_ROOT/.agentpack already exists. Move it aside first."
  else
    cp -R "$SRC/self.agentpack" "$PROJECT_ROOT/.agentpack"
    echo "  ✓ $PROJECT_ROOT/.agentpack"
  fi
fi
if [[ -f "$SRC/self.mcp.json" ]]; then
  if [[ -f "$PROJECT_ROOT/.mcp.json" ]]; then
    if diff -q "$PROJECT_ROOT/.mcp.json" "$SRC/self.mcp.json" > /dev/null 2>&1; then
      :
    else
      echo "  ! .mcp.json differs from backup, keeping current. Diff:"
      diff -u "$PROJECT_ROOT/.mcp.json" "$SRC/self.mcp.json" || true
    fi
  else
    cp "$SRC/self.mcp.json" "$PROJECT_ROOT/.mcp.json"
    echo "  ✓ $PROJECT_ROOT/.mcp.json"
  fi
fi

# 2. Extra repos.
if [[ -d "$SRC/extra-repos" ]]; then
  echo ""
  echo "== Extra repos =="
  if [[ $RESTORE_EXTRAS -ne 1 ]]; then
    echo "  (Found extras but --extra-repos not set, listing only:)"
    for slug_dir in "$SRC/extra-repos"/*/; do
      [[ -d "$slug_dir" ]] || continue
      slug="$(basename "$slug_dir")"
      src_path="$(cat "$slug_dir/SOURCE_PATH.txt" 2>/dev/null || echo "?")"
      echo "  - $slug → $src_path"
    done
    echo "  Re-run with --extra-repos to restore them in place."
  else
    for slug_dir in "$SRC/extra-repos"/*/; do
      [[ -d "$slug_dir" ]] || continue
      slug="$(basename "$slug_dir")"
      target_root="$(cat "$slug_dir/SOURCE_PATH.txt" 2>/dev/null || true)"
      if [[ -z "$target_root" || ! -d "$target_root" ]]; then
        echo "  ! $slug: original path missing or not recorded, skipping"
        continue
      fi
      if [[ -d "$slug_dir/.agentpack" ]]; then
        if [[ -d "$target_root/.agentpack" ]]; then
          echo "  ! $target_root/.agentpack exists, skipping"
        else
          cp -R "$slug_dir/.agentpack" "$target_root/"
          echo "  ✓ $target_root/.agentpack"
        fi
      fi
      if [[ -f "$slug_dir/.mcp.json" && ! -f "$target_root/.mcp.json" ]]; then
        cp "$slug_dir/.mcp.json" "$target_root/.mcp.json"
        echo "  ✓ $target_root/.mcp.json"
      fi
    done
  fi
fi

# 3. Desktop config.
if [[ -f "$SRC/claude_desktop_config.json" ]]; then
  echo ""
  echo "== Claude Desktop =="
  current="$HOME/Library/Application Support/Claude/claude_desktop_config.json"
  if [[ $RESTORE_DESKTOP -ne 1 ]]; then
    echo "  (Found backup but --desktop not set.)"
    echo "  Source:  $SRC/claude_desktop_config.json"
    echo "  Current: $current"
    echo "  Note: agentpack binary path likely changed after reinstall."
    echo "  Diff vs current:"
    diff -u "$current" "$SRC/claude_desktop_config.json" 2>/dev/null || true
  else
    cp "$current" "$current.before-restore-$(date +%s)" 2>/dev/null || true
    cp "$SRC/claude_desktop_config.json" "$current"
    echo "  ✓ restored Desktop config (previous saved as .before-restore-*)"
    echo "  Reminder: update args[0] to the new agentpack binary path if needed."
  fi
fi

echo ""
echo "Done."
