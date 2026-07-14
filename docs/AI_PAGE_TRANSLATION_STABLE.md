> **HISTORICAL** — superseded by AI_PAGE_TRANSLATION_VNEXT.md; kept for archaeology.

# AI 페이지 번역 stable rollback 계약

> **상태:** stable은 cloud AI의 기본 pipeline이 아니라 vNext의 명시적 rollback 경계다.
> 현재 기본 구현과 운영 기준은
> [AI 페이지 번역 vNext 운영 계약](./AI_PAGE_TRANSLATION_VNEXT.md)을 본다.

## 1. 언제 이 경로를 쓰나

cloud AI page 요청에 `pipelineVersion=stable`을 명시하면
`packages/EdgeTranslate/src/content/ai_page_translation_stable/`로 들어간다. `auto`와
`vnext`는 vNext다.

이 구분은 다음과 독립적이다.

-   `chromeBuiltin`은 기존 V1 DOM/on-device bridge를 쓴다.
-   `DefaultPageTranslator=GooglePageTranslate`는 Google script injection 경로다.
-   stable/vNext는 `AIPageTranslate`에서 OpenAI, Google AI Studio, OpenAI-compatible 같은
    cloud engine을 쓸 때의 내부 pipeline 선택이다.

## 2. stable이 보존하는 안전 계약

stable도 HTML 전체를 provider에 보내지 않는다. 범용 DOM/ARIA collector가 문자열 target을
수집하고, target ID/revision, source+role dedupe, capability-aware packet, ID structured
reply, provider status/semantic validation, CAS commit, bounded unresolved-only recovery를 쓴다.

보존해야 할 불변식:

-   사이트별 selector나 Wikipedia 하드코딩 없음
-   `innerHTML` 교체 없음
-   Text node의 `data` 또는 allowlisted attribute만 변경
-   session/revision/live-source CAS
-   성공 ID는 recovery payload에서 제외
-   auth/quota/model/missing-key circuit
-   usage receipt의 `billingEventId` dedupe
-   SPA mutation coalescing과 자체 write guard
-   provider usage가 없을 때 정확한 실제 token으로 가장하지 않음

## 3. vNext와 다른 점

| 영역                    | stable                     | vNext                                                  |
| ----------------------- | -------------------------- | ------------------------------------------------------ |
| wire granularity        | 문자열/semantic unit 중심  | semantic leaf block + inline placeholder               |
| protocol/cache identity | legacy V2, `stable-1`      | `pt3`, `pt3-2`                                         |
| initial planning        | stable planner/wave 정책   | whole-document one-pass + drain 96/8K chars/4K est-out |
| inline 문장             | node 경계의 영향을 더 받음 | `<gN>`/`<vN/>`로 한 문장 문맥 유지                     |
| transport               | V2 transport               | pt3 transport와 exact official adapters                |
| 제품 역할               | rollback                   | cloud `auto`/default                                   |

stable의 상세 내부 동작을 새 기능 기준으로 확장하지 않는다. 공통 안전 결함이면 stable과 vNext를
각각 고치되, 새 page-translation 기능과 성능 최적화는 vNext에서 진행한다.

## 4. Rollback 절차

1. 재현 URL, engine/model, source/target language, 실패 단계와 banner snapshot을 남긴다.
2. 같은 build에서 `pipelineVersion=stable`로 다시 실행한다.
3. stable 성공/vNext 실패인지, provider 자체 실패인지 비교한다.
4. stable이 성공하면 vNext의 collector/IR/validator/CAS/recovery 중 어느 경계가 다른지
   production snapshot과 local exact-adapter stub로 좁힌다.
5. default를 되돌릴 필요가 있으면 router만 stable로 바꾸고 두 runtime을 모두 보존한다.

비교할 때 batch 수만 보지 않는다. target coverage, provider **generation** request 수, recovery
증폭, failed/incomplete strings, DOM invariant, provider receipt/estimated 표시를 함께 본다.

## 5. 검증 명령

```bash
npm test -w edge_translate -- --runInBand
npm test -w @edge_translate/translators -- --runInBand
npm run build:chrome
npm run smoke:ai-page:stable:chrome -- --expect-pipeline=stable
npm run smoke:ai-page:default:chrome -- --expect-pipeline=vnext
```

offline stable benchmark:

```bash
npm run bench:ai-page:stable
```

`bench:ai-page:stable`의 token 값은 heuristic일 수 있다. provider receipt가 아닌 값을 실제
과금 또는 live baseline으로 사용하지 않는다.

## 6. 삭제 금지와 종료 조건

stable은 아직 삭제하지 않는다. local stub 성공은 구조 검증이지 실제 provider 품질·비용 증거가
아니다. 다음이 모두 충족된 뒤 별도 release decision으로만 삭제한다.

-   vNext Gates C-F live/human 검증 완료
-   동일 snapshot/provider의 stable 대비 receipt 기준 비용 확인
-   default-vNext 실제 사용 soak에서 rollback 필요 없음
-   stable import를 지워도 Chrome built-in/V1/GooglePageTranslate가 영향받지 않는다는 증거
-   full test/build, default-vNext smoke와 migration/rollback test 통과

삭제 전까지 stable test, transport/protocol compatibility, `pipelineVersion=stable` router를
유지한다.
