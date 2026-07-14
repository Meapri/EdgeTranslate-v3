# GPT-5.6 Luna page-translation speed research

Date: 2026-07-13  
Scope: OpenAI Responses API, `gpt-5.6-luna`, `reasoning.effort: "none"`, Korean target

## Decision

The requested targets are plausible but are not achieved by the current implementation.

- XDA article target: complete in 10 seconds, zero failed strings.
- Keihan Main Line Wikipedia target: complete in 30 seconds, zero failed strings.

The current live XDA result is 19.3-20.5 seconds, 11 provider requests, and 5 terminally
failed strings. The dominant waste is not reasoning tokens. It is recovery amplification:
two output-limit splits and five semantic retries produce six requests beyond the five-request
first-pass plan. The semantic failures are all protected-identifier validation failures.

Do not raise concurrency alone. It would run the same avoidable failures faster and can increase
provider pressure without improving completion reliability.

## Reproduction evidence

### Current real-provider result

Fixture:
`https://www.xda-developers.com/n100-mini-pcs-quietly-killed-the-raspberry-pi-home-server/`

| Run | End-to-end | Provider requests | Reported tokens | Result |
| --- | ---: | ---: | ---: | --- |
| Luna live 1 | 20,498 ms | 11 | 27,226 | 5 strings failed |
| Luna live 2 | 19,303 ms | 11 | 27,656 | 514/519 translated, 5 failed |

Second-run telemetry:

| Counter | Count | Meaning |
| --- | ---: | --- |
| `output_limit_split` | 2 | A first-pass response reached its output ceiling and had to split. |
| `validation_fail_identifier` | 10 | Five items failed identifier fidelity on the first attempt and recovery. |
| `semantic_retry` | 5 | Those five items consumed a second LLM attempt. |
| `keep_source_terminal` | 5 | Recovery still failed, so source text remained. |
| `warn_accept_script` | 92 | Accepted translations had weak target-script evidence. |
| `warn_accept_echo` | 24 | Accepted short/identifier-like output remained unchanged. |

There were no browser/runtime exceptions. The incomplete result is therefore a translation
protocol/validation problem rather than a DOM crash.

### Current first-pass shape without provider latency

The local deterministic provider measures page extraction and packet planning separately from
network/model latency.

| Page | DOM strings | Provider items | Initial requests | Source characters | Estimated tokens |
| --- | ---: | ---: | ---: | ---: | ---: |
| XDA article | 519 | 299 | 5 | 19,065 | 16,913 |
| Keihan Wikipedia | 2,004 | 1,697 | 27 | 116,501 | 98,189 |

These are planner estimates, not billing values. They show that the banner string count is not
the provider-request count: many DOM targets are coalesced into one structured request.

## Verified current behavior

1. `gpt-5.6-luna` already receives `reasoning: { effort: "none" }` through the model-family
   default. There is no remaining reasoning-effort switch to remove.
2. OpenAI starts at concurrency 3 and grows through AIMD to a cap of 8. The background gate has
   the same cap.
3. The XDA first pass plans five packets, but live recovery expands it to eleven requests.
4. The validator requires every letter-led identifier containing a digit to be byte-exact in the
   translation. Prompt instructions do not guarantee this; Luna changed or omitted five such
   identifiers twice.
5. The planner estimates up to roughly 4,000 output tokens per packet and requests headroom, but
   two Luna responses still ended at the output limit. The estimator has no persisted calibration
   keyed by model and language pair.

## Proposed speed-mode architecture

### P0: make protected tokens local data, not translation work

Before sending text, replace URLs, email addresses, inline code, model identifiers, and other
byte-exact tokens with compact typed placeholders. Keep their exact values in a local map. After
the model responds, validate placeholder inventory and restore values locally.

Example:

```text
source:  The N100 supports DDR4 and 2.5GbE.
wire:    The <k0/> supports <k1/> and <k2/>.
restore: N100, DDR4, 2.5GbE
```

This is generic and page-independent. It prevents the model from corrupting protected tokens,
removes the observed semantic retry class, and can reduce tokens when protected values are long.
Use a namespace that cannot collide with existing DOM placeholders (`<gN>` and `<vN/>`).

Acceptance gate:

- exact placeholder multiset and balance;
- local restoration only, with no LLM repair call;
- property tests covering punctuation, repeated identifiers, URLs, Unicode, and malformed output.

### P0: choose first-pass packets from an output-safe ceiling

The fastest failed request is still wasted time and tokens. Split the initial XDA work into
roughly 7-8 latency-balanced packets instead of allowing five larger packets to hit the output
ceiling. All can fit in the existing OpenAI concurrency cap, so this need not add a second wave.

Do not hardcode a page or Korean-only multiplier. Persist an observed expansion ratio by:

```text
(provider, model, source language, target language, wire codec version)
```

Use a conservative cold-start ceiling, then update it from successful provider receipts. A packet
that reaches the output limit must lower the learned ceiling before the next session.

Acceptance gate: zero `output_limit_split` events on three cold and three warm XDA runs.

