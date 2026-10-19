# design-to-code

デザインデータを元にコードを実装し、デザインとの差分が閾値に収まるまで、最大 3 回 Claude Code に調整させる仕組み。差分は 2 つで測る。Figma の各ノードと実装の要素を突き合わせた箱（位置と寸法）のずれが `--layout-tolerance`（既定 1px）以内で、かつ比較した画素のうち差分のある画素の割合 `diffRatio` が `--threshold`（既定 0.02）以下になれば合格とする。箱の比較は Figma の URL から実装する場合だけ行う。

Figma の URL またはデザイン画像から実装するスキル `design-to-code` と、見本画像（Figma の書き出し画像、またはデザイン画像）と実装の描画結果を比べるスクリプト `scripts/design-diff.mjs`（箱の比較は `scripts/design-layout.mjs`）からなる。実装の規約・トークン・ビルドのコマンドは対象プロジェクトの規約（エージェントに読み込まれている指示、README、既存コード）と `package.json` から読むため、設定ファイルは持たない。

## プロジェクトへの導入

1. 次のファイルをプロジェクトにコピーする。

   | コピー元 | コピー先 |
   | --- | --- |
   | `scripts/design-diff.mjs` | `scripts/design-diff.mjs` |
   | `scripts/design-layout.mjs` | `scripts/design-layout.mjs` |
   | `scripts/design-measure.mjs` | `scripts/design-measure.mjs`（デザイン画像を使う場合） |
   | `.claude/skills/design-to-code/` | `.claude/skills/design-to-code/` |

2. 依存を入れ、Chromium を用意する。

   ```sh
   pnpm add -D playwright pixelmatch pngjs
   pnpm exec playwright install chromium
   ```

3. 差分チェックの出力先 `.design-diff/` を `.gitignore` に足す。

4. Claude Code のサンドボックス内では Chromium が起動しないため、差分チェックのコマンドだけをサンドボックスから除外する。プロジェクトの `.claude/settings.local.json` に追記する。

   ```json
   {
     "sandbox": {
       "excludedCommands": ["node scripts/design-diff.mjs *"]
     }
   }
   ```

5. Figma の URL から実装する場合は、Figma の MCP（`get_design_context` `get_screenshot` `get_variable_defs` `get_metadata` `download_assets`）を Claude Code に許可する。デザイン画像だけを使う場合は不要。

## 使い方

開発サーバーを起動した状態で、Claude Code に Figma の URL を渡して依頼する。

```text
/design-to-code https://www.figma.com/design/<file>?node-id=1-2 を実装して
```

Figma の MCP を使えないプロジェクトでは、Figma の URL の代わりにデザイン画像（PNG）のパスを渡す。画像ごとに、画像に写っている範囲をキャプチャしたときの表示幅（CSS px）を添える。画像がビューポートの全幅を写していない場合は、どのビューポート幅での表示かも添える。同じセクションのブレークポイント別の画像は 1 回の依頼にまとめて渡せる。デザイン内の写真・アイコンは、素材を渡さなければプレースホルダーで実装される。色と寸法は、`scripts/design-measure.mjs` で画像の画素から測る。

```text
/design-to-code design/hero-pc.png（表示幅 1440）と design/hero-sp.png（表示幅 375）を実装して
```

実装後、`scripts/design-diff.mjs` が見本画像と実装の描画結果を比べる。Figma の `get_metadata` の出力（XML）を `--metadata` で渡すと、ノードごとの箱も比べる。`get_metadata` はインスタンスの内部を返さないので、インスタンスごとに呼んだ出力も `--metadata` を繰り返して渡す。`--texts` には node id と文字列の対応 JSON を渡す。文字を持つノードは文字列で、それ以外は箱の近さで実装側の要素と対応付ける。

```sh
node scripts/design-diff.mjs --url <描画先の URL> --selector "<対象セレクタ>" --design <見本画像> --width <設計幅> --metadata <対象の XML> --metadata <インスタンスの XML> --texts <文字の対応 JSON>
```

素材が提供されずプレースホルダーで実装した写真やアイコンは、`--exclude "<セレクタ>"` で見本画像と実装の両方の比較から外せる（複数回指定できる）。外した画素は `diffRatio` の分母にも分子にも入らない。外した範囲は `summary.json` の `excludedCssPx` に記録され、`diff.png` と `compare.png` では青で塗られる。

ビルドが必要なプロジェクトでは、`--build "<ビルドコマンド>"` を渡すと、撮影の直前にプロジェクトルートでそのコマンドを実行する。ビルドが失敗したら差分を測らず、ビルドの出力の末尾 20 行を出して終了コード 1 で終わる。`design-diff.mjs` はサンドボックスから除外して実行するので、ビルドのコマンドもサンドボックスの外で動く。

比較のたびに `.design-diff/<selector>-<width>/` へ `design.png` `actual.png` `diff.png` `compare.png` `summary.json`（`--metadata` を渡した場合は `layout.json` も）が上書きされる。終了コードは、合格が 0、差分ありまたは実行エラーが 1。
