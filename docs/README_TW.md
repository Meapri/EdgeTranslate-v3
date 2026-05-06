## EdgeTranslate-v3（MV3）

檢視其他語言版本：
- [English](../README.md)
- [简体中文](./README_CN.md)
- [繁體中文](./README_TW.md)
- [日本語](./README_JA.md)
- [한국어](./README_KO.md)

本專案是 Edge Translate 的分支，已依照 Manifest V3 全面重構，並符合現行瀏覽器政策與建置流程。原始 MV2 版本因政策下架後，本專案現代化了程式碼與建置，以延續相同的使用體驗並提升穩定性。

- 原始倉庫：[EdgeTranslate/EdgeTranslate](https://github.com/EdgeTranslate/EdgeTranslate)
- 目前倉庫：[Meapri/EdgeTranslate-v3](https://github.com/Meapri/EdgeTranslate-v3)

### 主要功能
- 選取翻譯與側邊彈窗：結果以側邊面板呈現，不中斷閱讀流程。可自訂顯示項（常用釋義、發音、定義/詳解、例句等），並可釘選面板。
- PDF 翻譯/檢視器：內建 pdf.js 檢視器，支援在 PDF 內翻譯單字/句子。加入頁面深色模式（顏色反轉）與 UI 調整以提升可讀性。
- 整頁翻譯（僅限 Chrome）：可從右鍵選單按需觸發，不會自動執行。Safari/Firefox 不提供。
- 快捷鍵：使用鍵盤即可快速操作選取翻譯、釘選/取消釘選結果面板、展開面板等。
- 黑名單：將目前頁面/網域加入封鎖清單，在該頁停用選取/雙擊翻譯。
- 文字轉語音（TTS）：優先選用更高品質的語音，朗讀更自然。

### 下載
- [Chrome 應用商店](https://chromewebstore.google.com/detail/edge-translate/pljeedmkegkcfkgdicjnalbllhifnnnj)
- [GitHub Releases](https://github.com/Meapri/EdgeTranslate-v3/releases)

### 瀏覽器支援與限制
- Chrome：選取翻譯、PDF 檢視器、整頁翻譯
- Firefox：選取翻譯、PDF 檢視器（受瀏覽器問題限制部分功能）、不提供整頁翻譯
- Safari（macOS）：選取翻譯、PDF 檢視器、不提供整頁翻譯（平台政策/限制）

### PDF 檢視器說明
- PDF 連結會刻意開啟到 EdgeTranslate 內建的 pdf.js 檢視器中，這樣才能在 PDF 內繼續使用選取翻譯。
- 本機/已下載 PDF（`file://`）在 Chrome 啟用「允許存取檔案 URL」後仍由擴充功能檢視器處理。檢視器不會將本機檔案預先載入成 blob，而是讓 PDF.js 直接讀取，以降低空白頁問題。
- 如需只針對目前文件回到原始/瀏覽器 PDF 檢視器，可點擊 PDF 檢視器工具列中的 **Open original PDF**。此操作會在 URL 加入一次性繞過標記，避免再次重導形成循環。

### 隱私與安全
- 不蒐集分析/統計，不進行追蹤
- 最小權限原則
- 在 Chrome 上，如需存取 `file://` 頁面，可能需要啟用「允許存取檔案 URL」

### 安裝（開發/測試用）
Chrome（開發人員模式）
1）開啟 `chrome://extensions` 並啟用開發人員模式
2）完成建置後選擇「載入未封裝項目」→ 指向 `build/chrome`

Firefox（臨時載入）
1）開啟 `about:debugging` → 載入臨時附加元件 → 在 `build/firefox` 中選擇任一檔案

Safari（macOS）
1）透過 Xcode 專案執行（需同步資源，見開發/建置）

### 開發 / 建置
工作目錄：倉庫根目錄。

1）安裝相依套件
```
npm ci
```

2）執行測試
```
npm test
```

3）預設建置
```
npm run build
```
此命令會建置共用 translators 套件以及主要目標 Chrome 擴充功能。

依瀏覽器分別建置
```
npm run build:chrome
npm run build:firefox
npm run build:safari
```

全部瀏覽器打包/建置
```
npm run build:all
```

Safari 說明
- `npm run build:safari` 只產生 `packages/EdgeTranslate/build/safari/`，不會修改 Xcode `Resources/` 目錄。
- 只有需要同步到 Xcode 專案時，才執行 `npm run safari:sync -w edge_translate`。
- `npm run safari:release -w edge_translate` 會執行 build、sync、archive、export、upload，並需要 App Store 憑證環境變數。

建置輸出位置
- Chrome：`packages/EdgeTranslate/build/chrome/`
- Firefox：`packages/EdgeTranslate/build/firefox/`
- Safari 建置輸出：`packages/EdgeTranslate/build/safari/`
- Safari Xcode 資源：顯式 sync/release 後位於 `packages/EdgeTranslate/safari-xcode/EdgeTranslate/EdgeTranslate Extension/Resources/`

### 主機權限
為實現常駐內容指令碼（如選取翻譯）需要全域主機權限。Chrome 使用 `host_permissions: ["*://*/*"]`；Firefox/Safari 則透過 `<all_urls>` 匹配的內容指令碼實現。擴充功能遵循最小權限原則。

 

### 文件
- 原始專案文件（功能總覽參考）：
  - Instructions: [Edge Translate Instructions](https://github.com/EdgeTranslate/EdgeTranslate/blob/master/docs/wiki/en/Instructions.md)
  - Precautions: [Edge Translate Precautions](https://github.com/EdgeTranslate/EdgeTranslate/blob/master/docs/wiki/en/Precautions.md)

### 授權
- 與原始專案相同：MIT 與 NPL
- 授權檔： [LICENSE.MIT](../LICENSE.MIT) / [LICENSE.NPL](../LICENSE.NPL)

### 誌謝
- 感謝原始 Edge Translate 與所有貢獻者。
- 本分支在保留原有體驗基礎上，面向 MV3 與現代瀏覽器重新實作。
