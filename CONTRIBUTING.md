# Contributing to EdgeTranslate-v3

Thanks for helping improve EdgeTranslate-v3.

The source of truth for repository structure, runtime architecture, browser differences,
testing, and safe-change checklists is the
[Developer Guide](./docs/DEVELOPMENT_GUIDE.md).

## Setup

Use the repository root:

```bash
npm ci
npm test
npm run build:chrome
```

CI uses Node.js 22. Local development should use Node.js 22.13 or newer, or Node.js 24 or
newer, to satisfy the current `pdfjs-dist` engine requirement. The repository does not
currently pin an exact npm version.

## Development builds

The extension consumes the generated translators bundle. When editing both workspaces, run
the translator watcher and the extension watcher in separate terminals:

```bash
npm run dev -w @edge_translate/translators
npm run dev:chrome -w edge_translate
```

Firefox and Safari:

```bash
npm run dev:firefox -w edge_translate
npm run dev:safari -w edge_translate
```

## Production builds and packages

```bash
npm run build:chrome
npm run build:firefox
npm run build:safari

npm run pack:chrome -w edge_translate
npm run pack:firefox -w edge_translate
npm run lint:firefox
```

`build:safari` creates the web-extension output only. Before opening the Xcode project, sync it:

```bash
npm run safari:sync -w edge_translate
```

## Tests

```bash
# All workspaces
npm test

# Focused Jest runs
npm test -w edge_translate -- --runInBand
npm test -w @edge_translate/translators -- --runInBand
```

Browser E2E tests require a built target and browser-compatible WebDriver:

```bash
npm run build:chrome
npm run e2e:chrome -w edge_translate
```

See the Developer Guide before changing page translation, persistent cache keys, manifests,
PDF routing, or provider prompts. Those areas have cross-context and cross-browser contracts
that are not visible from a single file.

## Pull requests

-   Keep each change focused and rollbackable.
-   Add or update tests for behavior changes.
-   Report exactly which browser targets and live journeys were verified.
-   Do not claim browser E2E coverage when only unit tests ran.
-   Keep package, manifest, lockfile, and Safari version metadata aligned for releases.
-   Use Conventional Commit style; a Husky `commit-msg` hook is configured to run `commitlint`.

The active integration branch is `main`. Older documentation that refers to `master`,
`develop`, or `fftf` describes the original project and is not the current branch policy.
