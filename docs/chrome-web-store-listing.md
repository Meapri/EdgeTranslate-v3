# Chrome Web Store Listing Copy

Prepared for EdgeTranslate-v3 `4.0.1`.

## English

### Short Description

Translate selected text, words, pages, and PDFs in a clean side panel with AI-assisted translation support.

### Detailed Description

EdgeTranslate is a fast, practical translation extension for reading the web without breaking your flow. Select text on any page to translate it in a clean side panel, use text-to-speech, copy or edit results, and keep the panel pinned while you read.

The 4.x release modernizes the extension with a refreshed Material-inspired interface, dark mode support, an upgraded PDF viewer, and experimental Chrome on-device AI translation where supported by your browser.

Key features:

- Translate selected text in a side panel
- Translate words with meanings, definitions, and examples when supported by the selected provider
- Use text-to-speech for source or translated text
- Translate supported web pages with practical page translation engines
- Open PDFs in the built-in pdf.js viewer and translate selected PDF text
- Use a redesigned PDF toolbar, page sidebar, menus, and document dialogs
- Choose dark mode across the translation panel, settings, popup, and PDF viewer
- Configure translation button behavior, providers, languages, blacklist rules, and shortcuts
- Use Chrome built-in AI translation for smaller text and word-assistance tasks when Gemini Nano is available on your device

AI translation note:
Chrome on-device AI translation depends on your Chrome version, device support, feature availability, and local model download state. It is best suited for selected text and word assistance. Full-page Gemini Nano translation is not exposed because the current on-device path is not fast enough for a good full-page experience.

Privacy:
EdgeTranslate does not add analytics or telemetry. Translation text is sent only to the provider you select or configure. Chrome on-device AI translation runs through Chrome's built-in local model path when available.

### What's New in 4.0.1

- Fixed AI translation in the extension PDF viewer
- Fixed Chrome LanguageModel output-language errors on newer Chrome versions
- Improved Gemini Nano output cleanup without a slow second model pass
- Removed visible pronunciation text from result cards while keeping TTS
- Fixed PDF drag/drop, blob URL handling, and remote PDF loading paths
- Prevented unnecessary PDF detection probes on non-PDF pages
- Improved extension error messages

## Korean

### Short Description

선택한 텍스트, 단어, 페이지, PDF를 깔끔한 사이드 패널에서 번역하고 AI 번역도 사용할 수 있습니다.

### Detailed Description

EdgeTranslate는 웹을 읽는 흐름을 끊지 않고 빠르게 번역할 수 있는 브라우저 확장 프로그램입니다. 페이지에서 텍스트를 선택하면 깔끔한 사이드 패널에 번역 결과가 표시되며, TTS 재생, 결과 복사, 결과 편집, 패널 고정 등을 사용할 수 있습니다.

4.x 버전은 Material 디자인에서 영감을 받은 새 인터페이스, 다크 모드, 개선된 PDF 뷰어, 그리고 지원되는 Chrome 환경에서 사용할 수 있는 온디바이스 AI 번역 기능을 중심으로 크게 정리되었습니다.

주요 기능:

- 선택한 텍스트를 사이드 패널에서 번역
- 선택한 단어의 뜻, 상세 의미, 정의, 예문 표시
- 원문과 번역문의 TTS 재생
- 지원되는 엔진을 통한 웹페이지 번역
- 내장 pdf.js 뷰어에서 PDF를 열고 선택한 PDF 텍스트 번역
- 새로 정리된 PDF 툴바, 페이지 사이드바, 메뉴, 문서 속성 창
- 번역창, 설정, 팝업, PDF 뷰어의 다크 모드 지원
- 번역 버튼 동작, 번역 공급자, 언어, 블랙리스트, 단축키 설정
- Chrome과 기기가 지원하는 경우 Gemini Nano 기반 Chrome 내장 AI 번역 사용

AI 번역 안내:
Chrome 온디바이스 AI 번역은 Chrome 버전, 기기 지원 여부, 기능 활성화 상태, 로컬 모델 다운로드 상태에 따라 달라집니다. 짧은 텍스트나 단어 보조 번역에 적합하며, 현재 Gemini Nano 전체 페이지 번역은 속도와 발열 면에서 실사용성이 낮아 제공하지 않습니다.

개인정보:
EdgeTranslate는 별도의 분석 도구나 추적 기능을 추가하지 않습니다. 번역할 텍스트는 사용자가 선택하거나 설정한 번역 공급자에만 전달됩니다. Chrome 온디바이스 AI 번역은 사용 가능한 경우 Chrome의 내장 로컬 모델 경로를 사용합니다.

### What's New in 4.0.1

- PDF 뷰어에서 AI 번역이 동작하지 않던 문제 수정
- 최신 Chrome의 LanguageModel 출력 언어 오류 수정
- 느린 2차 모델 호출 없이 Gemini Nano 번역 결과 정리
- 번역 결과 카드에서 발음 텍스트 표시 제거, TTS 기능은 유지
- PDF 드래그 앤 드롭, blob URL, 원격 PDF 로딩 경로 수정
- PDF가 아닌 페이지에서 불필요한 PDF 감지 요청이 발생하지 않도록 수정
- 확장 프로그램 오류 메시지 표시 개선

