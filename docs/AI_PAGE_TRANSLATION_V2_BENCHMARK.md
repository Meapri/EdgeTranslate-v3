> **HISTORICAL** — superseded by AI_PAGE_TRANSLATION_VNEXT.md; kept for archaeology.

# AI 페이지 번역 V2 POC·벤치마크 명세

> **역사 benchmark 문서 — 현재 release gate가 아님.** 여기에 기록된 V2 POC 수치와
> synthetic token은 vNext의 실제 품질·비용 증거가 아니다. 현재 gate와 검증 명령은
> [vNext 운영 계약](./AI_PAGE_TRANSLATION_VNEXT.md#12-검증-명령)과
> `tools/vnext-gates/`를 따른다.
>
> 기준일: 2026-07-13
>
> 상위 설계: [AI 페이지 번역 V2 설계서](./AI_PAGE_TRANSLATION_V2_DESIGN.md)

이 문서는 “더 좋아 보인다”는 인상으로 V2 프로토콜과 packet 크기를 고르지 않기 위한
검증 계약이다. 모든 절감률과 품질 결론은 같은 corpus, 같은 provider/model, 같은 언어쌍,
같은 실행 조건의 결과 파일에서만 주장한다.

현재 `npm run bench:ai-page:v2`는 synthetic fixture의 wire/schema 구조 오버헤드만 비교하는
offline runner다. 결과는 전부 `client-estimated`이며 실제 provider token, 비용, 품질,
latency 증거가 아니다. `--json`을 붙일 때만 상세 JSON을 출력한다.
ID-object 후보는 persistent target ID 대신 packet-local base36 alias와 compact key를 사용해
안전한 ID mapping의 반복 비용을 줄인다.

`npm run bench:ai-page:v2:live -- --url=<public URL>`은 공개 HTML을 받아 production V2
collector/unitizer/admission/planner를 그대로 실행하는 무과금 structural runner다. LLM을 호출하지
않으며 출력의 `usageSource`는 항상 `client-estimated`다. 임의 URL을 받으므로 특정 사이트 selector
회귀를 만들지 않고, raw HTML이나 페이지 본문을 저장소에 저장하지 않는다.

### 2026-07-13 京阪本線 live structural run

다음 값은 실제 공개 HTML을 받은 무과금 구조 측정이며 번역 품질·provider usage 증거가 아니다.
실행 URL은 사용자가 제시한 [京阪本線 문서](https://ja.wikipedia.org/wiki/%E4%BA%AC%E9%98%AA%E6%9C%AC%E7%B7%9A)다.

| 항목                           |                                값 |
| ------------------------------ | --------------------------------: |
| raw HTML                       |                   1,024,848 chars |
| 방문 DOM node                  |                            21,060 |
| 수집 target                    |                             5,818 |
| source+role dedupe             |                             2,252 |
| unique target                  |                             3,566 |
| semantic unit                  |                             1,389 |
| 초기 8K input admission        |           576 units / 643 targets |
| viewport deferred              |  813 units / 2,923 unique targets |
| 초기 planned generation packet |                                 2 |
| 초기 hard-budget reservation   | 약 14,772 client-estimated tokens |
| 수집+계획 시간                 |            약 662 ms (Node/JSDOM) |

기본 조건은 `array-exact`, input capability 32,768, output capability 4,096, session hard budget
24,000이다. browser layout이 없는 JSDOM이므로 viewport 수치와 시간은 실제 Chrome UX 수치가
아니다. 중요한 구조 결과는 초기 target만 generation packet으로 계획되고, 나머지는
스크롤 입장 전에는 전송되지 않는다는 점이다. provider가 실제 schema/quality/latency gate를
통과하기 전에는 이 값을 “1요청으로 완역” 또는 “14K 실제 토큰”으로 표현하면 안 된다.

초기 측정은 visible text와 완전히 같은 `title`/`aria-label`도 역할이 다르다는 이유로 별도
provider target으로 잡았다. generic accessible-name 재사용을 적용해 raw DOM 위치 5,818개는
그대로 보존하면서 unique target을 4,110에서 3,566, semantic unit을 1,933에서 1,389로 줄였다.
속성 번역을 버린 것이 아니라 한 번 번역한 값을 보이는 text와 동일한 접근성 속성에 함께 적용한다.

구현된 자동 검증은 provider adapter가 generation을 정확히 한 번만 호출하는지, 429를 내부
재시도하지 않는지, duplicate/unknown/missing ID를 격리하는지, usage를 중복 합산하지 않는지,
취소가 실제 fetch signal을 abort하는지, cache/inflight 재사용이 0회 과금으로 기록되는지,
DOM source 변경 시 compare-and-swap이 적용을 막는지까지 포함한다. 실제 API key가 없는 환경의
mock 결과를 provider 품질·비용 증거로 사용하지 않는다.

### 2026-07-13 built Chrome local-provider smoke

`npm run build:chrome && npm run smoke:ai-page:v2:chrome`는 빌드 산출물을 격리된 Chrome for
Testing 프로필에 로드하고, 로컬 HTTP fixture와 OpenAI-compatible stub 사이의 실제 extension
content -> background -> adapter -> HTTP -> commit 경로를 실행한다. 외부 provider 호출과 비용은
없다.

| 항목                         |                                            값 |
| ---------------------------- | --------------------------------------------: |
| browser                      |              Chrome for Testing 149.0.7827.55 |
| Node                         |                                       24.18.0 |
| 번역 target item             |                                           182 |
| 실제 HTTP generation request |                                             4 |
| request당 평균 item          |                                          45.5 |
| stub provider-reported token |                                         6,270 |
| banner                       |                    `6.3K tokens · 4 requests` |
| 완료 상태                    |                `Translation complete`, `100%` |
| SPA 후발 content             |                                     번역 성공 |
| DOM invariant                | href/data/value/focus/selection/listener 보존 |
| runtime exception            |                                             0 |

이 실행은 “항목마다 한 요청”이 아니라 semantic packet으로 묶이는지와, provider usage ledger가
배너까지 손실 없이 전달되는지를 증명한다. stub의 번역은 품질 평가용이 아니므로 이 수치로
OpenAI/Gemini 품질·실제 비용·실제 token 절감률을 주장하지 않는다.

### 2026-07-13 실제 provider P1·P2 예비 실측

사용자가 명시적으로 승인한 실제 계정으로 각 조건을 한 번씩 실행했다. adapter 내부 재시도는
꺼져 있고 원장은 `.artifacts/ai-page-v2/*.ndjson`에 남겼으며 API key와 원문·번역문은 기록하지
않았다. 따라서 아래 결과는 protocol/packet 예비 결정에는 쓸 수 있지만, 반복 실행과 사람 품질
평가를 요구하는 최종 release gate 통과를 뜻하지 않는다.

P1의 `article-basic-en-ko` 6 target 결과:

| provider / model                        | protocol    | provider total token | mapping / validation |
| --------------------------------------- | ----------- | -------------------: | -------------------: |
| OpenAI / `gpt-5.6-terra`                | array-exact |                  355 |                6 / 6 |
| OpenAI / `gpt-5.6-terra`                | id-object   |                  455 |                6 / 6 |
| Gemini / `gemini-3.5-flash`, thinking 0 | array-exact |                  332 |                6 / 6 |
| Gemini / `gemini-3.5-flash`, thinking 0 | id-object   |                  390 |                6 / 6 |

두 provider 모두 이 corpus에서는 `array-exact`가 mapping을 잃지 않으면서 token이 적었다.
Gemini의 기본 thinking을 그대로 둔 첫 probe는 512 output 한도 중 489 token을 thinking에 써서
실패했으므로 페이지 번역 profile은 thinking을 0으로 고정했다.

P2의 `table-dense-ja-ko` 160 target, `array-exact` 단일 실행 결과:

| 목표 target/packet | OpenAI token / request / coverage | Gemini token / request / coverage |
| -----------------: | --------------------------------: | --------------------------------: |
|                 32 |               6,524 / 5 / 160·160 |               6,817 / 5 / 160·160 |
|                 64 |               6,436 / 3 / 160·160 |               6,767 / 3 / 160·160 |
|                128 |               6,178 / 2 / 160·160 |               6,503 / 2 / 160·160 |

이 단일 corpus에서는 128이 token과 request 수가 가장 작았지만 첫 요청 latency가 OpenAI 약
8.1초, Gemini 약 7.0초로 늘었다. 64는 첫 요청이 각각 약 6.6초, 4.8초인 균형점이다. 제품
runtime은 큰 capability metadata만 믿고 수천 target을 한 요청에 넣지 않도록 Gemini 128,
OpenAI/default 256의 별도 protocol ceiling을 적용한다. 이는 사이트별 규칙이 아니라 structured
output 전달 안정성을 위한 provider profile 정책이다.

### 2026-07-13 京阪本線 실제 Chrome P5 smoke

같은 공개 페이지를 격리된 Chrome for Testing 149 프로필에서 명시적 V2, viewport 우선,
18K hard session budget으로 실행했다. 페이지에서 수집한 5,992 target 전체를 한 번에 보내지
않고 현재 admission 1,023 target만 처리한 결과다.

| provider / model            |   반영 target | 실제 request | 배너 token |   경과 | 확장 runtime exception |
| --------------------------- | ------------: | -----------: | ---------: | -----: | ---------------------: |
| OpenAI / `gpt-5.6-terra`    | 1,023 / 5,992 |            4 |        14K | 29.0초 |                      0 |
| Gemini / `gemini-3.5-flash` | 1,023 / 5,992 |            5 |        17K | 18.2초 |                      0 |

Gemini는 처음에 metadata의 1M input/65K output 한도만 따라 1,023 target을 한 요청으로 묶었고
응답 전달 검증에 실패했다. target ceiling 적용 후 5요청으로 1,023개가 모두 반영됐으며 실패
target은 0이었다. 두 실행 모두 hard budget에서 멈췄으므로 “페이지 전체 완역” 결과가 아니다.
200K 이상 폭주를 막고 현재 화면 범위를 안정적으로 번역한다는 P5 smoke 증거다. 전체 5,992개를
계속 번역할 때는 배너의 `Continue`를 눌러야만 같은 크기의 다음 budget window가 열린다. 자동으로
hard limit을 늘리지 않으므로 전체 번역 가능성과 비용 통제를 함께 유지한다.

## 1. 검증할 질문

1. raw HTML보다 compact target IR이 실제 input token을 얼마나 줄이는가?
2. 현행 `seg-v6-semantic`보다 V2 structured protocol이 전체 attempt token을 줄이는가?
3. 순서 기반 string array와 ID 기반 object array 중 어느 쪽이 mapping 안정성과 token을
   함께 만족하는가?
4. packet을 크게 묶을 때 어느 지점부터 latency, truncation, schema 오류, 번역 품질이
   나빠지는가?
5. retry가 발생해도 validated target을 다시 보내지 않는가?
6. 현재 화면 우선 번역이 유지되면서 offscreen token이 억제되는가?
7. 실제 provider usage와 UI ledger가 일치하는가?
8. DOM 구조, listener, focus, selection, SPA mutation을 보존하는가?
9. 같은 문자열과 재방문 페이지에서 local translation memory가 실제 호출을 없애는가?
10. 특정 사이트 selector 없이 복잡한 문서·표·목록·대시보드를 처리하는가?

## 2. 비교 대상

| ID               | 설명                                                          | 생성 호출 |
| ---------------- | ------------------------------------------------------------- | --------- |
| `raw-html-size`  | 전체/부분 HTML 직렬화 token 크기 비교만 수행                  | 없음      |
| `v1-seg-v6`      | 현행 marker + semantic packing baseline                       | 있음      |
| `v2-array-fixed` | `{s:[...]}` -> `{t:[...]}`, 고정 schema + client exact length | 있음      |
| `v2-array-exact` | packet별 `minItems=maxItems=N` strict schema                  | 있음      |
| `v2-id-object`   | `{items:[{id,s}]}` -> `{items:[{id,t}]}`                      | 있음      |

`raw-html-size`는 입력 크기 비교용이다. 번역된 HTML을 DOM에 삽입하는 실험은 안전성 목표와
충돌하므로 release 후보가 아니다. 필요하면 격리된 offline quality 실험에서만 생성하고,
extension runtime에는 연결하지 않는다.

## 3. 단계별 POC

### P0. Offline extractor/planner

provider 호출 없이 다음을 확인한다.

-   eligible target 수
-   excluded/inaccessible/out-of-scope 수와 이유
-   semantic unit 수
-   protocol별 payload byte/character/estimated token
-   packet 수와 packet별 input/output reservation
-   visible/prefetch/deferred 분배
-   같은 source dedupe와 cache key 안정성

P0가 실패하면 provider POC를 시작하지 않는다.

### P1. Protocol conformance

작은 고정 corpus를 실제 provider에 보내 다음을 측정한다.

-   JSON/schema success
-   exact length 또는 exact ID-set success
-   protected token success
-   item별 semantic validation
-   provider-reported usage
-   실제 HTTP attempt 수

각 payload는 독립 실행하며 retry를 끈다. 프로토콜 자체 실패율을 retry가 가리면 안 된다.

### P2. Packet-size curve

같은 ordered target stream을 여러 packet 목표 크기로 실행한다. 고정 item 수만 바꾸지 말고
input token과 expected output token을 주축으로 한다.

```text
small -> medium -> large -> near-safe-limit
```

각 점에서 latency, schema success, terminal coverage, quality, total token을 측정한다. 최대
context에 가장 가까운 점이 아니라 Pareto frontier의 점을 provider/model별 기본값으로 고른다.

### P3. Failure injection

실제 과금을 반복하지 않고 mock adapter와 local HTTP stub으로 먼저 검증한다.

-   429 + `Retry-After`
-   500/503
-   connection reset
-   timeout/abort
-   invalid JSON
-   valid schema + missing item
-   array 길이는 유지한 채 `drop-one + duplicate-one`
-   duplicate/unknown ID
-   output length stop
-   refusal/content filter
-   usage 없는 success/failure
-   최종 usage 전에 끊긴 stream
-   응답 전 DOM source 변경
-   session cancel/navigation

각 경우 request amplification과 ledger를 검사한다.

### P4. DOM integration

JSDOM 단위 테스트와 실제 Chrome fixture를 모두 사용한다.

-   Text.data와 허용 attribute만 바뀜
-   element/tree structure hash 불변
-   listener 동작 유지
-   focus/selection 유지
-   form/editable 값 불변
-   compare-and-swap stale 처리
-   restore compare-and-swap
-   open shadow root
-   late/hydrated content
-   기존 `lazyTranslate` viewport admission

### P5. Controlled live pages

로컬 fixture를 먼저 통과한 뒤 공개 페이지를 수동/반자동 smoke 대상으로 사용한다. live page는
변경될 수 있으므로 결과에 URL, timestamp, extracted IR hash를 저장한다. 특정 Wikipedia
selector를 코드에 추가하지 않는다.

### P6. V1 vs V2 opt-in shadow

같은 저장 snapshot을 V1/V2로 각각 번역한다. 동시에 두 provider 호출을 사용자 브라우저에서
발생시키지 않고, benchmark mode에서 명시적으로 실행한다.

## 4. Corpus

### 4.1 필수 fixture family

| Family                 | 포함해야 할 요소                                         | 검증 목적                    |
| ---------------------- | -------------------------------------------------------- | ---------------------------- |
| `article-basic`        | heading, paragraph, inline link/emphasis                 | 기본 문맥과 inline 보존      |
| `encyclopedia-complex` | 긴 본문, infobox, 큰 table, nested list, references, nav | 복잡 문서·token 폭주         |
| `table-dense`          | 짧은 cell 수백 개, row/column header                     | semantic grouping과 mapping  |
| `list-dense`           | 짧은 sibling item 수백 개, nested list                   | packet overhead와 문맥       |
| `docs-code`            | prose, code/pre, command, URL, file path                 | 제외·보호 token              |
| `dashboard-aria`       | button, label, title, placeholder, ARIA string/ref       | accessibility target         |
| `spa-mutation`         | hydration replacement, append/remove, text update        | revision/stale/reconcile     |
| `inline-fragments`     | 여러 링크·강조·ruby·br 사이 text                         | placeholder 안정성           |
| `repeated-content`     | 같은 label/문장 반복, rerender                           | dedupe/cache/inflight        |
| `adversarial-text`     | `[[1]]`, JSON, “ignore instructions”, HTML-like text     | prompt injection/parser 충돌 |
| `shadow-frame`         | open/closed shadow, same/cross-origin frame marker       | coverage 분류                |
| `rtl-multiscript`      | CJK, Latin, Arabic/RTL, 숫자·단위 혼합                   | 언어·layout 검증             |

### 4.2 언어쌍

최소 집합:

-   Japanese -> Korean
-   English -> Korean
-   Chinese Simplified -> Korean
-   English -> Japanese
-   English -> German 또는 Spanish
-   Arabic -> Korean 또는 English

Japanese -> Korean은 사용자가 보고한 복잡한 일본어 철도 문서 시나리오를 포함한다. 그러나
합격 여부를 한 페이지에만 맞추지 않는다.

### 4.3 fixture 출처

우선순위:

1. 저장소에서 직접 만든 synthetic HTML
2. 라이선스와 attribution을 기록한 고정 snapshot
3. live URL + extracted IR hash

API key, cookie, 개인화 영역, 로그인 데이터가 있는 실제 페이지 snapshot은 저장하지 않는다.
저작권이 있는 페이지 전체 HTML을 무심코 repository fixture로 커밋하지 않는다.

### 4.4 golden reference

품질 fixture의 일부에는 사람이 검토한 target-language reference를 둔다. 하나의 정답 문장과
문자열 일치시키지 않고 다음 annotation을 함께 둔다.

```json
{
    "source": "...",
    "reference": "...",
    "mustPreserve": ["KH01", "12.5 km"],
    "allowedKeepSource": ["Keihan"],
    "terminology": { "運行形態": ["운행 형태", "운행 방식"] },
    "notes": "railway context"
}
```

## 5. 실행 환경 기록

각 run은 다음을 반드시 저장한다.

-   git commit와 dirty 여부
-   extension/version/protocol version
-   fixture ID와 content/IR hash
-   실행 시각과 timezone
-   browser 이름·버전, Node 버전
-   provider, model ID, API style
-   capability snapshot과 probe source
-   source/target language
-   temperature/thinking/streaming 설정
-   packet planner config
-   concurrency와 hard budget
-   cache cold/warm 여부
-   network condition profile

API key와 Authorization header는 절대 결과에 저장하지 않는다. key fingerprint도 외부로
공유할 artifact에는 넣지 않는다.

## 6. 지표 정의

### 6.1 Coverage

```text
eligible = discovered - inaccessible - out_of_scope - skipped_policy
appliedCoverage = applied / eligible
terminalOriginalRate = failed_terminal / eligible
visibleCoverageAtT = applied_visible_at_t / eligible_visible_at_t
```

`skipped_policy`를 성공으로 부풀리지 않고 별도 표시한다. lazy mode의 deferred target도
“실패”가 아니라 별도 상태다.

### 6.2 Mapping 안정성

-   `schema_valid_rate`
-   `exact_mapping_rate`
-   `placeholder_valid_rate`
-   `wrong_target_apply_count`
-   `unknown_id_count`
-   `duplicate_id_count`
-   `missing_item_count`

`wrong_target_apply_count`는 하나라도 있으면 즉시 탈락이다.

segment 수 기반 coverage와 함께 source character 가중 coverage도 저장한다. 짧은 label
100개가 긴 본문 한 문단보다 진행률을 과도하게 키우지 않게 하기 위해서다.

### 6.3 Token

요청 attempt별:

-   provider input tokens
-   provider output tokens
-   reasoning/thinking tokens
-   cached input tokens
-   cache write tokens(제공될 때)
-   provider total tokens
-   input/output/reasoning/total 각 필드의 source: provider-reported/provider-counted/client-estimated
-   usage coverage: complete/partial/unknown
-   reasoning relation: subset-of-output/additional-to-output/unknown
-   preflight token count

run 전체:

```text
totalAttemptTokens = sum(attempt.authoritativeTotal)
initialPlannedTokens = sum(first-attempt packet reservation or estimate)
retryAmplification = totalAttemptTokens / firstAttemptActualTokens
inputAmplification = allAttemptInput / firstAttemptInput
tokensPerAppliedTarget = totalAttemptTokens / appliedTargets
fixedProtocolOverhead = protocolTokens - sourceTextTokens
```

cached/reasoning이 input/output/total의 subset이면 다시 합산하지 않는다.

UI 정확도도 별도 지표로 둔다.

```text
tokenDisplayError = abs(uiDisplayedTotal - authoritativeProviderTotal)
                    / authoritativeProviderTotal
```

authoritative total이 없는 request는 이 지표를 억지로 0으로 만들지 않고 `null`로 둔다.

### 6.4 Request

-   logical units
-   planned packets
-   actual HTTP/generation attempts
-   retry attempts by reason
-   provider compatibility attempts
-   token-count preflight requests
-   cache hit/inflight join counts

배너와 result JSON 모두 실제 provider attempt를 기준으로 한다.

### 6.5 Latency

-   collection duration
-   planning duration
-   queue wait
-   provider TTFT(스트리밍 실험만)
-   provider terminal latency
-   first visible target applied
-   visible 50%/90%/100%
-   current snapshot complete
-   p50/p95/p99 packet latency

첫 화면은 첫 packet latency와 다르다. cache hit이 먼저 적용될 수 있으므로 실제 DOM apply
timestamp를 기준으로 한다.

### 6.6 품질

자동 불변식:

-   숫자·단위·URL·code/protected token 보존
-   source echo 합법성
-   target script 신호
-   비정상 길이
-   금지된 HTML/marker 생성

reference가 있는 문장:

-   chrF 같은 reference metric은 보조 지표로만 사용
-   terminology hit rate
-   must-preserve recall

사람 평가(1~5):

-   adequacy: 의미 보존
-   fluency: 자연스러움
-   context: heading/table/list 문맥 반영
-   terminology: 고유명·전문용어 일관성
-   formatting: protected content 보존

LLM judge를 쓰면 provider/model/prompt를 기록하고 사람 평가를 대체하지 않는다. 동일 계열
모델이 자기 출력을 선호할 수 있으므로 최종 채택 근거는 blind human sample과 deterministic
invariant를 함께 사용한다.

### 6.7 DOM 안정성

-   element count/tree signature before/after
-   attribute mutation allowlist 위반 수
-   listener smoke pass
-   focus owner 유지
-   selection range 유지 또는 명시적 허용 변화
-   input value 유지
-   React/Vue hydration warning/console error
-   extension self-mutation loop 수

## 7. 결과 JSON 계약

```json
{
    "schemaVersion": "ai-page-bench-v2-1",
    "runId": "2026-07-12T12-00-00Z__fixture__provider__model",
    "environment": {
        "gitCommit": "...",
        "dirty": true,
        "node": "...",
        "browser": { "name": "Chrome", "version": "..." }
    },
    "case": {
        "fixtureId": "encyclopedia-complex-ja-ko",
        "contentHash": "...",
        "sourceLanguage": "ja",
        "targetLanguage": "ko"
    },
    "candidate": {
        "protocol": "v2-array-exact",
        "provider": "openai",
        "model": "...",
        "apiStyle": "openai-responses",
        "capabilityHash": "...",
        "plannerConfig": {}
    },
    "summary": {
        "eligibleTargets": 0,
        "appliedTargets": 0,
        "failedTerminalTargets": 0,
        "wrongTargetApplyCount": 0,
        "plannedPackets": 0,
        "actualAttempts": 0,
        "totalTokens": 0,
        "usageCoverage": "complete",
        "firstVisibleAppliedMs": 0,
        "visibleCompleteMs": 0,
        "snapshotCompleteMs": 0
    },
    "attempts": [
        {
            "requestId": "...",
            "packetId": "...",
            "attempt": 1,
            "reason": "initial",
            "status": "success",
            "httpStatus": 200,
            "startedAt": "...",
            "durationMs": 0,
            "targetCount": 0,
            "usage": {
                "billingEventId": "...",
                "coverage": "complete",
                "reasoningRelation": "subset-of-output",
                "inputTokens": { "value": 0, "source": "provider-reported" },
                "outputTokens": { "value": 0, "source": "provider-reported" },
                "reasoningTokens": { "value": 0, "source": "provider-reported" },
                "cachedInputTokens": { "value": 0, "source": "provider-reported" },
                "totalTokens": { "value": 0, "source": "provider-reported" }
            },
            "validation": {
                "schema": true,
                "mapping": true,
                "semanticPassed": 0,
                "semanticFailed": 0
            }
        }
    ],
    "targets": [
        {
            "id": "...",
            "state": "applied",
            "attemptCount": 1,
            "failureReason": null,
            "quality": {}
        }
    ],
    "dom": {
        "treeSignatureMatch": true,
        "unexpectedAttributeMutations": 0,
        "listenerSmoke": true,
        "consoleErrors": []
    }
}
```

원문과 번역문은 기본 결과 artifact에 저장하지 않는다. debugging이 필요하면 redacted/opt-in
artifact로 분리한다.

측정하지 못했거나 provider가 제공하지 않은 수치는 `0`이 아니라 `null`을 쓴다. `0`은
실제로 0 token/0 ms였다는 뜻으로만 사용한다.

## 8. 실패 주입 기대 결과

| 시나리오                |       기대 attempt | 기대 target 상태                    | budget/usage               |
| ----------------------- | -----------------: | ----------------------------------- | -------------------------- |
| 429 후 성공             |           최초 + 1 | unresolved만 applied                | 두 attempt 실제 usage 합산 |
| 429 두 번               |           최초 + 1 | failed_terminal/rate_limited reason | 무한 retry 없음            |
| 503 batch               |           최초 + 1 | unresolved만 retry                  | 성공 target 재전송 0       |
| schema invalid          |    최초 + 작은 1회 | 해당 packet target만 재계획         | page 전체 replay 0         |
| item 1개 semantic fail  |    최초 + item 1회 | 나머지 즉시 applied                 | 성공 item 재전송 0         |
| refusal                 |             최초만 | 원문 유지 + refusal                 | retry 0                    |
| DOM source 변경         |             최초만 | stale                               | failure count 제외         |
| budget reservation 실패 |             전송 0 | queued/budget_paused                | usage 0                    |
| cancel                  | 진행 request abort | canceled                            | 확인된 usage만 합산        |

## 9. 초기 release gate

아래는 측정 결과가 아니라 구현 후보를 거르는 제품 기준이다. 비용/latency 비율은 baseline
3회 이상 측정 후 더 현실적인 값으로 조정할 수 있지만 안전성 gate는 완화하지 않는다.

### 9.1 절대 gate

-   `wrong_target_apply_count = 0`
-   DOM tree signature 위반 0
-   forbidden attribute mutation 0
-   validated target 재전송 0
-   recursive/unbounded retry 0
-   hard budget reservation 없이 전송 0
-   deterministic fixture terminal coverage 100%
-   refusal/safety/stale/cancel 분류 정확
-   provider usage subset 중복 합산 0
-   기존 lazy viewport 동작 회귀 0

### 9.2 비교 gate

초기 목표:

-   복잡 문서 corpus median total token이 V1의 70% 이하
-   어느 핵심 fixture도 V1보다 total token이 10% 초과 증가하지 않음
-   실제 attempt 수가 V1보다 증가하지 않음
-   first-visible p95가 V1보다 느려지지 않음
-   human adequacy/fluency median 비열세

이 목표를 만족하지 못하면 결과를 숨기지 않고 원인을 protocol, packet size, retry, context,
quality로 분해한다. token을 줄이기 위해 품질이나 coverage gate를 낮추지 않는다.

## 10. 프로토콜 선택 표

각 provider/model/language pair에 대해 아래 표를 채운다.

| Candidate      | exact mapping | terminal coverage | total tokens | first visible | quality | 선택 |
| -------------- | ------------: | ----------------: | -----------: | ------------: | ------: | ---- |
| v2-array-fixed |               |                   |              |               |         |      |
| v2-array-exact |               |                   |              |               |         |      |
| v2-id-object   |               |                   |              |               |         |      |

결정 순서:

1. absolute gate 통과
2. exact mapping/coverage
3. token
4. latency
5. human quality

## 11. Packet-size 선택 표

| Target input band | expected output | items | schema success | p95 latency | total tokens | quality | 채택 |
| ----------------: | --------------: | ----: | -------------: | ----------: | -----------: | ------: | ---- |
|             small |                 |       |                |             |              |         |      |
|            medium |                 |       |                |             |              |         |      |
|             large |                 |       |                |             |              |         |      |

모델 최대치가 아니라 오류가 시작되기 전의 안정적인 Pareto 지점을 선택한다. language pair별
output expansion이 다르면 같은 provider/model이라도 planner profile을 분리할 수 있다.

## 12. Cold/warm cache 시나리오

각 대표 fixture는 최소 다음으로 실행한다.

1. cold: translation memory 비움, provider prompt cache 미확인
2. session duplicate: 같은 target 반복
3. inflight duplicate: 같은 key 동시 요청
4. warm revisit: persistent translation memory hit
5. source revision: 한 문장만 변경
6. language change: target language 변경
7. policy/glossary change

기대:

-   2/3은 provider owner 하나만 과금
-   4는 provider attempt 0
-   5는 변경 target만 호출
-   6/7은 잘못된 cache reuse 0

## 13. 기존 benchmark 도구 처리

현재 `tools/ai-page-translation-benchmark.mjs`는 다음에는 유용하다.

-   raw HTML과 현행 compact IR의 synthetic 크기 비교
-   현행 collector/semantic packing 속도 측정
-   generic table/list fixture
-   현행 planner 회귀

하지만 다음 이유로 V2 채택 도구로 그대로 사용하지 않는다.

-   자체 문자 기반 token 추정치만 사용한다.
-   현행 `[[n]]` marker protocol에 결합되어 있다.
-   실제 provider usage/attempt ledger가 없다.
-   품질, schema mapping, retry amplification, DOM commit을 측정하지 않는다.
-   synthetic encyclopedia의 절감률을 실제 페이지 절감률로 일반화할 수 없다.

따라서 기존 script는 `V1 offline baseline`으로 보존하고, V2용 runner를 별도로 둔다.

현재 P0 구조:

```text
tools/ai-page-translation-v2-benchmark/
  cli.mjs
  fixtures.mjs
  live-page.mjs
  protocols.mjs
tools/ai-page-translation-v2-browser-smoke.mjs
```

local HTTP adapter, built-Chrome runner, 실제 provider용 비용 확인/hard-budget runner와 append-only
NDJSON attempt ledger는 구현됐다. 실제 OpenAI/Gemini P1·P2 단일 실측과 공개 복잡 페이지 P5
smoke도 수행했다. 저장 가능한 고정 HTML corpus, 반복·사람 품질 평가, V1/V2 markdown 비교
report는 남은 단계다. 단일 성공 run을 최종 provider release gate 통과로 해석하지 않는다.

## 14. 명령 인터페이스 초안

API 호출 없는 offline 실행:

```bash
npm run bench:ai-page:v2 -- --mode=offline --fixture=all
```

명시적 provider POC:

```bash
npm run bench:ai-page:v2 -- \
  --mode=provider \
  --provider=openai \
  --model=<selected-model> \
  --fixture=article-basic-en-ko \
  --protocol=array-exact \
  --dry-run

OPENAI_API_KEY=... npm run bench:ai-page:v2 -- \
  --mode=provider \
  --provider=openai \
  --model=<selected-model> \
  --fixture=article-basic-en-ko \
  --protocol=array-exact \
  --hard-run-budget=24000 \
  --confirm-provider-cost
```

실제 과금이 있는 mode는 다음을 요구한다.

-   `--confirm-provider-cost`
-   환경 변수로 key 주입
-   예상 최대 token/attempt/run 요약 후 시작
-   hard run budget
-   결과에 key 미기록
-   adapter 내부 retry 0, 계획 packet당 generation attempt 정확히 1회
-   요청 시작/완료를 `.artifacts/ai-page-v2/*.ndjson`에 append-only로 기록
-   비용을 보고할 때 pricing source URL, 적용 시각, 통화, snapshot hash 기록

live URL은 별도 명시한다.

```bash
npm run bench:ai-page:v2 -- \
  --mode=browser \
  --url='https://ja.wikipedia.org/wiki/...' \
  --confirm-provider-cost
```

## 15. 실행 순서

1. P0 fixture와 extractor/registry를 구현한다.
2. 결과 schema와 ledger 단위 테스트를 먼저 만든다.
3. mock failure matrix를 통과한다.
4. provider별 protocol conformance를 작은 corpus로 실행한다.
5. 같은 canonical segment plan과 packet membership으로 array/object 후보를 비교한다.
   Primary A/B에서는 adaptive concurrency/packet tuning을 끄고 실행 순서를 seeded AB/BA로
   교차한다.
6. dry run 뒤 후보별 cold 5회, warm 5회를 기본 반복으로 실행한다. provider cache telemetry가
   없으면 cold라고 단정하지 않고 `cache_mode=unknown`으로 기록한다.
7. packet-size curve를 실행한다.
8. DOM browser fixture를 실행한다.
9. 사용자가 제시한 일본어 복잡 페이지를 controlled live smoke로 확인한다.
10. V1/V2 결과 markdown report를 생성한다.
11. absolute gate를 모두 통과한 뒤에만 experimental feature flag를 연결한다.

attempt record는 실행 중 append-only NDJSON으로 먼저 남기고, 종료 후 schema-validated 집계
JSON과 markdown report를 만든다. 중간 실패로 summary가 만들어지지 않아도 이미 발생한
provider attempt와 usage 증거가 사라지지 않아야 한다.

## 16. 결과 보고 형식

최종 보고서는 최소 다음을 포함한다.

-   실행한 commit과 dirty 상태
-   provider/model/capability snapshot
-   corpus와 제외 항목
-   V1/V2 protocol별 total tokens와 actual attempts
-   first-visible/visible-complete latency
-   coverage와 failure reasons
-   human quality sample
-   DOM invariant 결과
-   hard budget 준수 여부
-   채택/기각 결정과 근거
-   아직 측정하지 못한 항목

“토큰이 줄었다”는 문장은 provider-reported total과 모든 retry attempt가 포함된 경우에만
확정 표현을 쓴다. 일부 usage가 추정이면 수치와 결론에 `estimated/mixed`를 표시한다.
