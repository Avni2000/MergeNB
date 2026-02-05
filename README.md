# MergeNB

A VS Code extension for resolving merge conflicts in Jupyter notebooks (`.ipynb` files).

## The Problem

Git doesn't know how to resolve git merge conflicts with Jupyter Notebooks at all. It doesn't even necessary know there ARE any conflicts, least of all where. So, alternate "mergetools" are used to create a specialized UI  

The canonical solution is nbdime, a collection of tools designed just for this purpose; however, it has been buggy and unreliable in my experience. 


> [!IMPORTANT]
> MergeNB is not compatible with nbdime. Running both can produce unpredictable results (e.g., nbdime may insert conflict markers MergeNB cannot handle if it works correctly). Disable or uninstall nbdime when using MergeNB to avoid conflicts.

## Features


MergeNB aims to fix all of that. It features, in no particular order:

(a) 3 way merge interface: each cell is compared across 3 versions, current, incoming, and base (the most common ancestor of current and incoming).

(b) Conflict detection: We parse through each set of cells - and match them with each other across stable index changes - in order to compute a "diff" (conflict) between each of current/incoming/base. This logic allows us to detect conflicts that would otherwise go unnoticed.

![Diff View Example](readme-assets/conflicted.png)


(c) Unmatched Cells: Cells that are unmatched (eg. new cells added in one branch, as well as cells that we can't 100% match across branches) are also shown in the merge interface, allowing users to manually resolve them.

![New unmatched Cells Example](readme-assets/unmatched.png)

*New cell, not in either base or incoming*

![Unmatched cell Example](readme-assets/two_unmatched.png)
*This cell should be matched, but it is >30% different from the other two. This requires manual resolution*


## Extension Settings

- mergeNB.autoResolve.executionCount: Automatically resolve execution count differences by setting `execution_count` to `null`. Default = true

- mergeNB.autoResolve.kernelVersion: Prefer the current kernel/version metadata during resolution. Default = true

- mergeNB.autoResolve.stripOutputs: Strip cell outputs during automatic resolution to avoid output-only conflicts. Default = true

- mergeNB.ui.showCellHeaders: Show per-cell headers (cell index, type, execution count) in the conflict resolver UI. Default = false

This list will remain up-to-date.

## Known Issues

See issues tab :)

## Manual Testing

Your efforts are highly appreciated!

There exists a single full integration test that does the following:

1. Compiles
2. Opens VSCode
3. Runs command to open web notebook resolver
4. Resolves headlessly with playwright, taking incoming/current/deletion and adding modifications based on cell index.
5. Ensures on-disk file corresponds to the resolved cells + nonconflicted cells that a user sees in the web UI. 

At this point, I'm curious about if very large (100s of cells) notebooks are buggy, if you find any rendering issues moving cells around/deleting cells/scrolling fast, how clean the web UI resolution is, and if you have any suggestions which are not already documented in the issues page. 

## Development


```bash
git clone https://github.com/Avni2000/MergeNB.git

cd MergeNB

npm install

npm run compile

# To run the extension in a new VS Code window

code --extensionDevelopmentPath=$(pwd) --new-window /path/to/a/repo/with/merge/conflicts

# to make a .vsix package

npm install -g vsce

vsce package
```
