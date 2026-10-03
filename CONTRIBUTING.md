# Contributing

```bash
npm install        # install dependencies
npm run typecheck  # TypeScript checks
npm test           # unit tests (parsers, SQL helpers, RPG checks, converter)
npm run build      # bundle to dist/
npm run package    # create the .vsix
```

Press **F5** in VS Code to run the extension in an Extension Development Host.

- Keep logic that can be tested without VS Code in pure modules (`src/core`, `src/rpg/parser.ts`, `src/rpg/lint.ts`…) and add tests in `test/`.
- Never commit credentials, host names or customer data.
- Releases: bump `version` in `package.json`, update `CHANGELOG.md`, then push a tag `vX.Y.Z` — the Release workflow builds the `.vsix` and attaches it to a GitHub Release.
