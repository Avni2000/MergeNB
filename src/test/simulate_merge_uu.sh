#!/usr/bin/env bash
set -euo pipefail

# Minimal script to create a throwaway git repo, produce a UU merge conflict
# for a notebook (using the provided test files), and open VS Code with the
# throwaway repo and the extension host file `dist/extension.js`.

# The goal is to make a cli tool that allows us to test more thouroughly at some point (and allow cli resolutions in general),
# but for now this is a quick way to manually test the extension in a UU conflict state

# Parse flags: -textual or -semantic (default: semantic)
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

npm run compile

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
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
  echo "'gum' CLI not found. Identify test "02", "03", or "04" as a parameter."
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
cp "$ROOT/src/test/$BASE_FILE" "$TMPDIR/$BASE_FILE"
cp "$ROOT/src/test/$CURRENT_FILE" "$TMPDIR/$CURRENT_FILE"
cp "$ROOT/src/test/$INCOMING_FILE" "$TMPDIR/$INCOMING_FILE"

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
