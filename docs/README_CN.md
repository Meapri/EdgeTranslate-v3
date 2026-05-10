# EdgeTranslate-v3

EdgeTranslate-v3 是一个基于原版 [Edge Translate](https://github.com/EdgeTranslate/EdgeTranslate)
项目的 Manifest V3 浏览器翻译扩展。这个分支保留了熟悉的划词翻译工作流，同时针对当前
Chrome、Firefox 和 Safari 的扩展政策进行了现代化调整。

4.x 版本重点改进了 Material 风格界面、深度更新的 pdf.js 阅读器、深色模式、翻译面板易用性，
并在浏览器支持时提供实验性的 Chrome 本机 AI 翻译，也就是 Gemini Nano 路径。

- 当前仓库：[Meapri/EdgeTranslate-v3](https://github.com/Meapri/EdgeTranslate-v3)
- 原始项目：[EdgeTranslate/EdgeTranslate](https://github.com/EdgeTranslate/EdgeTranslate)
- 最新版本：[v4.0.1](https://github.com/Meapri/EdgeTranslate-v3/releases/tag/v4.0.1)

## 其他语言

- [English](../README.md)
- [繁體中文](./README_TW.md)
- [日本語](./README_JA.md)
- [한국어](./README_KO.md)
- [Русский](./README_RU.md)

## 亮点

- 在侧边栏中进行划词翻译，支持复制、编辑、固定、调整大小和朗读。
- 单词辅助功能可在所选供应商支持时显示翻译、详细含义、定义和例句。
- 支持 Chrome 内置 AI 翻译，用于普通文本和单词翻译流程。
- Google 等实用引擎仍可用于整页翻译。
- 内置 pdf.js 阅读器，支持在 PDF 中选中文字并翻译。
- Material 风格的 PDF 工具栏、菜单、对话框、页面侧栏和深色模式。
- PDF 阅读器、翻译面板、弹出窗口和设置页均支持深色模式。
- 设置页经过整理，供应商名称更清晰，视觉干扰更少。
- 支持快捷键、黑名单控制和可配置的翻译按钮行为。

## 截图

### 划词翻译

![浮动翻译面板](./images/readme/selection-floating-panel.png)

![固定侧边翻译面板](./images/readme/selection-side-panel.png)

### PDF 翻译

![Material 风格 PDF 阅读器](./images/readme/pdf-viewer.png)

![PDF 划词翻译](./images/readme/pdf-selection-translation.png)

## AI 翻译说明

当浏览器提供 `LanguageModel` API 时，Chrome 的本机 Gemini Nano 路径会作为 AI 翻译供应商出现。
它适合较短的选中文本和单词辅助任务，但本分支不会把它作为整页翻译引擎使用。

重要行为：

- Gemini Nano 整页翻译已从用户可见的页面翻译选项中移除，因为当前本机性能还不适合整页翻译。
- 普通 AI 翻译会限制并发数量，以在响应速度和 CPU 温度之间取得更合理的平衡。
- 翻译输出会被防御性解析，避免格式错误的 JSON 直接显示在翻译面板中。
- 常见的 AI 未翻译片段会在不执行缓慢二次模型调用的情况下清理。
- 结果卡片中不再显示可见的发音文本；朗读功能仍然保留。

Chrome 的 `LanguageModel` API 和 Gemini Nano 可用性取决于用户的 Chrome 版本、设备、功能开关和
模型下载状态。不可用时，扩展会回退到已配置的供应商路径，而不会把 AI 翻译当作必需运行环境。

## PDF 阅读器

EdgeTranslate-v3 会将受支持的 PDF 链接打开到内置 pdf.js 阅读器中，使文档内的文字选择和翻译可以正常工作。
4.x 阅读器使用 pdf.js `5.7.284`，并包含大量布局和交互修复。

PDF 行为：

- Web PDF 链接可被重定向到扩展阅读器以便翻译。
- 当 Chrome 为扩展启用“允许访问文件网址”后，可以打开本地 PDF。
- 拖入的 PDF 文件和基于 blob 的阅读器 URL 会被预加载或修复，使 pdf.js 能可靠加载。
- 阅读器提供原生阅读器绕过操作，方便用户在 EdgeTranslate 外部打开当前文档。
- PDF 检测回退会避免探测无关的非 PDF 页面，从而减少 Chrome Web Store 开发者控制台等页面上的 CORS 噪音。

## 浏览器支持

### Chrome

- 划词翻译
- PDF 阅读器和 PDF 划词翻译
- Google 整页翻译
- 在浏览器和设备支持时使用 Chrome 内置 AI 翻译
- 通过 offscreen document 支持扩展上下文中的 AI 翻译

### Firefox

- 划词翻译
- PDF 阅读器和 PDF 划词翻译，但存在浏览器相关限制
- 不支持 Chrome 内置 AI 翻译
- 不提供 Chrome 专属的整页翻译行为

### Safari

- 通过 Safari 扩展构建路径支持划词翻译和 PDF 阅读器
- 不支持 Chrome 内置 AI 翻译
- Safari 发布需要 Xcode 项目和 Apple 凭据

## 下载

- [GitHub Releases](https://github.com/Meapri/EdgeTranslate-v3/releases)
- [Chrome Web Store](https://chromewebstore.google.com/detail/edge-translate/pljeedmkegkcfkgdicjnalbllhifnnnj)

发布资源通常包括：

- `edge_translate_chrome.zip`
- `edge_translate_firefox.xpi`

## 开发环境

请在仓库根目录下工作。

```bash
npm ci
```

运行单元测试：

```bash
npm test
```

直接运行 EdgeTranslate 工作区测试：

```bash
npm test -w edge_translate -- --runInBand
```

## 构建命令

构建默认 Chrome 目标：

```bash
npm run build:chrome
```

构建单独目标：

```bash
npm run build:chrome
npm run build:firefox
npm run build:safari
```

创建浏览器安装包：

```bash
npm run pack:chrome -w edge_translate
npm run pack:firefox -w edge_translate
```

验证 Firefox 包：

```bash
npm run lint:firefox
```

构建输出：

- Chrome 解包构建：`packages/EdgeTranslate/build/chrome/`
- Firefox 解包构建：`packages/EdgeTranslate/build/firefox/`
- Chrome 安装包：`packages/EdgeTranslate/build/edge_translate_chrome.zip`
- Firefox 安装包：`packages/EdgeTranslate/build/edge_translate_firefox.xpi`
- Safari 构建输出：`packages/EdgeTranslate/build/safari/`

## 加载本地构建

### Chrome

1. 打开 `chrome://extensions`。
2. 启用开发者模式。
3. 点击“加载已解压的扩展程序”。
4. 选择 `packages/EdgeTranslate/build/chrome/`。
5. 如果需要翻译本地 PDF 或文件，请启用“允许访问文件网址”。

### Firefox

1. 打开 `about:debugging`。
2. 选择“This Firefox”。
3. 点击“Load Temporary Add-on”。
4. 选择 `packages/EdgeTranslate/build/firefox/` 中的任意文件，或使用生成的
   `edge_translate_firefox.xpi`。

### Safari

Safari 构建位于 `packages/EdgeTranslate/safari-xcode/`。

常用命令：

```bash
npm run build:safari
npm run safari:sync -w edge_translate
npm run safari:release -w edge_translate
```

`safari:release` 会构建、同步资源到 Xcode 项目、归档、导出并上传。它需要有效的 App Store 凭据。

## 权限

扩展使用主机访问权限，以便在用户页面上执行划词翻译、PDF 检测和内容脚本。Chrome 构建还会请求
`offscreen`，以便在页面注入不可用的场景中从扩展文档上下文运行 Gemini Nano 翻译，例如扩展内置 PDF 阅读器。

主要权限类别：

- `activeTab`、`tabs` 和 `scripting` 用于划词翻译和页面交互。
- `contextMenus` 和 `storage` 用于命令和用户设置。
- `webNavigation` 和 `webRequest` 用于 PDF 检测和阅读器路由。
- Chrome 上的 `offscreen` 用于扩展上下文中的 AI 翻译。

## 隐私

- 本分支不添加分析统计或遥测收集。
- 翻译文本只会发送到用户选择或配置的供应商。
- 可用时，Chrome 本机 AI 翻译会通过 Chrome 内置的本地模型路径运行。
- 文件网址访问是可选的，并由浏览器扩展设置控制。

## 发布检查清单

常规发布流程：

1. 更新 `packages/EdgeTranslate/package.json`。
2. 更新 `package-lock.json`。
3. 更新 `packages/EdgeTranslate/src/manifest.json`。
4. 运行测试和浏览器打包。
5. 创建发布提交和标签，例如 `v4.0.1`。
6. 将 Chrome 和 Firefox 包上传到 GitHub Releases。

旧版项目检查清单见 [RELEASE_CHECKLIST.md](../RELEASE_CHECKLIST.md)。

## 文档

原项目的旧版功能说明仍可作为一般行为参考：

- [Instructions](./wiki/en/Instructions.md)
- [Precautions](./wiki/en/Precautions.md)
- [Privacy Policy](./wiki/en/PrivacyPolicy.md)
- [Local LLM Translate Proxy](./local-llm-translate-proxy.md)

## 许可证

本项目沿用原 Edge Translate 项目的许可证结构。

- [LICENSE.MIT](../LICENSE.MIT)
- [LICENSE.NPL](../LICENSE.NPL)

## 致谢

感谢原 Edge Translate 的维护者和贡献者。EdgeTranslate-v3 继承了这一基础，并继续为 Manifest V3
浏览器、现代浏览器 API、PDF 工作流和 AI 辅助翻译进行适配。
