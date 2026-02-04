#!/usr/bin/env bash
set -euo pipefail

# Minimal script to create a throwaway git repo, produce a UU merge conflict
# for a notebook (using the provided test files), and open VS Code with the
# throwaway repo and the extension host file `dist/extension.js`.

# The goal is to make a cli tool that allows us to test more thouroughly at some point (and allow cli resolutions in general),
# but for now this is a quick way to manually test the extension in a UU conflict state

# Parse flags: -02, -03, or -04 to select test suite (default: 02)
TEST_SUITE="02"
while [[ $# -gt 0 ]]; do
  case "$1" in
    -02)
      TEST_SUITE="02"
      shift
      ;;
    -03)
      TEST_SUITE="03"
      shift
      ;;
    -04)
      TEST_SUITE="04"
      shift
      ;;
    *)
      echo "Unknown flag: $1"
      echo "Usage: $0 [-02|-03|-04]"
      exit 1
      ;;
  esac
done

cd ~/source/repos/MergeNB

# Only compile if sources changed since last compilation
if ! command -v npm >/dev/null 2>&1; then
  echo "npm not found; skipping compilation"
else
  if [ ! -d dist ]; then
    echo "dist/ not found; running npm run compile"
    npm run compile
  else
    newest_src=0
    # newest tracked source file mtime (exclude dist and node_modules)
    while IFS= read -r -d '' f; do
      [ -f "$f" ] || continue
      m=$(stat -c %Y "$f" 2>/dev/null || stat -f %m "$f" 2>/dev/null || echo 0)
      [ "$m" -gt "$newest_src" ] && newest_src=$m
    done < <(git ls-files -z | tr '\n' '\0' | xargs -0 -n1 printf '%s\0' 2>/dev/null | grep -z -E -v '^dist/|^node_modules/' || true)

    newest_dist=0
    while IFS= read -r -d '' f; do
      m=$(stat -c %Y "$f" 2>/dev/null || stat -f %m "$f" 2>/dev/null || echo 0)
      [ "$m" -gt "$newest_dist" ] && newest_dist=$m
    done < <(find dist -type f -print0 2>/dev/null || true)

    if [ "$newest_dist" -ge "$newest_src" ] && [ "$newest_src" -gt 0 ]; then
      echo "No source changes since last compile; skipping npm run compile"
    else
      echo "Source changes detected (or no compiled files); running npm run compile"
      npm run compile
    fi
  fi
fi

# Auto-close any running VS Code instances that have open folders/files in /tmp
# (find processes with "code" in the command line and "/tmp/" in the args,
# then try graceful TERM, then KILL if needed)
if command -v ps >/dev/null 2>&1; then
mapfile -t _code_pids < <(ps -eo pid=,comm=,args= | awk '$2 ~ /^[Cc]ode$/ && /\/tmp\// {print $1}' | sort -u)
  if [ "${#_code_pids[@]}" -gt 0 ]; then
    echo "Closing VS Code instances with open items in /tmp: ${_code_pids[*]}"
    for _pid in "${_code_pids[@]}"; do
      kill -TERM "$_pid" 2>/dev/null || true
    done
    sleep 2
    for _pid in "${_code_pids[@]}"; do
      if kill -0 "$_pid" 2>/dev/null; then
        echo "Force killing VS Code pid $_pid"
        kill -KILL "$_pid" 2>/dev/null || true
      fi
    done
  fi
else
  echo "ps not available; skipping auto-close of VS Code in /tmp"
fi

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TMPDIR="$(mktemp -d /tmp/mergeNB-throwaway-XXXXXX)"

echo "Creating throwaway repo at: $TMPDIR"
echo "Using $TEST_SUITE conflict test files"
# Choose test set: prefer interactive `gum` chooser, fallback to defaults
if command -v gum >/dev/null 2>&1; then
  echo "Select test set (use arrow keys or type to filter):"
  CHOICE=$(gum choose "02" "03" "04")
  if [[ -z "$CHOICE" ]]; then
    echo "No selection made; falling back to default based on conflict type."
  fi
else
  echo "'gum' CLI not found. Identify test \"02\", \"03\", or \"04\" as a parameter."
  CHOICE="$TEST_SUITE"
fi

# If CHOICE is still empty for any reason, ensure a safe default
if [[ -z "${CHOICE:-}" ]]; then
  CHOICE="02"
fi

BASE_FILE="${CHOICE}_base.ipynb"
CURRENT_FILE="${CHOICE}_current.ipynb"
INCOMING_FILE="${CHOICE}_incoming.ipynb"
echo "Using test set: $CHOICE -> $BASE_FILE, $CURRENT_FILE, $INCOMING_FILE"

# Copy the three provided notebook versions into the temp repo
cp "$ROOT/test/$BASE_FILE" "$TMPDIR/$BASE_FILE"
cp "$ROOT/test/$CURRENT_FILE" "$TMPDIR/$CURRENT_FILE"
cp "$ROOT/test/$INCOMING_FILE" "$TMPDIR/$INCOMING_FILE"

cd "$TMPDIR"
git init -q
git config user.email "merge-conflict@gmail.com"
git config user.name "MergeNB Test"

# Create base commit
cp "$BASE_FILE" conflict.ipynb
git add conflict.ipynb
git commit -m "base" -q

# Determine the name of the initial branch (could be 'master' or 'main')
BASE_BRANCH=$(git rev-parse --abbrev-ref HEAD)

# Create and commit current branch
git checkout -b current
cp "$CURRENT_FILE" conflict.ipynb
git add conflict.ipynb
git commit -m "current" -q

# Create incoming branch from base
git checkout "$BASE_BRANCH"
git checkout -b incoming
cp "$INCOMING_FILE" conflict.ipynb
git add conflict.ipynb
git commit -m "incoming" -q

# Merge incoming into current to produce a conflict (status UU)
git checkout current
set +e
git merge incoming
MERGE_EXIT=$?
set -e

echo
echo "git merge exit code: $MERGE_EXIT"
echo "Repository created at: $TMPDIR"
echo
echo "Git status (porcelain):"
git status --porcelain

echo
echo "Conflicted files (look for lines starting with 'UU'):" 
git status --porcelain | grep '^UU' || true

echo
echo "Opening VS Code in extension development mode with the throwaway repo"
echo "  code --extensionDevelopmentPath=\"$ROOT\" --new-window \"$TMPDIR\" "
if command -v code >/dev/null 2>&1; then
  code --extensionDevelopmentPath="$ROOT" --new-window "$TMPDIR"
else
  echo "VS Code CLI 'code' not found. Run the following to open manually:"
  echo
  echo "  code --extensionDevelopmentPath=\"$ROOT\" --new-window \"$TMPDIR\" "
fi

echo
echo "Done."
