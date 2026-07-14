# EdgeTranslate Translators

This workspace contains the translator implementations used by the EdgeTranslate extension.
The current package exports translator classes and result types; it does not export a global
`TRANSLATORS` registry.

For the full runtime architecture, provider modes, cache layers, and safe-change checklist, see
the repository [Developer Guide](../../docs/DEVELOPMENT_GUIDE.md).

## Build and test

Run from the repository root:

```bash
npm run build -w @edge_translate/translators
npm test -w @edge_translate/translators -- --runInBand
```

The build produces ES, UMD, and IIFE bundles plus TypeScript declarations under `dist/`. The
extension Webpack config aliases `@edge_translate/translators` to the generated ES bundle, so
build this workspace before building the extension directly.

## Basic usage

```javascript
import { GoogleTranslator } from "@edge_translate/translators";

const translator = new GoogleTranslator();
const result = await translator.translate("hello", "en", "ko");
console.log(result.mainMeaning);
```

Exports include:

-   `GoogleTranslator`
-   `BingTranslator`
-   `DeepLTranslator`
-   `HybridTranslator`
-   `LocalTranslator`
-   `LANGUAGES`
-   shared translation result and error types

`HybridTranslator`, `DeepLTranslator`, and some browser-facing features require adapters or
browser APIs supplied by the extension runtime. See their tests and the construction logic in
`packages/EdgeTranslate/src/background/library/translate.js` before using them independently.

## Local/AI provider modes

`LocalTranslator` currently supports:

-   Chrome on-device mode (`chromeBuiltin`)
-   Google AI Studio (`googleAiStudio`)
-   OpenAI (`openai`)
-   OpenAI-compatible chat-completions servers (`openaiCompatible`)

Provider behavior differs for selection, dictionary, page, and realtime-caption profiles. Add
tests for both streaming and non-streaming behavior when changing a provider.

The page profile uses the lean `seg-v6-semantic` marker contract. Ordinary text uses compact
markers; standard table rows and sibling list runs may carry fixed-length JSON string arrays under
`:row`/`:list` markers. This is text IR, not page HTML regeneration. It must never enter dictionary
JSON mode, even for a one-word compact payload such as `[[1]]\nHome`. Generic provider backoff is
reduced to one jittered retry for page 429/5xx errors; page timeouts are never retried in the
provider. Structured failure metadata prevents the content controller from retrying an already
exhausted transport/provider failure, while context-size splitting and missing-leaf repair remain
bounded controller responsibilities. Truncated page replies return only complete marker prefixes
instead of regenerating the full payload. A zero-prefix single-marker truncation gets one fresh-
deadline larger-budget recovery only when the provider exposes a real output cap; multi-marker
zero-prefix failures are structurally split by the controller. `SAFETY`, `RECITATION`,
`content_filter`, and other abnormal terminal finish reasons surface as `PAGE_OUTPUT_BLOCKED`, not
as successful or salvageable translations.

OpenAI streams request the final usage chunk. When any provider omits usage, each request attempt
falls back to a conservative estimate based on the exact system/user prompts and raw generated
output. Such usage is marked `estimated`, includes failed/retried attempts, and is never stored in
translation caches (cache hits must not replay historical spend). Concurrent callers that join one
in-flight provider request receive the same translation/error but not another copy of its usage;
the request owner is the single accounting owner.
