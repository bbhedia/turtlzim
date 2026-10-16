#!/usr/bin/env bash
# Recompile le document de suivi (docs/suivi/suivi.tex -> suivi.pdf) avec tectonic, qui s'installe sans root :
#   curl -fsSL -o /tmp/t.tgz "https://github.com/tectonic-typesetting/tectonic/releases/download/tectonic%400.17.0/tectonic-0.17.0-x86_64-unknown-linux-musl.tar.gz"
#   mkdir -p ~/.local/bin && tar -xzf /tmp/t.tgz -C ~/.local/bin tectonic
# Écrit d'abord version.tex (le dernier commit et sa date), que le document affiche en en-tête. Se lance depuis n'importe où.
set -euo pipefail
cd "$(dirname "$0")/.."
tectonic_bin=$(command -v tectonic || true)
[ -n "$tectonic_bin" ] || tectonic_bin="$HOME/.local/bin/tectonic"
[ -x "$tectonic_bin" ] || { echo "tectonic est introuvable : voir l'en-tête de ce script pour l'installer sans root" >&2; exit 1; }

mois=(janvier février mars avril mai juin juillet août septembre octobre novembre décembre)
jour=$(date +%-d); m=${mois[$(( $(date +%-m) - 1 ))]}; an=$(date +%Y)
hash=$(git log -1 --format=%h 2>/dev/null || echo "?")
dirty=""; git diff --quiet HEAD -- 2>/dev/null || dirty="+"
printf '\\newcommand{\\versiondate}{%s %s %s}\n\\newcommand{\\versionhash}{%s%s}\n' "$jour" "$m" "$an" "$hash" "$dirty" > docs/suivi/version.tex

cd docs/suivi
"$tectonic_bin" -X compile --keep-logs suivi.tex 2>&1 | grep -vE '^note: (downloading|Skipped)' || true
[ -s suivi.pdf ] || { echo "le PDF n'a pas été produit" >&2; exit 1; }
rm -f suivi.log suivi.aux suivi.out 2>/dev/null || true
echo "docs/suivi/suivi.pdf : $(du -h suivi.pdf | cut -f1)"
