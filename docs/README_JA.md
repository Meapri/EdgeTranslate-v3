## EdgeTranslate-v3（MV3）

他言語版はこちら：
- [English](../README.md)
- [简体中文](./README_CN.md)
- [繁體中文](./README_TW.md)
- [日本語](./README_JA.md)
- [한국어](./README_KO.md)

本プロジェクトは Edge Translate のフォークで、Manifest V3 に合わせて全面的にリファクタリングし、最新のブラウザー方針とビルド体制に適合させています。元の MV2 版がストアから削除された後も、同様のユーザー体験を維持しつつ安定性を高めるために近代化しました。

- 元リポジトリ: [EdgeTranslate/EdgeTranslate](https://github.com/EdgeTranslate/EdgeTranslate)
- 現在のリポジトリ: [Meapri/EdgeTranslate-v3](https://github.com/Meapri/EdgeTranslate-v3)

### 主な機能
- 選択翻訳とサイドポップアップ: 選択したテキストの結果をサイドパネルに表示し、読書の流れを妨げません。表示項目（一般的な意味、発音、定義/詳細説明、例文 など）をカスタマイズでき、パネルのピン留めも可能です。
- PDF 翻訳/ビューア: 内蔵の pdf.js ビューアで PDF 内の単語/文章翻訳をサポート。ページのダークモード（色反転）や UI 改善で可読性を向上。
- ページ全体の翻訳（Chrome のみ）: 必要時にコンテキストメニューから実行します。自動では実行されません。Safari/Firefox では非対応。
- ショートカット: キーボードのみで選択翻訳、パネルのピン留め/解除、パネル展開などを素早く操作。
- ブラックリスト: 現在のページ/ドメインをブロックリストに追加し、そのページでの選択/ダブルクリック翻訳を無効化。
- 音声読み上げ（TTS）: より高品質な音声を優先して自然な読み上げを提供。

### ダウンロード
- [Chrome ウェブストア](https://chromewebstore.google.com/detail/edge-translate/pljeedmkegkcfkgdicjnalbllhifnnnj)
- [GitHub Releases](https://github.com/Meapri/EdgeTranslate-v3/releases)

### 対応ブラウザーと制限
- Chrome: 選択翻訳、PDF ビューア、ページ全体の翻訳
- Firefox: 選択翻訳、PDF ビューア（ブラウザーの問題により一部制限あり）、ページ全体の翻訳は非対応
- Safari（macOS）: 選択翻訳、PDF ビューア、ページ全体の翻訳は非対応（プラットフォームの方針/制限）

### PDF ビューアの注意事項
- PDF リンクは意図的に EdgeTranslate 内蔵の pdf.js ビューアで開きます。これにより PDF 内でも選択翻訳を利用できます。
- ローカル/ダウンロード済み PDF（`file://`）も、Chrome で「ファイルの URL へのアクセスを許可」が有効な場合は拡張機能ビューアで処理されます。ローカルファイルは blob として事前読み込みせず、PDF.js が直接読み込むようにして空白ページ問題を抑えています。
- 現在の文書だけを元の/ブラウザー標準 PDF ビューアで開きたい場合は、PDF ビューアのツールバーにある **Open original PDF** ボタンを使用してください。この操作ではリダイレクトループを避けるため、一時的なバイパスマーカーを URL に追加します。

### プライバシーとセキュリティ
- 分析/統計は収集せず、トラッキングもしません
- 最小権限の原則
- Chrome の `file://` ページでは「ファイルの URL へのアクセスを許可」を有効にする必要がある場合があります

### インストール（開発/テスト向け）
Chrome（デベロッパーモード）
1）`chrome://extensions` を開き、デベロッパーモードを有効化
2）ビルド後、「パッケージ化されていない拡張機能を読み込む」→ `build/chrome` を選択

Firefox（一時的に読み込み）
1）`about:debugging` → 一時的なアドオンを読み込む → `build/firefox` 内の任意のファイルを選択

Safari（macOS）
1）Xcode プロジェクトで実行（リソース同期が必要。開発/ビルド参照）

### 開発 / ビルド
作業ディレクトリ: リポジトリのルート。

1）依存関係のインストール
```
npm ci
```

2）テストの実行
```
npm test
```

3）デフォルトビルド
```
npm run build
```
共有 translators パッケージと、主要ターゲットである Chrome 拡張機能をビルドします。

ブラウザー別ビルド
```
npm run build:chrome
npm run build:firefox
npm run build:safari
```

Firefox インストール用パッケージと検証
```
npm run pack:firefox
npm run lint:firefox
```

全ブラウザーのパッケージング/ビルド
```
npm run build:all
```

Safari の注意事項
- `npm run build:safari` は `packages/EdgeTranslate/build/safari/` のみを生成し、Xcode の `Resources/` ディレクトリは変更しません。
- Xcode プロジェクトへ明示的に同期する必要がある場合のみ `npm run safari:sync -w edge_translate` を実行してください。
- `npm run safari:release -w edge_translate` は build、sync、archive、export、upload を実行し、App Store 認証情報の環境変数が必要です。

ビルド出力
- Chrome: `packages/EdgeTranslate/build/chrome/`
- Firefox 展開済みビルド: `packages/EdgeTranslate/build/firefox/`
- Firefox インストール用パッケージ: `packages/EdgeTranslate/build/edge_translate_firefox.xpi`
- Safari ビルド出力: `packages/EdgeTranslate/build/safari/`
- Safari Xcode リソース: 明示的な sync/release 後に `packages/EdgeTranslate/safari-xcode/EdgeTranslate/EdgeTranslate Extension/Resources/`

### ホスト権限
常駐コンテンツスクリプト（選択翻訳 等）のためにグローバルなホスト権限が必要です。Chrome は `host_permissions: ["*://*/*"]`、Firefox/Safari は `<all_urls>` にマッチするコンテンツスクリプトを使用します。拡張機能は最小権限の方針に従います。

 

### ドキュメント
- 元プロジェクトのドキュメント（全体機能の参考）:
  - Instructions: [Edge Translate Instructions](https://github.com/EdgeTranslate/EdgeTranslate/blob/master/docs/wiki/en/Instructions.md)
  - Precautions: [Edge Translate Precautions](https://github.com/EdgeTranslate/EdgeTranslate/blob/master/docs/wiki/en/Precautions.md)

### ライセンス
- 元プロジェクトと同じ: MIT および NPL
- ライセンスファイル: [LICENSE.MIT](../LICENSE.MIT) / [LICENSE.NPL](../LICENSE.NPL)

### クレジット
- 元の Edge Translate と全ての貢献者に感謝します。
- 本フォークは、元の UX を維持しつつ、MV3 と最新ブラウザー向けに再構築しています。