## Simplified Chinese

### Short Description

在清爽的侧边栏中翻译选中文本、单词、网页和 PDF，并支持可用环境下的 AI 翻译。

### Detailed Description

EdgeTranslate 是一款面向日常阅读的浏览器翻译扩展。你可以在网页中选中文本，并在清爽的侧边栏中查看翻译结果，同时使用朗读、复制、编辑结果和固定面板等功能。

4.x 版本带来了全新的 Material 风格界面、深色模式、升级后的 PDF 阅读器，以及在受支持的 Chrome 环境中可用的本机 AI 翻译能力。

主要功能：

- 在侧边栏中翻译选中文本
- 翻译单词，并在供应商支持时显示释义、详细含义、定义和例句
- 朗读原文或译文
- 使用实用的网页翻译引擎翻译网页
- 在内置 pdf.js 阅读器中打开 PDF，并翻译 PDF 内选中的文字
- 重新设计的 PDF 工具栏、页面侧栏、菜单和文档属性窗口
- 翻译面板、设置页、弹出窗口和 PDF 阅读器支持深色模式
- 配置翻译按钮行为、翻译供应商、语言、黑名单和快捷键
- 在设备和 Chrome 支持时使用基于 Gemini Nano 的 Chrome 内置 AI 翻译

AI 翻译说明：
Chrome 本机 AI 翻译取决于你的 Chrome 版本、设备支持情况、功能可用性和本地模型下载状态。它更适合短文本和单词辅助翻译。由于当前 Gemini Nano 的整页翻译速度和发热表现还不适合日常使用，本扩展不提供 Gemini Nano 整页翻译选项。

隐私：
EdgeTranslate 不添加分析统计或追踪功能。需要翻译的文本只会发送到你选择或配置的翻译供应商。可用时，Chrome 本机 AI 翻译会使用 Chrome 内置的本地模型路径。

### What's New in 4.0.1

- 修复扩展 PDF 阅读器中的 AI 翻译问题
- 修复新版 Chrome LanguageModel API 的输出语言错误
- 改进 Gemini Nano 输出清理，不再使用缓慢的二次模型调用
- 移除结果卡片中的可见发音文本，同时保留朗读功能
- 修复 PDF 拖放、blob URL 和远程 PDF 加载路径
- 避免在非 PDF 页面上执行不必要的 PDF 检测请求
- 改进扩展错误信息显示

## Traditional Chinese

### Short Description

在清爽的側邊欄中翻譯選取文字、單字、網頁和 PDF，並支援可用環境下的 AI 翻譯。

### Detailed Description

EdgeTranslate 是一款適合日常閱讀的瀏覽器翻譯擴充功能。你可以在網頁中選取文字，並在清爽的側邊欄中查看翻譯結果，同時使用朗讀、複製、編輯結果和固定面板等功能。

4.x 版本帶來全新的 Material 風格介面、深色模式、升級後的 PDF 閱讀器，以及在受支援的 Chrome 環境中可用的本機 AI 翻譯能力。

主要功能：

- 在側邊欄中翻譯選取文字
- 翻譯單字，並在供應商支援時顯示釋義、詳細含義、定義和例句
- 朗讀原文或譯文
- 使用實用的網頁翻譯引擎翻譯網頁
- 在內建 pdf.js 閱讀器中開啟 PDF，並翻譯 PDF 內選取的文字
- 重新設計的 PDF 工具列、頁面側邊欄、選單和文件屬性視窗
- 翻譯面板、設定頁、彈出視窗和 PDF 閱讀器支援深色模式
- 設定翻譯按鈕行為、翻譯供應商、語言、黑名單和快捷鍵
- 在裝置和 Chrome 支援時使用基於 Gemini Nano 的 Chrome 內建 AI 翻譯

AI 翻譯說明：
Chrome 本機 AI 翻譯取決於你的 Chrome 版本、裝置支援情況、功能可用性和本機模型下載狀態。它更適合短文字和單字輔助翻譯。由於目前 Gemini Nano 的整頁翻譯速度和發熱表現還不適合日常使用，本擴充功能不提供 Gemini Nano 整頁翻譯選項。

隱私：
EdgeTranslate 不加入分析統計或追蹤功能。需要翻譯的文字只會傳送到你選擇或設定的翻譯供應商。可用時，Chrome 本機 AI 翻譯會使用 Chrome 內建的本機模型路徑。

### What's New in 4.0.1

- 修復擴充功能 PDF 閱讀器中的 AI 翻譯問題
- 修復新版 Chrome LanguageModel API 的輸出語言錯誤
- 改進 Gemini Nano 輸出清理，不再使用緩慢的二次模型呼叫
- 移除結果卡片中的可見發音文字，同時保留朗讀功能
- 修復 PDF 拖放、blob URL 和遠端 PDF 載入路徑
- 避免在非 PDF 頁面上執行不必要的 PDF 偵測請求
- 改進擴充功能錯誤訊息顯示
