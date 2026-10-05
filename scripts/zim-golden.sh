#!/usr/bin/env bash
# Golden-file round trips for core/zim-format against REAL Zim pages (CLAUDE.md: Zim .txt
# round-trips must be byte-identical).
#
# The pages are never copied into this repository (Zim is GPLv2; see the module docs of
# core/zim-format/tests/golden_real_notebooks.rs). With no arguments this keeps a shallow
# checkout of the Zim project in ~/.cache/turtlzim-labs/ (cloned on first use) and checks every
# page in it: the user manual (a real 81-page notebook), the website, and Zim's own edge cases.
# Give directories to check your own notebooks instead:
#
#     scripts/zim-golden.sh ~/Notebooks/Work ~/Notebooks/Home
#
# Needs cargo (and git plus network access for the first clone). Re-running is harmless.
set -euo pipefail
cd "$(dirname "$0")/.."

if [ "$#" -gt 0 ]; then
    corpus=$(IFS=:; echo "$*")
else
    checkout="$HOME/.cache/turtlzim-labs/zim-desktop-wiki"
    if [ ! -d "$checkout/.git" ]; then
        mkdir -p "$(dirname "$checkout")"
        git clone --depth 1 --branch release https://github.com/zim-desktop-wiki/zim-desktop-wiki "$checkout"
    fi
    corpus=$checkout
fi

# --release: the damaged-variants check parses ~16,000 pages, which takes a minute unoptimized.
ZIM_GOLDEN_DIR=$corpus cargo test -p zim-format --release --test golden_real_notebooks -- --ignored --nocapture
