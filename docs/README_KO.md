## EdgeTranslate-v3 (MV3)

다른 언어로 보기:
- [English](../README.md)
- [简体中文](./README_CN.md)
- [繁體中文](./README_TW.md)
- [日本語](./README_JA.md)
- [한국어](./README_KO.md)

Edge Translate의 포크 프로젝트로, Manifest V3에 맞춰 전면 리팩터링하고 최신 브라우저 정책에 맞춘 안정성과 성능을 제공합니다. 원작이 MV2 중단 정책으로 스토어에서 내려간 이후 동일한 사용 경험을 이어가도록 코드와 빌드 시스템을 현대화했습니다.

- 원작 저장소: [EdgeTranslate/EdgeTranslate](https://github.com/EdgeTranslate/EdgeTranslate)
- 현재 저장소: [Meapri/EdgeTranslate-v3](https://github.com/Meapri/EdgeTranslate-v3)

### 주요 기능
- 선택 번역과 사이드 팝업: 선택한 텍스트의 번역 결과를 화면 측면 팝업으로 표시해 읽기 흐름을 방해하지 않습니다. 결과 항목(일반 의미, 발음, 정의/상세 설명, 예문 등)은 사용자 설정으로 제어할 수 있으며, 자주 사용할 경우 고정할 수 있습니다.
- PDF 번역/뷰어: 내장 pdf.js 기반 뷰어에서 PDF 내 단어/문장 선택 번역을 지원합니다. 페이지 색상 반전 기반 다크 모드 및 UI 개선으로 가독성을 높였습니다.
- 전체 페이지 번역(Chrome 한정): 컨텍스트 메뉴에서 현재 페이지를 원하는 언어로 번역할 수 있습니다. 자동 실행되지 않으며 필요할 때만 수동으로 실행됩니다. Safari/Firefox에서는 제공하지 않습니다.
- 단축키: 선택 번역, 결과 창 고정/해제, 패널 확장 등 주요 동작을 키보드만으로 빠르게 수행할 수 있습니다.
- 블랙리스트: 현재 페이지/도메인을 차단 목록에 추가해 해당 페이지에서 선택/더블클릭 번역을 비활성화할 수 있습니다.
- 음성 합성(TTS): 더 고품질의 음성을 우선 선택해 자연스러운 낭독을 제공합니다.

### 다운로드
- [Chrome 웹스토어](https://chromewebstore.google.com/detail/edge-translate/pljeedmkegkcfkgdicjnalbllhifnnnj)
- [GitHub Releases](https://github.com/Meapri/EdgeTranslate-v3/releases)

### 브라우저 지원 및 제한
- Chrome: 선택 번역, PDF 뷰어, 전체 페이지 번역
- Firefox: 선택 번역, PDF 뷰어 지원(브라우저 이슈로 일부 기능이 제한될 수 있음), 전체 페이지 번역 미제공
- Safari(macOS): 선택 번역, PDF 뷰어 지원, 전체 페이지 번역 미제공(플랫폼 정책/제한)

### PDF 뷰어 참고
- PDF 링크는 의도적으로 EdgeTranslate 내장 pdf.js 뷰어로 열립니다. 그래야 PDF 안에서도 선택 번역을 사용할 수 있습니다.
- 로컬/다운로드 PDF(`file://`)도 Chrome의 “파일 URL 액세스 허용”이 켜져 있으면 확장 뷰어에서 처리됩니다. 로컬 파일은 blob 사전 로딩을 하지 않고 PDF.js가 직접 로드하도록 해 흰 화면 문제를 줄였습니다.
- 현재 문서만 기본/원본 PDF 뷰어로 열고 싶다면 PDF 뷰어 툴바의 **Open original PDF** 버튼을 사용하세요. 이 동작은 리다이렉트 루프를 막기 위한 일회성 우회 표시를 URL에 붙입니다.

### 개인정보 및 보안
- 통계/분석 데이터 수집 없음, 추적하지 않음
- 최소 권한 원칙으로 동작
- 파일 페이지(file://) 접근은 Chrome에서 별도의 "파일 URL 액세스 허용"을 켜야 할 수 있습니다.

### 설치(개발/테스트용)
Chrome(개발자 모드)
1) `chrome://extensions` 접속 → 개발자 모드 활성화
2) 아래 빌드 완료 후 "압축해제된 확장 프로그램 로드" → `build/chrome`

Firefox(임시 로드)
1) `about:debugging` → 임시 애드온 로드 → `build/firefox` 내 임의의 파일 선택

Safari(macOS)
1) Xcode 프로젝트로 실행(리소스 동기화 필요, 개발/빌드 참고)

### 개발 / 빌드
작업 디렉터리: 저장소 루트.

1) 의존성 설치
```
npm ci
```

2) 테스트 실행
```
npm test
```

3) 기본 빌드
```
npm run build
```
공용 translators 패키지와 기본 대상인 Chrome 확장 빌드를 수행합니다.

브라우저별 빌드
```
npm run build:chrome
npm run build:firefox
npm run build:safari
```

전체 브라우저 패키징/빌드
```
npm run build:all
```

Safari 참고
- `npm run build:safari`는 `packages/EdgeTranslate/build/safari/`까지만 생성하며 Xcode `Resources/` 디렉터리는 수정하지 않습니다.
- Xcode 프로젝트에 명시적으로 반영해야 할 때만 `npm run safari:sync -w edge_translate`를 실행하세요.
- `npm run safari:release -w edge_translate`는 build, sync, archive, export, upload를 수행하며 App Store 계정 환경 변수가 필요합니다.

빌드 산출물 위치
- Chrome: `packages/EdgeTranslate/build/chrome/`
- Firefox: `packages/EdgeTranslate/build/firefox/`
- Safari 빌드 산출물: `packages/EdgeTranslate/build/safari/`
- Safari Xcode 리소스: 명시적 sync/release 후 `packages/EdgeTranslate/safari-xcode/EdgeTranslate/EdgeTranslate Extension/Resources/`

### 호스트 권한
선택 번역 등 상시 콘텐츠 스크립트 주입을 위해 전역 호스트 권한이 필요합니다. Chrome은 `host_permissions: ["*://*/*"]`를 사용하며, Firefox/Safari는 `<all_urls>`에 매칭되는 콘텐츠 스크립트를 사용합니다. 확장 프로그램은 최소 권한 원칙을 따릅니다.

 

### 문서
- 원작 문서(기능 전반 참고):
  - Instructions: [Edge Translate Instructions](https://github.com/EdgeTranslate/EdgeTranslate/blob/master/docs/wiki/en/Instructions.md)
  - Precautions: [Edge Translate Precautions](https://github.com/EdgeTranslate/EdgeTranslate/blob/master/docs/wiki/en/Precautions.md)

### 라이선스
- 본 포크는 원작과 동일한 MIT AND NPL 라이선스를 따릅니다.
- 라이선스 파일: [LICENSE.MIT](../LICENSE.MIT), [LICENSE.NPL](../LICENSE.NPL)

### 크레딧
- 원작 Edge Translate 및 모든 기여자 분들께 감사드립니다.
- 본 프로젝트는 원작의 사용자 경험을 유지하면서 MV3 및 최신 브라우저 환경에 맞게 재구성했습니다.
