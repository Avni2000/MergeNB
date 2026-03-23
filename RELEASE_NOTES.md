## What's Changed

- [FIX] handle what happens when base exists (3cd563b)
- [FIX] reuse precomputed line segments for syntax + diff highlighting. (16f19b9)
- [FIX] lower max syntax tree highlighting timeout (7e57c90)
- [FIX] rm bad language keys from cache on error (854a385)
- [FIX] Narrow Dragging -> Text selection - It narrows when we enter the “dragging” state to real content selection and adds a safety reset if the window loses focus. That helps avoid “stuck dragging” behavior and avoids special scroll handling when the user clicks unrelated UI. (db0af81)
- [TEST] Update syntaxHighlightingTest to use new syntax highlighting logic (6d95dd1)
- [FIX] precompute position maps for DOM fragments (5b0307b)
- [FIX] replaced `dangerouslySetInnerHTML` with DOM fragment rendering - build `span` nodes from the token list, and replaceChildren(fragment) on the `<code>` element - DOM-native and safer (fe6a4f5)
- [FIX] remove class highlighter extension (a0d9086)
- [FIX] preserve syntax highlighting (02eae7c)
- [TEST] Don't use tanstack for tests at all - Overscans to infinity and removes virtualization so playwright tests can see full DOM (c802837)
- [FIX] Harden kernel string parsing (2c58497)
- [TEST] update settings regression matrix test to match logic changes (6bc5084)
- [FIX] multiple logical fixes in `conflictDetector.ts` - only create conflict when current != incoming AND (instead of OR) (cur differs from base AND inc differs from base) (f4e067f)
- [FIX] Nested Markdown Conflict Cells (16ac3c5)
- [FIX] selection in conflicted markdown cells - removed extraneous solution and overflow:clip (b604acc)
- [FIX] browser selection survives scrolling/virtualization (e7919f2)
- [WIP] intuitive text selection on mouse drag (3b188d7)

**Full Changelog**: https://github.com/Avni2000/MergeNB/compare/0.1.0...0.1.1
