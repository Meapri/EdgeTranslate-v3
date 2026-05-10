# EdgeTranslate-v3

EdgeTranslate-v3 は、元の [Edge Translate](https://github.com/EdgeTranslate/EdgeTranslate)
プロジェクトをベースにした Manifest V3 対応のブラウザー翻訳拡張機能です。このフォークは、
慣れた選択テキスト翻訳の流れを保ちながら、現在の Chrome、Firefox、Safari の拡張機能ポリシーに
合わせて近代化されています。

4.x 系では、Material 風の新しい UI、大幅に更新された pdf.js ビューアー、ダークモード、
翻訳パネルの使いやすさ、そしてブラウザーが対応している場合の実験的な Chrome オンデバイス
AI 翻訳、つまり Gemini Nano 経路に重点を置いています。

- 現在のリポジトリ：[Meapri/EdgeTranslate-v3](https://github.com/Meapri/EdgeTranslate-v3)
- 元プロジェクト：[EdgeTranslate/EdgeTranslate](https://github.com/EdgeTranslate/EdgeTranslate)
- 最新リリース：[v4.0.1](https://github.com/Meapri/EdgeTranslate-v3/releases/tag/v4.0.1)

## 他の言語

- [English](../README.md)
- [简体中文](./README_CN.md)
- [繁體中文](./README_TW.md)
- [한국어](./README_KO.md)
- [Русский](./README_RU.md)

## 主な特徴

- サイドパネルでの選択テキスト翻訳。コピー、編集、固定、サイズ変更、TTS に対応。
- 選択したプロバイダーが対応している場合、単語の翻訳、詳細な意味、定義、例文を表示。
- 通常のテキスト翻訳と単語翻訳フローで Chrome 内蔵 AI 翻訳をサポート。
- Google などの実用的なエンジンは、引き続きページ全体の翻訳に利用可能。
- 内蔵 pdf.js ビューアーにより、PDF 内の選択テキスト翻訳に対応。
- Material 風に整理された PDF ツールバー、メニュー、ダイアログ、ページサイドバー、ダークモード。
- PDF ビューアー、翻訳パネル、ポップアップ、設定ページでダークモードをサポート。
- 設定ページを整理し、プロバイダー名を分かりやすくし、視覚的なノイズを削減。
- キーボードショートカット、ブラックリスト、翻訳ボタンの動作設定に対応。

## スクリーンショット

### 選択テキスト翻訳

![フローティング翻訳パネル](./images/readme/selection-floating-panel.png)

![固定サイド翻訳パネル](./images/readme/selection-side-panel.png)

### PDF 翻訳

![Material 風の PDF ビューアー](./images/readme/pdf-viewer.png)

![PDF 選択テキスト翻訳](./images/readme/pdf-selection-translation.png)

## AI 翻訳について

Chrome のオンデバイス Gemini Nano 経路は、ブラウザーが `LanguageModel` API を提供している場合に
AI 翻訳プロバイダーとして表示されます。短い選択テキストや単語補助には便利ですが、このフォークでは
ページ全体の翻訳エンジンとしては使用しません。

重要な挙動：

- 現在のオンデバイス性能ではページ全体の翻訳に実用的ではないため、Gemini Nano ページ翻訳は
  ユーザー向けのページ翻訳オプションから削除されています。
- 通常の AI 翻訳は、応答性と CPU 温度のバランスを取るために同時実行数を制限しています。
- 不正な JSON が翻訳パネルにそのまま表示されないよう、出力を防御的に解析します。
- AI モデルが残しがちな未翻訳断片は、遅い 2 回目のモデル呼び出しを行わずに後処理します。
- 結果カードから可視の発音テキストは削除されました。TTS 再生は引き続き利用できます。

Chrome の `LanguageModel` API と Gemini Nano の可用性は、Chrome のバージョン、端末、機能フラグ、
モデルのダウンロード状態によって異なります。利用できない場合、拡張機能は設定済みのプロバイダー経路に
フォールバックし、AI 翻訳を必須の実行条件として扱いません。

## PDF ビューアー

EdgeTranslate-v3 は、対応する PDF リンクを内蔵 pdf.js ビューアーで開き、文書内のテキスト選択と翻訳を
利用できるようにします。4.x のビューアーは pdf.js `5.7.284` を使用し、多くのレイアウトと操作性の修正を含みます。

PDF の挙動：

- Web 上の PDF リンクを拡張機能のビューアーへリダイレクトして翻訳できます。
- Chrome の拡張機能設定で「ファイルの URL へのアクセスを許可する」を有効にすると、ローカル PDF を開けます。
- ドラッグされた PDF ファイルや blob ベースのビューアー URL は、pdf.js が確実に読み込めるよう事前読み込みまたは修復されます。
- 現在の文書を EdgeTranslate の外側で開きたいユーザー向けに、ネイティブビューアーへ回避する操作を用意しています。
- PDF 検出のフォールバックは無関係な非 PDF ページを探査しないため、Chrome Web Store 開発者コンソールなどで不要な CORS エラーを抑えます。

## ブラウザー対応

### Chrome

- 選択テキスト翻訳
- PDF ビューアーと PDF 選択テキスト翻訳
- Google ページ全体翻訳
- ブラウザーと端末が対応している場合の Chrome 内蔵 AI 翻訳
- 拡張機能コンテキストでの AI 翻訳を支える offscreen document

### Firefox

- 選択テキスト翻訳
- PDF ビューアーと PDF 選択テキスト翻訳。ただしブラウザー固有の制限があります。
- Chrome 内蔵 AI 翻訳には非対応
- Chrome 専用のページ全体翻訳挙動には非対応

### Safari

- Safari 拡張機能のビルド経路を通じた選択テキスト翻訳と PDF ビューアー対応
- Chrome 内蔵 AI 翻訳には非対応
- Safari のリリースには Xcode プロジェクトと Apple 認証情報が必要

## ダウンロード

- [GitHub Releases](https://github.com/Meapri/EdgeTranslate-v3/releases)
- [Chrome Web Store](https://chromewebstore.google.com/detail/edge-translate/pljeedmkegkcfkgdicjnalbllhifnnnj)

通常、リリースアセットには次のファイルが含まれます。

- `edge_translate_chrome.zip`
- `edge_translate_firefox.xpi`

## 開発環境

リポジトリのルートを作業ディレクトリとして使用します。

```bash
npm ci
```

ユニットテストを実行します。

```bash
npm test
```

EdgeTranslate ワークスペースのテストを直接実行します。

```bash
npm test -w edge_translate -- --runInBand
```

## ビルドコマンド

デフォルトの Chrome ターゲットをビルドします。

```bash
npm run build:chrome
```

個別ターゲットをビルドします。

```bash
npm run build:chrome
npm run build:firefox
npm run build:safari
```

ブラウザーパッケージを作成します。

```bash
npm run pack:chrome -w edge_translate
npm run pack:firefox -w edge_translate
```

Firefox パッケージを検証します。

```bash
npm run lint:firefox
```

ビルド出力：

- Chrome の展開済みビルド：`packages/EdgeTranslate/build/chrome/`
- Firefox の展開済みビルド：`packages/EdgeTranslate/build/firefox/`
- Chrome パッケージ：`packages/EdgeTranslate/build/edge_translate_chrome.zip`
- Firefox パッケージ：`packages/EdgeTranslate/build/edge_translate_firefox.xpi`
- Safari ビルド出力：`packages/EdgeTranslate/build/safari/`

## ローカルビルドの読み込み

### Chrome

1. `chrome://extensions` を開きます。
2. デベロッパーモードを有効にします。
3. 「パッケージ化されていない拡張機能を読み込む」をクリックします。
4. `packages/EdgeTranslate/build/chrome/` を選択します。
5. ローカル PDF やファイルの翻訳が必要な場合は、「ファイルの URL へのアクセスを許可する」を有効にします。

### Firefox

1. `about:debugging` を開きます。
2. 「This Firefox」を選択します。
3. 「Load Temporary Add-on」をクリックします。
4. `packages/EdgeTranslate/build/firefox/` 内の任意のファイル、または生成された
   `edge_translate_firefox.xpi` を選択します。

### Safari

Safari ビルドは `packages/EdgeTranslate/safari-xcode/` にあります。

便利なコマンド：

```bash
npm run build:safari
npm run safari:sync -w edge_translate
npm run safari:release -w edge_translate
```

`safari:release` は、ビルド、Xcode プロジェクトへのリソース同期、アーカイブ、エクスポート、
アップロードを行います。有効な App Store 認証情報が必要です。

## 権限

この拡張機能は、ユーザーページ上で選択テキスト翻訳、PDF 検出、コンテンツスクリプトを動作させるために
ホストアクセスを使用します。Chrome ビルドでは、拡張機能の PDF ビューアー内など、ページ注入が利用できない場面で
拡張機能ドキュメントコンテキストから Gemini Nano 翻訳を実行するために `offscreen` も要求します。

主な権限カテゴリ：

- `activeTab`、`tabs`、`scripting` は選択テキスト翻訳とページ操作に使用します。
- `contextMenus` と `storage` はコマンドとユーザー設定に使用します。
- `webNavigation` と `webRequest` は PDF 検出とビューアールーティングに使用します。
- Chrome の `offscreen` は拡張機能コンテキストでの AI 翻訳に使用します。

## プライバシー

- このフォークは分析やテレメトリー収集を追加しません。
- 翻訳テキストは、ユーザーが選択または設定したプロバイダーにのみ送信されます。
- Chrome オンデバイス AI 翻訳は、利用可能な場合に Chrome 内蔵のローカルモデル経路で実行されます。
- ファイル URL へのアクセスは任意であり、ブラウザーの拡張機能設定で制御されます。

## リリースチェックリスト

通常のリリース手順：

1. `packages/EdgeTranslate/package.json` を更新します。
2. `package-lock.json` を更新します。
3. `packages/EdgeTranslate/src/manifest.json` を更新します。
4. テストとブラウザーパッケージ作成を実行します。
5. 例として `v4.0.1` のようなリリースコミットとタグを作成します。
6. Chrome と Firefox のパッケージアーティファクトを GitHub Releases にアップロードします。

古いプロジェクト用のチェックリストは [RELEASE_CHECKLIST.md](../RELEASE_CHECKLIST.md) を参照してください。

## ドキュメント

元プロジェクトの古い機能リファレンスは、一般的な挙動の参考として引き続き役立ちます。

- [Instructions](./wiki/en/Instructions.md)
- [Precautions](./wiki/en/Precautions.md)
- [Privacy Policy](./wiki/en/PrivacyPolicy.md)
- [Local LLM Translate Proxy](./local-llm-translate-proxy.md)

## ライセンス

このプロジェクトは、元の Edge Translate プロジェクトと同じライセンス構成に従います。

- [LICENSE.MIT](../LICENSE.MIT)
- [LICENSE.NPL](../LICENSE.NPL)

## クレジット

元の Edge Translate のメンテナーとコントリビューターに感謝します。EdgeTranslate-v3 はその基盤を引き継ぎ、
Manifest V3 ブラウザー、現代のブラウザー API、PDF ワークフロー、AI 支援翻訳に合わせて継続的に適応しています。
