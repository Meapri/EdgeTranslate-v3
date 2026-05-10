# EdgeTranslate-v3

EdgeTranslate-v3는 원본 [Edge Translate](https://github.com/EdgeTranslate/EdgeTranslate)
프로젝트를 기반으로 한 Manifest V3 브라우저 번역 확장 프로그램입니다. 이 포크는 익숙한 선택 번역
흐름을 유지하면서 현재 Chrome, Firefox, Safari 확장 정책에 맞게 프로젝트를 현대화합니다.

4.x 라인은 Material 디자인에서 영감을 받은 새 UI, 크게 업데이트된 pdf.js 뷰어, 다크 모드,
번역 패널 사용성 개선, 그리고 브라우저가 지원하는 경우 Gemini Nano를 통한 실험적 Chrome 온디바이스
AI 번역에 초점을 둡니다.

- 현재 저장소: [Meapri/EdgeTranslate-v3](https://github.com/Meapri/EdgeTranslate-v3)
- 원본 프로젝트: [EdgeTranslate/EdgeTranslate](https://github.com/EdgeTranslate/EdgeTranslate)
- 최신 릴리스: [v4.0.1](https://github.com/Meapri/EdgeTranslate-v3/releases/tag/v4.0.1)

## 다른 언어

- [English](../README.md)
- [简体中文](./README_CN.md)
- [繁體中文](./README_TW.md)
- [日本語](./README_JA.md)
- [Русский](./README_RU.md)

## 주요 기능

- 사이드 패널에서 선택 번역을 제공하며 복사, 편집, 고정, 크기 조절, TTS를 지원합니다.
- 선택한 공급자가 지원하는 경우 단어 번역, 상세 의미, 정의, 예문을 표시합니다.
- 일반 텍스트와 단어 번역 흐름에서 Chrome 내장 AI 번역을 지원합니다.
- Google 등 실사용에 적합한 엔진은 전체 페이지 번역에 계속 사용할 수 있습니다.
- 내장 pdf.js 뷰어에서 PDF 안의 선택 텍스트 번역을 지원합니다.
- Material 스타일로 정리된 PDF 툴바, 메뉴, 대화상자, 페이지 사이드바, 다크 모드를 제공합니다.
- PDF 뷰어, 번역 패널, 팝업, 설정 페이지 전반에 다크 모드를 지원합니다.
- 설정 페이지를 정리해 공급자 이름을 더 명확하게 만들고 시각적 복잡도를 줄였습니다.
- 키보드 단축키, 블랙리스트, 번역 버튼 동작 설정을 지원합니다.

## AI 번역 안내

Chrome의 온디바이스 Gemini Nano 경로는 브라우저가 `LanguageModel` API를 제공할 때 AI 번역 공급자로
노출됩니다. 짧은 선택 텍스트와 단어 보조 작업에는 유용하지만, 이 포크에서는 전체 페이지 번역 엔진으로
사용하지 않습니다.

중요 동작:

- 현재 온디바이스 성능이 전체 페이지 번역에 실용적이지 않아 Gemini Nano 페이지 번역은 사용자에게 보이는
  페이지 번역 옵션에서 제거했습니다.
- 일반 AI 번역은 반응성과 CPU 온도 사이의 균형을 위해 동시 실행 수를 제한합니다.
- 잘못된 JSON이 번역 패널에 그대로 표시되지 않도록 출력 결과를 방어적으로 파싱합니다.
- AI 모델이 남기기 쉬운 미번역 조각은 느린 2차 모델 호출 없이 후처리합니다.
- 결과 카드에서 보이는 발음 텍스트는 제거했습니다. TTS 재생은 계속 유지됩니다.

Chrome의 `LanguageModel` API와 Gemini Nano 사용 가능 여부는 사용자의 Chrome 버전, 기기, 기능 플래그,
모델 다운로드 상태에 따라 달라집니다. 사용할 수 없는 경우 확장 프로그램은 설정된 공급자 경로로 돌아가며,
AI 번역을 필수 런타임 의존성으로 취급하지 않습니다.

## PDF 뷰어

EdgeTranslate-v3는 지원되는 PDF 링크를 내장 pdf.js 뷰어에서 열어 문서 안의 텍스트 선택과 번역이
동작하도록 합니다. 4.x 뷰어는 pdf.js `5.7.284`를 사용하며 많은 레이아웃과 상호작용 수정이 포함되어 있습니다.

PDF 동작:

- 웹 PDF 링크를 확장 프로그램 뷰어로 리다이렉트해 번역할 수 있습니다.
- Chrome 확장 설정에서 “파일 URL에 대한 액세스 허용”을 켜면 로컬 PDF를 열 수 있습니다.
- 드래그한 PDF 파일과 blob 기반 뷰어 URL은 pdf.js가 안정적으로 불러올 수 있도록 미리 로드하거나 보정합니다.
- 현재 문서를 EdgeTranslate 밖에서 열고 싶은 사용자를 위해 네이티브 뷰어 우회 동작을 제공합니다.
- PDF 감지 폴백은 관련 없는 비 PDF 페이지를 불필요하게 탐색하지 않아 Chrome Web Store 개발자 콘솔 같은
  페이지의 CORS 잡음을 줄입니다.

## 브라우저 지원

### Chrome

- 선택 번역
- PDF 뷰어와 PDF 선택 번역
- Google 전체 페이지 번역
- 브라우저와 기기가 지원하는 경우 Chrome 내장 AI 번역
- 확장 컨텍스트 AI 번역을 위한 offscreen document 지원

### Firefox

- 선택 번역
- PDF 뷰어와 PDF 선택 번역. 단, 브라우저별 제한이 있을 수 있습니다.
- Chrome 내장 AI 번역 미지원
- Chrome 전용 전체 페이지 번역 동작 미제공

### Safari

- Safari 확장 빌드 경로를 통한 선택 번역과 PDF 뷰어 지원
- Chrome 내장 AI 번역 미지원
- Safari 릴리스에는 Xcode 프로젝트와 Apple 자격 증명이 필요합니다.

## 다운로드

- [GitHub Releases](https://github.com/Meapri/EdgeTranslate-v3/releases)
- [Chrome Web Store](https://chromewebstore.google.com/detail/edge-translate/pljeedmkegkcfkgdicjnalbllhifnnnj)

릴리스 자산에는 보통 다음 파일이 포함됩니다.

- `edge_translate_chrome.zip`
- `edge_translate_firefox.xpi`

## 개발 환경

저장소 루트를 작업 디렉터리로 사용합니다.

```bash
npm ci
```

단위 테스트 실행:

```bash
npm test
```

EdgeTranslate 워크스페이스 테스트 직접 실행:

```bash
npm test -w edge_translate -- --runInBand
```

## 빌드 명령

기본 Chrome 타깃 빌드:

```bash
npm run build:chrome
```

개별 타깃 빌드:

```bash
npm run build:chrome
npm run build:firefox
npm run build:safari
```

브라우저 패키지 생성:

```bash
npm run pack:chrome -w edge_translate
npm run pack:firefox -w edge_translate
```

Firefox 패키지 검증:

```bash
npm run lint:firefox
```

빌드 출력:

- Chrome 압축 해제 빌드: `packages/EdgeTranslate/build/chrome/`
- Firefox 압축 해제 빌드: `packages/EdgeTranslate/build/firefox/`
- Chrome 패키지: `packages/EdgeTranslate/build/edge_translate_chrome.zip`
- Firefox 패키지: `packages/EdgeTranslate/build/edge_translate_firefox.xpi`
- Safari 빌드 출력: `packages/EdgeTranslate/build/safari/`

## 로컬 빌드 불러오기

### Chrome

1. `chrome://extensions`를 엽니다.
2. 개발자 모드를 켭니다.
3. “압축해제된 확장 프로그램을 로드합니다”를 클릭합니다.
4. `packages/EdgeTranslate/build/chrome/`를 선택합니다.
5. 로컬 PDF나 파일 번역이 필요하다면 “파일 URL에 대한 액세스 허용”을 켭니다.

### Firefox

1. `about:debugging`을 엽니다.
2. “This Firefox”를 선택합니다.
3. “Load Temporary Add-on”을 클릭합니다.
4. `packages/EdgeTranslate/build/firefox/` 안의 아무 파일이나, 생성된 `edge_translate_firefox.xpi`를 선택합니다.

### Safari

Safari 빌드는 `packages/EdgeTranslate/safari-xcode/` 아래에 있습니다.

유용한 명령:

```bash
npm run build:safari
npm run safari:sync -w edge_translate
npm run safari:release -w edge_translate
```

`safari:release`는 빌드, Xcode 프로젝트로 리소스 동기화, 아카이브, 내보내기, 업로드를 수행합니다.
유효한 App Store 자격 증명이 필요합니다.

## 권한

이 확장 프로그램은 사용자 페이지에서 선택 번역, PDF 감지, 콘텐츠 스크립트를 동작시키기 위해 호스트 접근 권한을
사용합니다. Chrome 빌드는 확장 PDF 뷰어처럼 페이지 주입을 사용할 수 없는 상황에서 확장 문서 컨텍스트로
Gemini Nano 번역을 실행하기 위해 `offscreen`도 요청합니다.

주요 권한 범주:

- `activeTab`, `tabs`, `scripting`: 선택 번역과 페이지 상호작용에 사용합니다.
- `contextMenus`, `storage`: 명령과 사용자 설정에 사용합니다.
- `webNavigation`, `webRequest`: PDF 감지와 뷰어 라우팅에 사용합니다.
- Chrome의 `offscreen`: 확장 컨텍스트 AI 번역에 사용합니다.

## 개인정보

- 이 포크는 분석 도구나 텔레메트리 수집을 추가하지 않습니다.
- 번역 텍스트는 사용자가 선택하거나 설정한 공급자에게만 전송됩니다.
- Chrome 온디바이스 AI 번역은 사용 가능한 경우 Chrome 내장 로컬 모델 경로로 실행됩니다.
- 파일 URL 접근은 선택 사항이며 브라우저 확장 설정에서 제어합니다.

## 릴리스 체크리스트

일반 릴리스 절차:

1. `packages/EdgeTranslate/package.json`를 업데이트합니다.
2. `package-lock.json`을 업데이트합니다.
3. `packages/EdgeTranslate/src/manifest.json`을 업데이트합니다.
4. 테스트와 브라우저 패키징을 실행합니다.
5. 예를 들어 `v4.0.1` 같은 릴리스 커밋과 태그를 만듭니다.
6. Chrome과 Firefox 패키지 아티팩트를 GitHub Releases에 업로드합니다.

이전 프로젝트 체크리스트는 [RELEASE_CHECKLIST.md](../RELEASE_CHECKLIST.md)를 참고하세요.

## 문서

원본 프로젝트의 레거시 기능 참고 문서는 일반 동작을 이해하는 데 여전히 유용합니다.

- [Instructions](./wiki/en/Instructions.md)
- [Precautions](./wiki/en/Precautions.md)
- [Privacy Policy](./wiki/en/PrivacyPolicy.md)
- [Local LLM Translate Proxy](./local-llm-translate-proxy.md)

## 라이선스

이 프로젝트는 원본 Edge Translate 프로젝트와 같은 라이선스 구조를 따릅니다.

- [LICENSE.MIT](../LICENSE.MIT)
- [LICENSE.NPL](../LICENSE.NPL)

## 크레딧

원본 Edge Translate 유지보수자와 기여자에게 감사드립니다. EdgeTranslate-v3는 그 기반을 이어받아
Manifest V3 브라우저, 현대 브라우저 API, PDF 워크플로, AI 보조 번역에 맞게 계속 적응하고 있습니다.
