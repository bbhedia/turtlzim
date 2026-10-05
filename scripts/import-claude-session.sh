#!/usr/bin/env bash
# Import a turtlzim Claude Code session archive (produced by
# scripts/export-claude-session.sh) on a new computer: clones the project's
# git repo, then restores the conversation history/memory so `claude` can
# resume right where it left off -- even though this machine's username/home
# path is almost certainly different from the one the export came from.
#
# Usage:
#   scripts/import-claude-session.sh <archive.tar.gz> [destination-dir]
#
# destination-dir defaults to ./turtlzim (created under the current
# directory). If it already exists, the script assumes the repo is already
# cloned there and only restores the session/memory state.

set -euo pipefail

if [ $# -lt 1 ]; then
    echo "usage: $0 <archive.tar.gz> [destination-dir]" >&2
    exit 1
fi

ARCHIVE="$1"
DEST_DIR="${2:-./turtlzim}"

if [ ! -f "$ARCHIVE" ]; then
    echo "error: archive not found: $ARCHIVE" >&2
    exit 1
fi

WORKDIR="$(mktemp -d)"
trap 'rm -rf "$WORKDIR"' EXIT

tar -xzf "$ARCHIVE" -C "$WORKDIR"

META="$WORKDIR/export-metadata.txt"
if [ ! -f "$META" ]; then
    echo "error: archive is missing export-metadata.txt -- is this a valid export?" >&2
    exit 1
fi
# shellcheck disable=SC1090
source "$META"

echo "Archive metadata:"
echo "  exported from : ${exported_from_user:-?}@${exported_from_host:-?} on ${export_date:-?}"
echo "  original path : ${original_project_path:-?}"
echo "  git remote    : ${git_remote:-<none recorded>}"
echo "  git HEAD      : ${git_head:-?} (branch: ${git_branch:-?})"
echo

if [ -d "$DEST_DIR/.git" ]; then
    echo "Destination $DEST_DIR already looks like a git repo -- skipping clone."
else
    if [ -z "${git_remote:-}" ]; then
        echo "error: no git remote recorded in the archive, and $DEST_DIR isn't a repo yet." >&2
        echo "Clone it yourself first, then re-run this script with that path." >&2
        exit 1
    fi
    echo "Cloning $git_remote into $DEST_DIR ..."
    git clone "$git_remote" "$DEST_DIR"
    if [ -n "${git_head:-}" ]; then
        if ! git -C "$DEST_DIR" merge-base --is-ancestor "$git_head" HEAD 2>/dev/null \
           && [ "$(git -C "$DEST_DIR" rev-parse HEAD)" != "$git_head" ]; then
            echo "note: cloned HEAD differs from the exported HEAD ($git_head)." \
                 "The remote has likely moved on since export -- that's normal, not an error."
        fi
    fi
fi

DEST_ABS="$(cd "$DEST_DIR" && pwd)"
NEW_CLAUDE_DIR_NAME="$(printf '%s' "$DEST_ABS" | tr '/' '-')"
NEW_CLAUDE_PROJECT_DIR="$HOME/.claude/projects/$NEW_CLAUDE_DIR_NAME"

OLD_SESSION_DIR="$WORKDIR/${original_claude_dir_name:?missing in metadata}"
if [ ! -d "$OLD_SESSION_DIR" ]; then
    echo "error: expected session directory not found in archive: $original_claude_dir_name" >&2
    exit 1
fi

if [ -e "$NEW_CLAUDE_PROJECT_DIR" ]; then
    echo "error: $NEW_CLAUDE_PROJECT_DIR already exists -- refusing to overwrite." >&2
    echo "Remove or rename it first if you really want to replace it." >&2
    exit 1
fi

mkdir -p "$(dirname "$NEW_CLAUDE_PROJECT_DIR")"
mv "$OLD_SESSION_DIR" "$NEW_CLAUDE_PROJECT_DIR"

echo
echo "Restored Claude Code session + memory to:"
echo "  $NEW_CLAUDE_PROJECT_DIR"
echo
echo "Project cloned at:"
echo "  $DEST_ABS"
echo
echo "=================================================================="
echo "Next steps"
echo "=================================================================="
echo "1. Continue the conversation:"
echo "     cd '$DEST_ABS'"
echo "     claude --continue      # or: claude --resume, then pick the session"
echo
echo "2. Set up the toolchain on this machine (see CLAUDE.md for details)."
echo "   User-local installs (no sudo needed), safe to run now:"
echo
echo "     curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh"
echo "     source \"\$HOME/.cargo/env\""
echo "     rustup target add wasm32-unknown-unknown"
echo "     cargo install wasm-pack"
echo "     curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.39.7/install.sh | bash"
echo "     export NVM_DIR=\"\$HOME/.nvm\" && . \"\$NVM_DIR/nvm.sh\" && nvm install --lts"
echo
echo "   System packages needing sudo (run yourself, adjust for your"
echo "   package manager if not Debian/Ubuntu-based):"
echo
echo "     sudo apt-get install -y build-essential pkg-config libssl-dev libsodium-dev clang llvm"
echo
echo "   (build-essential = C compiler/linker/make: every native build needs it,"
echo "   even 'cargo check' for wasm32, because proc-macros and build scripts link"
echo "   natively. clang + llvm = the wasm32 C toolchain for the web build's bundled"
echo "   SQLite -- see docs/wasm-port-plan.md section 2.2.1. SQLite dev headers are"
echo "   NOT needed -- the native crate builds its own via the 'sqlite-static'"
echo "   cargo feature.)"
echo
echo "3. Sanity-check the native core still builds/tests clean here:"
echo "     cd '$DEST_ABS/core/turtl-core-rs'"
echo "     cp config.yaml.default config.yaml"
echo "     cargo build --features sqlite-static && cargo test --features sqlite-static"
echo "=================================================================="
