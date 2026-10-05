#!/usr/bin/env bash
# Export this project's Claude Code conversation history (the session
# transcript, all subagent/workflow transcripts, and the memory/ directory)
# into a single archive you can carry to another computer.
#
# This does NOT touch the git repo itself -- that's already pushed to the
# remote, so on the new machine you just `git clone` it (import-claude-session.sh
# does this for you). This script is only for the *conversation* side: the
# part of "continuing where we left off" that git can't carry.
#
# IMPORTANT: the resulting archive contains your full conversation history
# with Claude, which may include file contents, reasoning, and anything else
# discussed in this session. Treat it like any other private backup --
# transfer it by USB drive, scp, or a private cloud folder. Do NOT commit it
# to this (or any) git repo, and do NOT attach it to a public issue/PR.
#
# Usage:
#   scripts/export-claude-session.sh [output-directory]
#
# output-directory defaults to $HOME. The archive is named
# turtlzim-claude-session-<YYYYMMDD-HHMMSS>.tar.gz.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
OUT_DIR="${1:-$HOME}"

# Claude Code names each project's state directory under ~/.claude/projects/
# after the project's absolute path, with every "/" replaced by "-".
CLAUDE_DIR_NAME="$(printf '%s' "$PROJECT_DIR" | tr '/' '-')"
CLAUDE_PROJECT_DIR="$HOME/.claude/projects/$CLAUDE_DIR_NAME"

if [ ! -d "$CLAUDE_PROJECT_DIR" ]; then
    echo "error: no Claude Code session directory found at:" >&2
    echo "  $CLAUDE_PROJECT_DIR" >&2
    echo "(expected it to exist for project dir: $PROJECT_DIR)" >&2
    exit 1
fi

mkdir -p "$OUT_DIR"
TIMESTAMP="$(date +%Y%m%d-%H%M%S)"
ARCHIVE="$OUT_DIR/turtlzim-claude-session-$TIMESTAMP.tar.gz"

GIT_REMOTE="$(git -C "$PROJECT_DIR" remote get-url origin 2>/dev/null || echo "")"
GIT_HEAD="$(git -C "$PROJECT_DIR" rev-parse HEAD 2>/dev/null || echo "")"
GIT_BRANCH="$(git -C "$PROJECT_DIR" rev-parse --abbrev-ref HEAD 2>/dev/null || echo "")"

WORKDIR="$(mktemp -d)"
trap 'rm -rf "$WORKDIR"' EXIT

cat > "$WORKDIR/export-metadata.txt" <<EOF
# Metadata for turtlzim Claude Code session export
export_date=$(date -Iseconds)
exported_from_host=$(hostname)
exported_from_user=$(id -un)
original_project_path=$PROJECT_DIR
original_claude_dir_name=$CLAUDE_DIR_NAME
git_remote=$GIT_REMOTE
git_head=$GIT_HEAD
git_branch=$GIT_BRANCH
EOF

# The "./" prefix matters: the escaped directory name starts with "-"
# (absolute paths start with "/", which becomes "-"), and without it tar
# misparses the bare name as an option flag instead of a file argument.
tar -czf "$ARCHIVE" \
    -C "$(dirname "$CLAUDE_PROJECT_DIR")" "./$(basename "$CLAUDE_PROJECT_DIR")" \
    -C "$WORKDIR" export-metadata.txt

echo "Exported Claude Code session + memory to:"
echo "  $ARCHIVE"
echo
echo "Size: $(du -h "$ARCHIVE" | cut -f1)"
echo
echo "Next steps:"
echo "  1. Transfer this archive to the new computer OUT OF BAND (USB, scp,"
echo "     a private cloud folder) -- it contains your private conversation"
echo "     history, so don't push it to GitHub or anywhere public."
echo "  2. On the new computer, run scripts/import-claude-session.sh against"
echo "     it (that script will also clone the project's git repo)."
