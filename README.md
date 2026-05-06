## EdgeTranslate-v3 (MV3)

A fork of Edge Translate refactored for Manifest V3, modern build tooling, and current browser policies. After the original MV2-based version was removed from stores, this project modernizes the code and build to preserve the same user experience with improved stability.

- Original repo: [EdgeTranslate/EdgeTranslate](https://github.com/EdgeTranslate/EdgeTranslate)
- Current repo: [Meapri/EdgeTranslate-v3](https://github.com/Meapri/EdgeTranslate-v3)

View this page in other languages:
- [简体中文](./docs/README_CN.md)
- [繁體中文](./docs/README_TW.md)
- [日本語](./docs/README_JA.md)
- [한국어](./docs/README_KO.md)

### Key Features
- Selection translation with side popup: Shows results in a side panel so your reading flow isn’t interrupted. You can customize visible sections (common meanings, pronunciation, definitions/detailed explanations, examples, etc.) and pin the panel.
- PDF translation/viewer: Built-in pdf.js viewer supports word/sentence translation within PDFs. Page dark mode (color inversion) and UI tweaks improve readability.
- Full-page translation (Chrome only): Trigger from the context menu when needed. It never runs automatically. Not available on Safari/Firefox.
- Shortcuts: Quickly operate selection translation, pin/unpin the result panel, and expand panels using only the keyboard.
- Blacklist: Add the current page/domain to disable selection/double-click translation on that page.
- Text-to-Speech (TTS): Prefers higher-quality voices for more natural reading.

### Downloads
- [Chrome Web Store](https://chromewebstore.google.com/detail/edge-translate/pljeedmkegkcfkgdicjnalbllhifnnnj)
- [GitHub Releases](https://github.com/Meapri/EdgeTranslate-v3/releases)

### Browser Support and Limits
- Chrome: Selection translation, PDF viewer, full-page translation
- Firefox: Selection translation, PDF viewer (some limitations due to browser issues), no full-page translation
- Safari (macOS): Selection translation, PDF viewer, no full-page translation (platform policies/limits)

### PDF Viewer Notes
- PDF links are intentionally opened in the built-in EdgeTranslate/pdf.js viewer so selection translation also works inside PDFs.
- Local/downloaded PDFs (`file://`) remain handled by the extension viewer when Chrome's “Allow access to file URLs” is enabled. The viewer avoids blob-preloading local files so PDF.js can load them directly.
- Use the **Open original PDF** button in the PDF viewer toolbar to leave the extension viewer for the current document. That action adds a one-time native-viewer bypass marker to prevent redirect loops.

### Privacy & Security
- No analytics/statistics collection; no tracking
- Minimal-permissions principle
- On Chrome, “Allow access to file URLs” may be needed for file:// pages

### Installation (for development/testing)
Chrome (Developer Mode)
1) Open `chrome://extensions` and enable Developer mode
2) Build below, then “Load unpacked” → select `build/chrome`

Firefox (Temporary Load)
1) Open `about:debugging` → Load Temporary Add-on → select any file in `build/firefox`

Safari (macOS)
1) Run via the Xcode project with synchronized resources (see Development/Build)

### Development / Build
Working directory: repository root.

1) Install dependencies
```
npm ci
```

2) Run tests
```
npm test
```

3) Default build
```
npm run build
```
This builds shared translator packages and the primary Chrome extension build.

Per-browser builds
```
npm run build:chrome
npm run build:firefox
npm run build:safari
```

Firefox installable package and validation
```
npm run pack:firefox
npm run lint:firefox
```

All-browser packaging/build
```
npm run build:all
```

Safari notes
- `npm run build:safari` only writes `packages/EdgeTranslate/build/safari/`. It does not mutate the Xcode `Resources/` directory.
- Use `npm run safari:sync -w edge_translate` only when you intentionally want to copy `build/safari/` into the Xcode project.
- `npm run safari:release -w edge_translate` performs build, sync, archive, export, and upload, and requires App Store credentials.

Build outputs
- Chrome: `packages/EdgeTranslate/build/chrome/`
- Firefox unpacked build: `packages/EdgeTranslate/build/firefox/`
- Firefox installable package: `packages/EdgeTranslate/build/edge_translate_firefox.xpi`
- Safari build output: `packages/EdgeTranslate/build/safari/`
- Safari Xcode resources: `packages/EdgeTranslate/safari-xcode/EdgeTranslate/EdgeTranslate Extension/Resources/` after explicit sync/release only

### Host Permissions
Global host permissions are required for always-on content scripts (selection translation, etc.). Chrome uses `host_permissions: ["*://*/*"]`; Firefox/Safari use `<all_urls>`-matched content scripts. The extension adheres to a minimal-permissions approach.

 

### Documentation
- Original project docs (general feature reference):
  - Instructions: [Edge Translate Instructions](https://github.com/EdgeTranslate/EdgeTranslate/blob/master/docs/wiki/en/Instructions.md)
  - Precautions: [Edge Translate Precautions](https://github.com/EdgeTranslate/EdgeTranslate/blob/master/docs/wiki/en/Precautions.md)

### License
- MIT AND NPL, same as the original project
- License files: [LICENSE.MIT](./LICENSE.MIT), [LICENSE.NPL](./LICENSE.NPL)

### Credits
- Thanks to the original Edge Translate and all contributors.
- This fork rebuilds the project for MV3 and modern browsers while preserving the original UX.
