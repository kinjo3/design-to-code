# design-to-code

Figma の URL またはデザイン画像を渡すと、Claude Code が対象プロジェクトのコードへ実装し、デザインとの差分が閾値に収まるまで最大 3 回調整する Claude Code のプラグイン。実装の規約・トークン・ビルドのコマンドは対象プロジェクトの規約（エージェントに読み込まれている指示、README、既存コード）と `package.json` から読むため、設定ファイルは持たない。

## プロジェクトへの導入

1. Claude Code でプラグインを入れる。`design-diff` が使う `playwright` `pixelmatch` `pngjs` は、インストール時に Claude Code がプラグインの中に入れる。

   ```text
   /plugin install design-to-code --marketplace kinjo3/design-to-code
   ```

2. サンドボックス内では Chromium が起動しないため、Claude Code の設定の `sandbox.excludedCommands` に `design-diff *` と `design-diff-install-chromium` を足す。

3. Claude Code に `design-diff-install-chromium` を実行させ、プラグインが依存する版の playwright に合う Chromium を入れる。プラグインのコマンドは、Claude Code が実行するコマンドからだけ PATH に載るので、ターミナルからは実行できない。

4. 差分チェックの出力先 `.design-diff/` を `.gitignore` に足す。

5. Figma の URL から実装する場合は、Figma の MCP（`get_design_context` `get_screenshot` `get_variable_defs` `get_metadata` `download_assets`）を Claude Code に許可する。デザイン画像だけを使う場合は不要。

## 使い方

開発サーバーを起動した状態で、Claude Code に Figma の URL かデザイン画像（PNG）を渡して依頼する。画像の表示幅など、実装に要る値が依頼に書かれていなければ、Claude Code が聞く。

```text
/design-to-code https://www.figma.com/design/<file>?node-id=1-2 を実装して
```

```text
/design-to-code design/hero.png を実装して
```

合格の条件、差分チェックの出力、Claude Code が差分チェックを終えるまで終了しない仕組みは [docs/diff-check.md](docs/diff-check.md) を参照。

## 開発

変更したプラグインを試すときは、`plugin/` に依存を入れてから、Claude Code を `--plugin-dir` 付きで起動する。`--plugin-dir` で読み込んだプラグインには、Claude Code が依存を入れない。

```sh
npm install --prefix plugin
claude --plugin-dir ./plugin
```
