# Contributing

Help me make MergeNB better by making an issue or writing some code!

While AI can write really fantastic code (at times), I hope you do some critical thinking and write up PRs/comments by hand because I have no interest in talking to a chatbot. I think a good benchmark for PR effort is some indication that you should have come away with a good understanding of the code you have written.

## Development

To load the extension in a development VS Code window, run:

```bash 
npm run compile && code --extensionDevelopmentPath=. --new-window <folder with tester notebooks>
```

There's also a `launch` configuration in VS Code that does this for you, as well as hot-reloading on file changes, but it's never worked for me.


## Testing

```bash
# Interactive TUI picker
npm run test

# Everything
npm run test:all

# Resolver UI integration tests
npm run test:pw

# VS Code extension-host tests
npm run test:vscode

# Full end-to-end resolution flow
npm run test:e2e
```

I have scraped 13 Jupyter Notebooks with various merge conflicts from the Tensorflow docs for use in testing, along with a few handmade toy fixtures.

> [!TIP]
> Prefer Playwright tests for browser-facing code and, more generally, because they parallelize easily in CI. Use the VS Code testing host for verifying data shapes, settings, and other behind-the-scenes behavior.