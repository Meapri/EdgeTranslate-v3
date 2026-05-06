## EdgeTranslate-v3（MV3）

查看其他语言版本：
- [English](../README.md)
- [简体中文](./README_CN.md)
- [繁體中文](./README_TW.md)
- [日本語](./README_JA.md)
- [한국어](./README_KO.md)

本项目是 Edge Translate 的分支，已按 Manifest V3 全面重构，并适配当前浏览器政策与构建流程。在原始 MV2 版本因政策下架后，本项目对代码与构建进行了现代化处理，以延续相同的使用体验并提升稳定性。

- 原始仓库：[EdgeTranslate/EdgeTranslate](https://github.com/EdgeTranslate/EdgeTranslate)
- 现用仓库：[Meapri/EdgeTranslate-v3](https://github.com/Meapri/EdgeTranslate-v3)

### 主要功能
- 选择翻译与侧边弹窗：结果以侧边面板呈现，不打断阅读流程。可自定义显示项（常用释义、发音、定义/详解、例句等），支持固定面板。
- PDF 翻译/阅读器：内置 pdf.js 阅读器，支持在 PDF 内翻译单词/句子。加入页面深色模式（颜色反转）与 UI 调整以提升可读性。
- 整页翻译（仅限 Chrome）：从右键菜单按需触发，不会自动运行。Safari/Firefox 不提供。
- 快捷键：使用键盘即可快速执行选择翻译、固定/取消固定结果面板、展开面板等。
- 黑名单：将当前页面/域名加入黑名单，在该页面停用选择/双击翻译。
- 文本转语音（TTS）：优先选择更高质量的语音，朗读更自然。

### 下载
- [Chrome 应用商店](https://chromewebstore.google.com/detail/edge-translate/pljeedmkegkcfkgdicjnalbllhifnnnj)
- [GitHub Releases](https://github.com/Meapri/EdgeTranslate-v3/releases)

### 浏览器支持与限制
- Chrome：选择翻译、PDF 阅读器、整页翻译
- Firefox：选择翻译、PDF 阅读器（受浏览器问题限制部分功能）、不提供整页翻译
- Safari（macOS）：选择翻译、PDF 阅读器、不提供整页翻译（平台政策/限制）

### PDF 阅读器说明
- PDF 链接会有意打开到 EdgeTranslate 内置的 pdf.js 阅读器中，这样才能在 PDF 内继续使用划词翻译。
- 本地/已下载 PDF（`file://`）在 Chrome 启用“允许访问文件 URL”后仍由扩展阅读器处理。阅读器不会把本地文件预加载成 blob，而是让 PDF.js 直接读取，以减少空白页问题。
- 如需仅对当前文档返回原始/浏览器 PDF 阅读器，可点击 PDF 阅读器工具栏中的 **Open original PDF**。该操作会在 URL 上添加一次性绕过标记，避免再次重定向形成循环。

### 隐私与安全
- 不收集分析/统计，不跟踪
- 最小权限原则
- 在 Chrome 上，如需访问 `file://` 页面，可能需要启用“允许访问文件 URL”

### 安装（用于开发/测试）
Chrome（开发者模式）
1）打开 `chrome://extensions` 并开启开发者模式
2）完成构建后选择“加载已解压的扩展程序”→ `build/chrome`

Firefox（临时加载）
1）打开 `about:debugging` → 加载临时附加组件 → 在 `build/firefox` 中选择任意文件

Safari（macOS）
1）通过 Xcode 项目运行（资源需同步，见开发/构建）

### 开发 / 构建
工作目录：仓库根目录。

1）安装依赖
```
npm ci
```

2）运行测试
```
npm test
```

3）默认构建
```
npm run build
```
该命令会构建共享 translators 包以及主要目标 Chrome 扩展。

按浏览器分别构建
```
npm run build:chrome
npm run build:firefox
npm run build:safari
```

Firefox 可安装包与验证
```
npm run pack:firefox
npm run lint:firefox
```

全部浏览器打包/构建
```
npm run build:all
```

Safari 说明
- `npm run build:safari` 只生成 `packages/EdgeTranslate/build/safari/`，不会修改 Xcode `Resources/` 目录。
- 只有需要同步到 Xcode 项目时，才运行 `npm run safari:sync -w edge_translate`。
- `npm run safari:release -w edge_translate` 会执行 build、sync、archive、export、upload，并需要 App Store 凭据环境变量。

构建输出位置
- Chrome：`packages/EdgeTranslate/build/chrome/`
- Firefox 未打包构建：`packages/EdgeTranslate/build/firefox/`
- Firefox 可安装包：`packages/EdgeTranslate/build/edge_translate_firefox.xpi`
- Safari 构建输出：`packages/EdgeTranslate/build/safari/`
- Safari Xcode 资源：显式 sync/release 后位于 `packages/EdgeTranslate/safari-xcode/EdgeTranslate/EdgeTranslate Extension/Resources/`

### 主机权限
为实现常驻内容脚本（如选择翻译）需要全局主机权限。Chrome 使用 `host_permissions: ["*://*/*"]`；Firefox/Safari 通过 `<all_urls>` 匹配的内容脚本实现。扩展遵循最小权限原则。

 

### 文档
- 原项目文档（整体功能参考）：
  - Instructions: [Edge Translate Instructions](https://github.com/EdgeTranslate/EdgeTranslate/blob/master/docs/wiki/en/Instructions.md)
  - Precautions: [Edge Translate Precautions](https://github.com/EdgeTranslate/EdgeTranslate/blob/master/docs/wiki/en/Precautions.md)

### 许可协议
- 与原项目一致：MIT 与 NPL
- 许可文件：[LICENSE.MIT](../LICENSE.MIT) / [LICENSE.NPL](../LICENSE.NPL)

### 致谢
- 感谢原始 Edge Translate 及所有贡献者。
- 本分支在保留原有体验的基础上，面向 MV3 与现代浏览器重构实现。
