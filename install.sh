#!/usr/bin/env bash
#
# install.sh — sync the extension(s) in this repo into your USER-scope Copilot
# extensions dir, so code-chain is available in every project with one install.
# Re-run it to "deploy" a new version (it overwrites the installed copy).
#
# Usage:
#   ./install.sh                      Install/update code-chain (user scope)
#   ./install.sh --with-freshness     Also install the branch-freshness helper
#   ./install.sh --all                Install every extension in this repo
#   ./install.sh --gitignore <dir>    Add `.code-chain/` to <dir>/.gitignore
#   ./install.sh --scaffold-constitution <dir>
#                                     Copy a starter CONSTITUTION.md into <dir> (if absent)
#   ./install.sh --list               Show installed vs repo versions
#   ./install.sh --help
#
set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SRC_DIR="$REPO_DIR/.github/extensions"
USER_EXT_DIR="${COPILOT_HOME:-$HOME/.copilot}/extensions"

# Read the integer "version" out of a copilot-extension.json (no jq dependency).
ext_version() {
  local manifest="$1/copilot-extension.json"
  [ -f "$manifest" ] || { echo "?"; return; }
  grep -o '"version"[[:space:]]*:[[:space:]]*[0-9]*' "$manifest" | grep -o '[0-9]*' | head -1
}

install_ext() {
  local name="$1"
  local src="$SRC_DIR/$name"
  local dest="$USER_EXT_DIR/$name"
  if [ ! -d "$src" ]; then
    echo "  ✗ $name — not found in $SRC_DIR" >&2
    return 1
  fi
  mkdir -p "$USER_EXT_DIR"
  rm -rf "$dest"
  cp -R "$src" "$dest"
  echo "  ✓ $name (v$(ext_version "$src")) → $dest"
}

add_gitignore() {
  local dir="$1"
  local gi="$dir/.gitignore"
  if [ ! -d "$dir" ]; then
    echo "  ✗ $dir — not a directory" >&2
    return 1
  fi
  if [ -f "$gi" ] && grep -qxF ".code-chain/" "$gi"; then
    echo "  • $gi already ignores .code-chain/"
    return 0
  fi
  printf '\n# code-chain flight-recorder output\n.code-chain/\n' >> "$gi"
  echo "  ✓ added .code-chain/ to $gi"
}

# Drop a starter CONSTITUTION.md (the project's stack/domain/invariants, which every
# pipeline stage reads) into a target repo, from the template that ships with code-chain.
# Never overwrites an existing one.
scaffold_constitution() {
  local dir="$1"
  local tmpl="$SRC_DIR/code-chain/CONSTITUTION.template.md"
  local dest="$dir/CONSTITUTION.md"
  if [ ! -d "$dir" ]; then
    echo "  ✗ $dir — not a directory" >&2
    return 1
  fi
  if [ ! -f "$tmpl" ]; then
    echo "  ✗ template not found at $tmpl" >&2
    return 1
  fi
  if [ -f "$dest" ]; then
    echo "  • $dest already exists — left untouched"
    return 0
  fi
  cp "$tmpl" "$dest"
  echo "  ✓ wrote starter $dest (fill it in for your project)"
}

list_versions() {
  echo "Extension versions (repo → installed at $USER_EXT_DIR):"
  for src in "$SRC_DIR"/*/; do
    [ -d "$src" ] || continue
    local name installed
    name="$(basename "$src")"
    if [ -d "$USER_EXT_DIR/$name" ]; then
      installed="v$(ext_version "$USER_EXT_DIR/$name")"
    else
      installed="(not installed)"
    fi
    printf "  %-18s v%s → %s\n" "$name" "$(ext_version "$src")" "$installed"
  done
}

WITH_FRESHNESS=false
ALL=false
GITIGNORE_DIRS=()
CONSTITUTION_DIRS=()

while [ $# -gt 0 ]; do
  case "$1" in
    --with-freshness|-f) WITH_FRESHNESS=true; shift ;;
    --all) ALL=true; shift ;;
    --gitignore) GITIGNORE_DIRS+=("$2"); shift 2 ;;
    --scaffold-constitution) CONSTITUTION_DIRS+=("$2"); shift 2 ;;
    --list) list_versions; exit 0 ;;
    --help|-h) sed -n '3,15p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "Unknown option: $1" >&2; exit 2 ;;
  esac
done

echo "Installing code-chain extension(s) at user scope…"
if $ALL; then
  for src in "$SRC_DIR"/*/; do
    install_ext "$(basename "$src")"
  done
else
  install_ext "code-chain"
  $WITH_FRESHNESS && install_ext "branch-freshness"
fi

for dir in "${GITIGNORE_DIRS[@]:-}"; do
  [ -n "$dir" ] && add_gitignore "$dir"
done

for dir in "${CONSTITUTION_DIRS[@]:-}"; do
  [ -n "$dir" ] && scaffold_constitution "$dir"
done

cat <<'EOF'

Done. code-chain is now installed at USER scope and active in every project.

Scope arbitration: a project that vendors its own copy in .github/extensions/
code-chain/ (like this dev repo) WINS — the user-scope copy detects the project
copy and yields, so hooks fire once and logs aren't doubled. Everywhere else, the
user-scope copy runs. No manual per-repo toggling needed.

Reload extensions in any running session to pick up the new version.
EOF
