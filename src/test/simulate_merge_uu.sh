#!/usr/bin/env bash
set -euo pipefail

# Minimal script to create a throwaway git repo, produce a UU merge conflict
# for a notebook (using the provided test files), and open VS Code with the
# throwaway repo and the extension host file `dist/extension.js`.

# The goal is to make a cli tool that allows us to test more thouroughly at some point (and allow cli resolutions in general),
# but for now this is a quick way to manually test the extension in a UU conflict state

cd ~/source/repos/MergeNB

npm run compile

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
TMPDIR="$(mktemp -d /tmp/mergeNB-throwaway-XXXXXX)"

echo "Creating throwaway repo at: $TMPDIR"

# Copy the three provided notebook versions into the temp repo
cp "$ROOT/src/test/02_base.ipynb" "$TMPDIR/02_base.ipynb"
cp "$ROOT/src/test/02_current.ipynb" "$TMPDIR/02_current.ipynb"
cp "$ROOT/src/test/02_incoming.ipynb" "$TMPDIR/02_incoming.ipynb"

cd "$TMPDIR"
git init -q
git config user.email "merge-conflict@gmail.com"
git config user.name "MergeNB Test"

# Create base commit
cp 02_base.ipynb notebook.ipynb
git add notebook.ipynb
git commit -m "base" -q

# Determine the name of the initial branch (could be 'master' or 'main')
BASE_BRANCH=$(git rev-parse --abbrev-ref HEAD)

# Create and commit current branch
git checkout -b current
cp 02_current.ipynb notebook.ipynb
git add notebook.ipynb
git commit -m "current" -q

# Create incoming branch from base
git checkout "$BASE_BRANCH"
git checkout -b incoming
cp 02_incoming.ipynb notebook.ipynb
git add notebook.ipynb
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
echo "Opening VS Code in extension development mode with the throwaway repo and dist/extension.js..."
if command -v code >/dev/null 2>&1; then
  code --extensionDevelopmentPath="$ROOT" --new-window "$TMPDIR"
else
  echo "VS Code CLI 'code' not found. Run the following to open manually:"
  echo
  echo "  code --extensionDevelopmentPath=\"$ROOT\" --new-window \"$TMPDIR\" "
fi

echo
echo "Done."
