# vNext ship gates

The offline Gate A runner drives the production vNext collector, block IR, packet planner,
scheduler, validator, CAS committer, mutation watcher, and usage ledger against deterministic
`jsdom` fixtures. It never opens the network or calls a paid provider.

```sh
node tools/vnext-gates/run-gate-a.cjs
```

The command prints exactly one JSON report to stdout and exits with:

-   `0`: every Gate A assertion passed;
-   `1`: the harness ran but one or more gate assertions failed;
-   `2`: the harness itself could not run.

Use `--output=/absolute/or/relative/report.json` to persist the same report. No report file is
created by default, so normal CI runs do not dirty the checkout.

The fixture corpus covers ordinary prose, tables, interactive links, reordered inline tags,
RTL text, allowlisted attributes, SPA late insertion, attribute-only mutation, explicit
incomplete accounting, and missing provider usage. The report includes DOM/placeholder
invariants, wrong-target count, completion and failed-string counts, HTTP/packet counts,
receipt de-duplication, estimated fallback spend, and a token-formula pin comparison.

The large deterministic case contains 3,000 DOM Text nodes grouped into 600 semantic blocks and
reports the resulting packet compression without imposing a page-specific 30-packet hard cap.
Recovery checks also hold request IDs constant and inspect the actual OpenAI Responses,
OpenAI-compatible Chat, and Gemini prompt bodies; changing only an attempt ID cannot pass.

Gate A is deliberately offline. It proves structural behavior, not live translation quality,
latency, or provider cost. The current routing state, exact-adapter smoke evidence, stable
rollback, and still-unexecuted live/human Gates C-F are tracked in
[`docs/AI_PAGE_TRANSLATION_VNEXT.md`](../../docs/AI_PAGE_TRANSLATION_VNEXT.md). Passing Gate A
alone must never be reported as passing those live gates.
