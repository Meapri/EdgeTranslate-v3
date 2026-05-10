# EdgeTranslate-v3

EdgeTranslate-v3 是一個基於原版 [Edge Translate](https://github.com/EdgeTranslate/EdgeTranslate)
專案的 Manifest V3 瀏覽器翻譯擴充功能。這個分支保留熟悉的劃詞翻譯工作流程，同時針對目前
Chrome、Firefox 和 Safari 的擴充功能政策進行現代化調整。

4.x 版本著重於更新後的 Material 風格介面、深度更新的 pdf.js 閱讀器、深色模式、翻譯面板易用性，
並在瀏覽器支援時提供實驗性的 Chrome 本機 AI 翻譯，也就是 Gemini Nano 路徑。

- 目前倉庫：[Meapri/EdgeTranslate-v3](https://github.com/Meapri/EdgeTranslate-v3)
- 原始專案：[EdgeTranslate/EdgeTranslate](https://github.com/EdgeTranslate/EdgeTranslate)
- 最新版本：[v4.0.1](https://github.com/Meapri/EdgeTranslate-v3/releases/tag/v4.0.1)

## 其他語言

- [English](../README.md)
- [简体中文](./README_CN.md)
- [日本語](./README_JA.md)
- [한국어](./README_KO.md)
- [Русский](./README_RU.md)

## 亮點

- 在側邊欄中進行劃詞翻譯，支援複製、編輯、固定、調整大小和朗讀。
- 單字輔助功能可在所選供應商支援時顯示翻譯、詳細含義、定義和例句。
- 支援 Chrome 內建 AI 翻譯，用於一般文字和單字翻譯流程。
- Google 等實用引擎仍可用於整頁翻譯。
- 內建 pdf.js 閱讀器，支援在 PDF 中選取文字並翻譯。
- Material 風格的 PDF 工具列、選單、對話框、頁面側邊欄和深色模式。
- PDF 閱讀器、翻譯面板、彈出視窗和設定頁均支援深色模式。
- 設定頁經過整理，供應商名稱更清楚，視覺干擾更少。
- 支援快捷鍵、黑名單控制和可設定的翻譯按鈕行為。

## AI 翻譯說明

當瀏覽器提供 `LanguageModel` API 時，Chrome 的本機 Gemini Nano 路徑會作為 AI 翻譯供應商出現。
它適合較短的選取文字和單字輔助任務，但本分支不會將它作為整頁翻譯引擎使用。

重要行為：

- Gemini Nano 整頁翻譯已從使用者可見的頁面翻譯選項中移除，因為目前本機效能還不適合整頁翻譯。
- 一般 AI 翻譯會限制並行數量，以在回應速度和 CPU 溫度之間取得較合理的平衡。
- 翻譯輸出會被防禦性解析，避免格式錯誤的 JSON 直接顯示在翻譯面板中。
- 常見的 AI 未翻譯片段會在不執行緩慢二次模型呼叫的情況下清理。
- 結果卡片中不再顯示可見的發音文字；朗讀功能仍然保留。

Chrome 的 `LanguageModel` API 和 Gemini Nano 可用性取決於使用者的 Chrome 版本、裝置、功能開關和
模型下載狀態。不可用時，擴充功能會回退到已設定的供應商路徑，而不會把 AI 翻譯視為必要執行環境。

## PDF 閱讀器

EdgeTranslate-v3 會將受支援的 PDF 連結開啟到內建 pdf.js 閱讀器中，使文件內的文字選取和翻譯可以正常運作。
4.x 閱讀器使用 pdf.js `5.7.284`，並包含大量版面和互動修正。

PDF 行為：

- Web PDF 連結可被重新導向到擴充功能閱讀器以便翻譯。
- 當 Chrome 為擴充功能啟用「允許存取檔案網址」後，可以開啟本機 PDF。
- 拖入的 PDF 檔案和基於 blob 的閱讀器 URL 會被預載或修復，使 pdf.js 能可靠載入。
- 閱讀器提供原生閱讀器繞過操作，方便使用者在 EdgeTranslate 外部開啟目前文件。
- PDF 偵測回退會避免探測無關的非 PDF 頁面，從而減少 Chrome Web Store 開發者控制台等頁面上的 CORS 雜訊。

## 瀏覽器支援

### Chrome

- 劃詞翻譯
- PDF 閱讀器和 PDF 劃詞翻譯
- Google 整頁翻譯
- 在瀏覽器和裝置支援時使用 Chrome 內建 AI 翻譯
- 透過 offscreen document 支援擴充功能上下文中的 AI 翻譯

### Firefox

- 劃詞翻譯
- PDF 閱讀器和 PDF 劃詞翻譯，但存在瀏覽器相關限制
- 不支援 Chrome 內建 AI 翻譯
- 不提供 Chrome 專屬的整頁翻譯行為

### Safari

- 透過 Safari 擴充功能建置路徑支援劃詞翻譯和 PDF 閱讀器
- 不支援 Chrome 內建 AI 翻譯
- Safari 發布需要 Xcode 專案和 Apple 憑證

## 下載

- [GitHub Releases](https://github.com/Meapri/EdgeTranslate-v3/releases)
- [Chrome Web Store](https://chromewebstore.google.com/detail/edge-translate/pljeedmkegkcfkgdicjnalbllhifnnnj)

發布資源通常包括：

- `edge_translate_chrome.zip`
- `edge_translate_firefox.xpi`

## 開發環境

請在倉庫根目錄下工作。

```bash
npm ci
```

執行單元測試：

```bash
npm test
```

直接執行 EdgeTranslate 工作區測試：

```bash
npm test -w edge_translate -- --runInBand
```

## 建置命令

建置預設 Chrome 目標：

```bash
npm run build:chrome
```

建置個別目標：

```bash
npm run build:chrome
npm run build:firefox
npm run build:safari
```

建立瀏覽器安裝包：

```bash
npm run pack:chrome -w edge_translate
npm run pack:firefox -w edge_translate
```

驗證 Firefox 套件：

```bash
npm run lint:firefox
```

建置輸出：

- Chrome 解包建置：`packages/EdgeTranslate/build/chrome/`
- Firefox 解包建置：`packages/EdgeTranslate/build/firefox/`
- Chrome 安裝包：`packages/EdgeTranslate/build/edge_translate_chrome.zip`
- Firefox 安裝包：`packages/EdgeTranslate/build/edge_translate_firefox.xpi`
- Safari 建置輸出：`packages/EdgeTranslate/build/safari/`

## 載入本機建置

### Chrome

1. 開啟 `chrome://extensions`。
2. 啟用開發人員模式。
3. 點擊「載入未封裝項目」。
4. 選擇 `packages/EdgeTranslate/build/chrome/`。
5. 如果需要翻譯本機 PDF 或檔案，請啟用「允許存取檔案網址」。

### Firefox

1. 開啟 `about:debugging`。
2. 選擇「This Firefox」。
3. 點擊「Load Temporary Add-on」。
4. 選擇 `packages/EdgeTranslate/build/firefox/` 中的任意檔案，或使用產生的
   `edge_translate_firefox.xpi`。

### Safari

Safari 建置位於 `packages/EdgeTranslate/safari-xcode/`。

常用命令：

```bash
npm run build:safari
npm run safari:sync -w edge_translate
npm run safari:release -w edge_translate
```

`safari:release` 會建置、同步資源到 Xcode 專案、封存、匯出並上傳。它需要有效的 App Store 憑證。

## 權限

擴充功能使用主機存取權限，以便在使用者頁面上執行劃詞翻譯、PDF 偵測和內容腳本。Chrome 建置還會請求
`offscreen`，以便在頁面注入不可用的場景中從擴充功能文件上下文執行 Gemini Nano 翻譯，例如擴充功能內建 PDF 閱讀器。

主要權限類別：

- `activeTab`、`tabs` 和 `scripting` 用於劃詞翻譯和頁面互動。
- `contextMenus` 和 `storage` 用於命令和使用者設定。
- `webNavigation` 和 `webRequest` 用於 PDF 偵測和閱讀器路由。
- Chrome 上的 `offscreen` 用於擴充功能上下文中的 AI 翻譯。

## 隱私

- 本分支不加入分析統計或遙測收集。
- 翻譯文字只會傳送到使用者選擇或設定的供應商。
- 可用時，Chrome 本機 AI 翻譯會透過 Chrome 內建的本機模型路徑執行。
- 檔案網址存取是選用的，並由瀏覽器擴充功能設定控制。

## 發布檢查清單

一般發布流程：

1. 更新 `packages/EdgeTranslate/package.json`。
2. 更新 `package-lock.json`。
3. 更新 `packages/EdgeTranslate/src/manifest.json`。
4. 執行測試和瀏覽器打包。
5. 建立發布提交和標籤，例如 `v4.0.1`。
6. 將 Chrome 和 Firefox 套件上傳到 GitHub Releases。

舊版專案檢查清單見 [RELEASE_CHECKLIST.md](../RELEASE_CHECKLIST.md)。

## 文件

原專案的舊版功能說明仍可作為一般行為參考：

- [Instructions](./wiki/en/Instructions.md)
- [Precautions](./wiki/en/Precautions.md)
- [Privacy Policy](./wiki/en/PrivacyPolicy.md)
- [Local LLM Translate Proxy](./local-llm-translate-proxy.md)

## 授權

本專案沿用原 Edge Translate 專案的授權結構。

- [LICENSE.MIT](../LICENSE.MIT)
- [LICENSE.NPL](../LICENSE.NPL)

## 致謝

感謝原 Edge Translate 的維護者和貢獻者。EdgeTranslate-v3 繼承了這個基礎，並持續為 Manifest V3
瀏覽器、現代瀏覽器 API、PDF 工作流程和 AI 輔助翻譯進行適配。
