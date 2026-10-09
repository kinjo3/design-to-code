# design-to-code

デザインデータを元にコードを実装し、デザインとの見た目の差分が閾値に収まるまで、最大 3 回 Claude Code に調整させる仕組み。比較した画素のうち差分のある画素の割合 `diffRatio` が `--threshold`（既定 0.02）以下になれば合格とする。

Figma の URL から実装するスキル `figma-to-code` と、Figma の書き出し画像と実装の描画結果を比べるスクリプト `scripts/figma-diff.mjs` からなる。実装の規約・トークン・ビルドのコマンドは対象プロジェクトの規約（エージェントに読み込まれている指示、README、既存コード）と `package.json` から読むため、設定ファイルは持たない。

## プロジェクトへの導入

1. 次のファイルをプロジェクトにコピーする。

   | コピー元 | コピー先 |
   | --- | --- |
   | `scripts/figma-diff.mjs` | `scripts/figma-diff.mjs` |
   | `.claude/skills/figma-to-code/` | `.claude/skills/figma-to-code/` |

2. 依存を入れ、Chromium を用意する。

   ```sh
   pnpm add -D playwright pixelmatch pngjs
   pnpm exec playwright install chromium
   ```

3. 差分チェックの出力先 `.figma-diff/` を `.gitignore` に足す。

4. Claude Code のサンドボックス内では Chromium が起動しないため、差分チェックのコマンドだけをサンドボックスから除外する。プロジェクトの `.claude/settings.local.json` に追記する。

   ```json
   {
     "sandbox": {
       "excludedCommands": ["node scripts/figma-diff.mjs *"]
     }
   }
   ```

5. Figma の MCP（`get_design_context` `get_screenshot` `get_variable_defs` `get_metadata` `download_assets`）を Claude Code に許可する。

## 使い方

開発サーバーを起動した状態で、Claude Code に Figma の URL を渡して依頼する。

```text
/figma-to-code https://www.figma.com/design/<file>?node-id=1-2 を実装して
```

実装後、`scripts/figma-diff.mjs` が Figma のスクリーンショットと実装の描画結果を比べる。

```sh
node scripts/figma-diff.mjs --url <描画先の URL> --selector "<対象セレクタ>" --figma <Figma のスクショ> --width <設計幅>
```

比較のたびに `.figma-diff/<selector>-<width>/` へ `figma.png` `actual.png` `diff.png` `compare.png` `summary.json` が上書きされる。終了コードは、合格が 0、差分ありまたは実行エラーが 1。