### P0: fill the first wave immediately in explicit speed mode

When speed mode is selected, start with:

```text
min(number of ready packets, model/key learned safe concurrency, provider cap)
```

For the XDA plan this means all 7-8 safe packets can start immediately. For the Wikipedia plan it
means eight packets immediately, followed by continuous refill. Retain AIMD reduction on 429,
transient errors, and provider cooldown responses. Persist a bounded safe-concurrency observation
per provider profile instead of rediscovering from 3 on every page.

Acceptance gate: no 429/circuit-open result in a 10-run test; no sequential wave barrier.

### P1: compact the structured reply

Current replies repeat object and field syntax for every item. Benchmark a compact ID-to-string
map against the current item-array codec while retaining strict schema validation.

```json
{"x":{"0":"translation","1":"translation"}}
```

The purpose is to reduce generated output tokens, not just prompt size. OpenAI's latency guidance
states that output generation is usually the dominant latency component and recommends minimizing
structured-output syntax.

An earlier single-packet Terra probe is directional evidence only: the six-item article fixture
used 188 output tokens with the ID-object codec versus 150 with the exact-array codec. That is a
20% output reduction, but one tiny Terra sample cannot establish Luna page-level latency or
quality; the compact-map candidate still needs the A/B gate below.

Acceptance gate: same mapping/validation quality, with at least 10% lower output tokens on the
two target pages. Reject the codec if Luna's schema adherence gets worse.

### P1: Priority processing as an optional paid speed tier

The Responses API accepts `service_tier: "priority"`. OpenAI documents Priority as lower and more
consistent latency than Standard, and current pricing lists Luna Priority at twice the Standard
short-context token price. The response's `service_tier` must be recorded so a downgraded request
is not mistaken for a Priority measurement.

Priority should be tested only after P0 eliminates recovery amplification. Otherwise the benchmark
mostly measures how quickly the system repeats avoidable work.

Acceptance gate: five Standard and five Priority runs per fixture, alternating order, reporting
p50/p95 terminal time, first-translation time, request count, input/output/reasoning tokens,
service tier, and failure classes.

## Timing feasibility

### XDA in 10 seconds

Likely achievable, not yet proven. The current 19.3-second run performs eleven requests even
though the first-pass plan contains five. Removing six recovery requests and starting all safe
first-pass packets together can remove an entire recovery tail. Priority processing provides a
further latency lever if Standard p95 remains above ten seconds.

The target is not considered met until the page completes with zero failed strings in repeated
real-browser runs. A single best-case run is insufficient.

### Wikipedia in 30 seconds

Plausible but higher risk. The current plan has 27 initial requests, so an eight-request cap needs
at least four continuously refilled groups in the worst case. To finish in 30 seconds, the slowest
group must average under roughly 7.5 seconds including network, decoding, validation, and DOM
commit. Compact output, balanced packets, immediate concurrency, and possibly Priority are all
material here.

Do not run the full paid Wikipedia benchmark until XDA has zero output splits and zero semantic
retries. Otherwise a 100K-token-scale run produces a noisy result that cannot validate the final
architecture.

## Benchmark protocol

For every run record these separately:

- total DOM strings, unique provider items, initial packets, recovery packets;
- end-to-end terminal time and first committed translation time;
- per-request start/end/duration and actual returned service tier;
- provider-reported input, cached-input, output, and reasoning tokens;
- output-limit, schema, placeholder, semantic, transport, and terminal-source counters;
- translated/failed/source-kept strings and runtime exceptions.

Run order:

1. Existing Standard baseline, already captured.
2. Protected-token placeholders only.
3. Output-safe packets plus immediate first-wave concurrency.
4. Compact codec A/B.
5. Standard versus Priority A/B.
6. XDA repeated gate.
7. Only after XDA passes, Wikipedia repeated gate.

## Non-solutions

- Sending full HTML: wastes tokens on markup/attributes, increases output corruption risk, and
  makes exact DOM reconciliation harder.
- Prompt-only identifier preservation: already failed twice for five items; byte-exact data must
  be protected locally.
- Unbounded concurrency: does not repair output-limit or semantic failures and can trigger rate
  limiting.
- Raising `max_output_tokens` alone: a model's theoretical 128K maximum does not make very large
  structured responses faster or safer; smaller parallel outputs reduce tail risk.
- Retrying every validation failure: deterministic local repair should precede any paid retry,
  and truly unsafe output should keep source rather than loop.

## Sources

- OpenAI GPT-5.6 Luna model page: https://developers.openai.com/api/docs/models/gpt-5.6-luna
- OpenAI latency optimization guide: https://developers.openai.com/api/docs/guides/latency-optimization
- OpenAI Priority processing guide: https://developers.openai.com/api/docs/guides/priority-processing
- OpenAI API pricing: https://developers.openai.com/api/docs/pricing

## Secret handling note

The live key was supplied at runtime only. It was not written to this repository or the benchmark
artifact directory. Revoke the exposed key after testing and use a fresh key through local secret
storage for subsequent runs.
