# Edge Translate UI 디자인 시스템

> 현재 구현 기준: 2026-07-15
> 범위: 페이지 번역 상단 바, 공용 언어 선택기, 드래그 번역 결과 패널

이 문서는 번역 로직을 바꾸지 않고 확장 UI를 이어서 개발할 때 지켜야 할 시각·상태·접근성 계약을 정리한다. 실제 값의 단일 출처는 `packages/EdgeTranslate/src/common/scripts/ui_design_tokens.js`다.

## 1. 설계 목표

- 번역 상태와 사용자가 누를 수 있는 조작부를 시각적·의미적으로 분리한다.
- 밝은/어두운 테마와 좁은 화면에서도 같은 우선순위를 유지한다.
- 페이지의 `z-index`, `overflow`, transform stacking context에 상관없이 언어 메뉴가 항상 보인다.
- 애니메이션은 상태 이해를 돕는 범위에서만 사용하고 `prefers-reduced-motion`을 존중한다.
- 문구는 `chrome.i18n`을 통하며, 테스트와 제한된 실행 환경에서는 영어 fallback을 사용한다.

## 2. 공통 토큰

`EDGE_UI`는 세 UI가 함께 사용하는 최소 토큰 집합이다.

| 범주 | 핵심 값 | 용도 |
| --- | --- | --- |
| Accent | light `#0066cc`, dark `#2997ff` | 선택, 포커스, 주요 상태 |
| Text | light `#1d1d1f`, dark `#f5f5f7` | 기본 텍스트 |
| Muted | light `#6e6e73`, dark `#aeaeb2` | 보조 정보와 비활성 아이콘 |
| Radius | surface `18px`, control `11px`, pill `999px` | 표면, 메뉴 항목, 칩/버튼 |
| Motion | fast, standard, snappy, spotlight, press | 열기/닫기와 상호작용 피드백 |

새 컴포넌트에서 같은 의미의 색·반경·motion 값을 다시 하드코딩하지 않는다. 새 의미가 필요할 때만 토큰을 추가하고, 기존 값의 단순 별칭은 만들지 않는다.

## 3. 페이지 번역 상단 바

### 3.1 정보 우선순위

1. 상태점과 현재 상태
2. 번역/원문 전환
3. 대상 언어
4. 숨기기와 닫기
5. 제공자와 모델은 공간이 충분할 때만 노출

완료 상태에서는 `번역 완료`만 남기고 `100%`와 진행 트랙을 숨긴다. 진행 중에는 `완료 / 전체`와 퍼센트를 표시한다. 실패/부분 완료는 성공처럼 보이게 만들지 않고 `error` 상태를 유지한다.

### 3.2 상태 계약

| `data-state` | 화면 의미 | 진행 표시 |
| --- | --- | --- |
| `starting` | 대상 수집/초기화 | indeterminate |
| `running` | 번역 진행 | determinate |
| `complete` | 모든 대상 완료 | 트랙과 퍼센트 숨김 |
| `error` | 실패 또는 일부 미완료 | 오류/부분 완료 강조 |

자동화는 번역된 문구를 비교하지 않고 이 상태값을 사용한다. 그래야 한국어·영어·일본어 등 UI 언어가 달라도 같은 검증을 재사용할 수 있다.

### 3.3 원문/번역 전환

단일 토글 문구가 아니라 두 버튼으로 된 segmented control을 사용한다. 각 버튼은 `aria-pressed`로 현재 선택을 밝히며, 전환은 provider 요청을 추가로 발생시키지 않고 이미 보존한 DOM 값을 교체한다.

### 3.4 반응형 규칙

| 폭 | 축약 규칙 |
| --- | --- |
| `> 980px` | 제목, 제공자, 모델, 전체 조작 노출 |
| `<= 980px` | 제목 숨김, 상태/모델 폭 제한, 숨기기 텍스트 축약 |
| `<= 760px` | 모델 숨김, segmented control과 언어 선택 우선 |
| `<= 640px` | 제공자 이름을 아이콘으로 축약, 간격·패딩 축소 |

Edge Translate는 데스크톱 확장이므로 작은 화면 검증도 Chromium의 mobile page-scale이 아닌 좁은 desktop viewport로 수행한다.

## 4. 공용 언어 선택기

- trigger는 실제 `button`, 목록은 native Popover API top layer를 사용한다.
- popover는 Shadow DOM 밖의 `document.body`에 두어 panel/banner의 overflow에 잘리지 않게 한다.
- 최상단 `z-index`만으로 해결하지 않는다. top layer 진입 여부와 `elementFromPoint`의 최상단 hit를 함께 검증한다.
- 검색 아이콘, 펼침 아이콘, 선택 체크는 같은 SVG 선/면 언어를 사용하고 emoji 문자를 UI 아이콘으로 쓰지 않는다.
- 선택 항목은 색만 바꾸지 않고 check icon과 `aria-selected`를 함께 제공한다.
- Escape, 바깥 클릭, 검색, 위/아래 이동, Enter 선택을 지원한다.

## 5. 드래그 번역 결과 패널

- 제공자와 대상 언어는 헤더의 주 조작으로 유지한다.
- 설정과 고정은 `더보기` 안으로 묶고 닫기는 항상 노출한다.
- 설정·고정·닫기는 모두 native `button`이며, 고정 상태는 `aria-pressed`로 표현한다.
- 제공자 dropdown은 `menu`/`menuitemradio` 의미를 사용하고 Escape, ArrowUp/Down, Home/End를 지원한다.
- keyboard focus는 3px accent ring으로 표시한다.
- 패널 언어 메뉴도 페이지 번역 바와 같은 top-layer 선택기를 재사용한다.

## 6. 다국어 문구

페이지 번역 바 문구는 `_locales/{en,ko,ja,zh_CN,zh_TW,ru}/messages.json`에 동시에 추가한다. `test/unit/common/aiPageLocaleMessages.test.js`의 필수 key 목록도 함께 갱신한다.

상태 문구에는 숫자 placeholder만 전달하고 HTML을 넣지 않는다. 접근성 이름(`Hide bar`, `Close`, `Show original` 등)은 눈에 보이는 짧은 라벨과 별도 key를 가질 수 있다.

## 7. 검증 절차

```bash
npm test -w edge_translate -- --runInBand --silent
npx eslint packages/EdgeTranslate/src/common/scripts/ui_design_tokens.js \
  packages/EdgeTranslate/src/common/scripts/language_menu.js \
  packages/EdgeTranslate/src/content/banner_controller.js \
  packages/EdgeTranslate/src/content/display/Dropdown.jsx \
  packages/EdgeTranslate/src/content/display/Panel.jsx
npm run build:chrome
```

브라우저 상태/레이어 검증:

```bash
node tools/ai-page-translation-v2-browser-smoke.mjs \
  --pipeline=vnext --expect-pipeline=vnext --stub-provider=openai \
  --viewport-width=1280 --viewport-height=720 --color-scheme=light \
  --screenshot=/tmp/edge-page-desktop.png \
  --panel-screenshot=/tmp/edge-panel-desktop.png
```

최소 시각 검증 행렬은 1280×720 light, 480×720 light, 760×640 dark다. 각 실행에서 다음을 확인한다.

- 페이지 번역 완료와 segmented control 선택 상태
- 언어 메뉴의 native top layer, 최상단 hit, light/dark 대비
- 원문 hover의 문장/문단 분리와 빈 배경 미표시
- SPA 동적 텍스트/ARIA/placeholder 번역
- 링크, data attribute, input 값, focus, selection, event listener 보존
- 패널 action의 native button/pressed semantics와 패널 언어 메뉴 layering
- `Runtime.exceptionThrown` 0건

## 8. 변경 체크리스트

- [ ] 공통 의미는 `EDGE_UI` 토큰을 재사용했는가?
- [ ] 완료/진행/부분 실패가 중복되거나 모호하게 표시되지 않는가?
- [ ] 480px 폭에서 핵심 조작이 잘리거나 겹치지 않는가?
- [ ] light/dark에서 텍스트와 선택 상태를 구분할 수 있는가?
- [ ] 모든 클릭 조작에 button semantics와 keyboard 경로가 있는가?
- [ ] 언어 메뉴가 top layer에 실제로 진입하는가?
- [ ] 문구 비교가 아니라 상태값으로 자동화했는가?
- [ ] unit, lint, Chrome build, 실제 브라우저 smoke가 모두 통과했는가?
