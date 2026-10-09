import { parseArgs } from "node:util";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { chromium } from "playwright";
import pixelmatch from "pixelmatch";
import { PNG } from "pngjs";

const { values } = parseArgs({
	options: {
		url: { type: "string" },
		selector: { type: "string" },
		figma: { type: "string" },
		width: { type: "string" },
		"figma-width": { type: "string" },
		height: { type: "string", default: "1080" },
		threshold: { type: "string", default: "0.02" },
		out: { type: "string" },
		wait: { type: "string", default: "300" },
		hide: { type: "string" },
	},
});

function fail(message) {
	console.error(message);
	process.exit(1);
}

const required = ["url", "selector", "figma", "width"];
const missing = required.filter((key) => !values[key]);
if (missing.length > 0) {
	fail(`必須引数が不足しています: ${missing.map((k) => `--${k}`).join(", ")}`);
}

for (const [name, min] of [
	["width", 1],
	["figma-width", 1],
	["height", 1],
	["threshold", 0],
	["wait", 0],
]) {
	if (values[name] === undefined) continue;
	const value = Number(values[name]);
	if (!Number.isFinite(value) || value < min) {
		fail(`--${name} には ${min} 以上の数値を指定してください（渡された値: "${values[name]}"）`);
	}
}

const url = values.url;
const selector = values.selector;
const figmaPath = values.figma;
const width = Number(values.width);
// カード 1 枚のようなコンポーネント単位の比較では、ビューポート幅と Figma 書き出し幅が一致しない
const figmaWidth = values["figma-width"] === undefined ? width : Number(values["figma-width"]);
const height = Number(values.height);
const diffRatioThreshold = Number(values.threshold);
const wait = Number(values.wait);
// Figma の書き出しに無い固定ヘッダーのように、撮影時だけ伏せたい要素を呼び出し側が指定する
const hideSelector = values.hide;

// 同じセレクタ・同じビューポートで書き出し幅だけ変えた実行が上書きし合わないよう、指定時は幅を重ねる
const figmaWidthLabel = values["figma-width"] === undefined ? "" : `-${figmaWidth}`;
const label =
	values.out ?? `${selector.replace(/[^a-zA-Z0-9_-]+/g, "-").replace(/^-+|-+$/g, "")}-${width}${figmaWidthLabel}`;

// スクリプトの置き場所に依存しないよう、出力先は実行時のカレントディレクトリ（プロジェクトルート）を基準にする
const outDir = join(process.cwd(), ".figma-diff", label);
mkdirSync(outDir, { recursive: true });

let figmaPng;
try {
	figmaPng = PNG.sync.read(readFileSync(figmaPath));
} catch (error) {
	fail(`--figma の画像を PNG として読めませんでした: ${figmaPath}\n${error instanceof Error ? error.message : String(error)}`);
}
const deviceScaleFactor = figmaPng.width / figmaWidth;

// 原因の見当がつく撮影の失敗は案内文だけを出し、それ以外の例外はスタックトレースごと表に出す
class CaptureError extends Error {}

// Playwright のエラー文には、起動コマンドの全引数のような長い行と色付けの制御文字が混じり、要点が埋もれる
const MAX_ERROR_LINE_LENGTH = 300;
function errorText(error) {
	const message = error instanceof Error ? error.message : String(error);
	return message
		.replace(/\u001b\[[0-9;]*m/g, "")
		.split("\n")
		.filter((line) => line.length <= MAX_ERROR_LINE_LENGTH)
		.join("\n");
}

async function captureActual() {
	let browser;
	try {
		browser = await chromium.launch();
	} catch (error) {
		throw new CaptureError(
			`Chromium を起動できません。playwright install chromium を実行済みか、サンドボックス内で実行していないか確認してください。\n${errorText(error)}`,
		);
	}
	try {
		// 撮影ごとに新しいコンテキストで開くとオープニングなどの演出が毎回再生されるので、完成形を撮らせる
		const context = await browser.newContext({ viewport: { width, height }, deviceScaleFactor, reducedMotion: "reduce" });
		const page = await context.newPage();
		try {
			await page.goto(url, { waitUntil: "networkidle" });
		} catch (error) {
			throw new CaptureError(
				`ページの読み込みに失敗しました: ${url}\n開発サーバーが起動しているか、--url の値が正しいか確認してください。\n${errorText(error)}`,
			);
		}
		// ヘッドレスの Chromium はスクロールバーを幅 0 で隠すが、scrollbar-gutter: stable はその幅を確保し続けるので、
		// Figma のコマには無い空白の帯が右端に写る
		await page.addStyleTag({ content: ":root { scrollbar-gutter: auto !important; }" });

		const locator = page.locator(selector);
		try {
			await locator.waitFor({ state: "visible", timeout: 10_000 });
		} catch (error) {
			if (error instanceof Error && error.name === "TimeoutError") {
				throw new CaptureError(
					`要素が見つかりませんでした: ${selector}\nセレクタが正しいか、変更が描画先に反映されている（ビルドが必要なプロジェクトならビルド済み）か確認してください。`,
				);
			}
			throw new CaptureError(`セレクタの解決に失敗しました: ${selector}\n${errorText(error)}`);
		}
		if (hideSelector) {
			// 渡されたセレクタが通常フローの要素を指した場合に対象の位置がずれないよう、領域を残して隠す
			await page.addStyleTag({ content: `${hideSelector} { visibility: hidden !important; }` });
		}
		// 対象が画面外にあると、負の z-index に置いた背景が合成されないまま撮れる。
		// locator.screenshot() も撮影の直前にスクロールするが、そこから描画までの猶予が無い
		await locator.scrollIntoViewIfNeeded();
		await page.waitForTimeout(wait);
		return await locator.screenshot();
	} finally {
		await browser.close();
	}
}

let actualBuffer;
try {
	actualBuffer = await captureActual();
} catch (error) {
	if (error instanceof CaptureError) fail(error.message);
	throw error;
}

const actualPng = PNG.sync.read(actualBuffer);

const canvasWidth = Math.max(figmaPng.width, actualPng.width);
const canvasHeight = Math.max(figmaPng.height, actualPng.height);

function fillPng(png, [r, g, b]) {
	for (let i = 0; i < png.data.length; i += 4) {
		png.data[i] = r;
		png.data[i + 1] = g;
		png.data[i + 2] = b;
		png.data[i + 3] = 255;
	}
}

function padToCanvas(png) {
	const canvas = new PNG({ width: canvasWidth, height: canvasHeight });
	fillPng(canvas, [255, 0, 255]);
	PNG.bitblt(png, canvas, 0, 0, png.width, png.height, 0, 0);
	return canvas;
}

const figmaCanvas = padToCanvas(figmaPng);
const actualCanvas = padToCanvas(actualPng);

// pixelmatch の diffColor 既定値 [255, 0, 0] のピクセルのみを差分として扱う（aaColor の黄色は除外）
function isDiffPixel(data, i) {
	return data[i] === 255 && data[i + 1] === 0 && data[i + 2] === 0;
}

// pixelmatch 自体のピクセル単位の色差判定用しきい値（0-1）。--threshold（diffRatio 全体の合否判定）とは無関係。
const PIXELMATCH_COLOR_THRESHOLD = 0.1;

const diffPng = new PNG({ width: canvasWidth, height: canvasHeight });
const diffPixels = pixelmatch(figmaCanvas.data, actualCanvas.data, diffPng.data, canvasWidth, canvasHeight, {
	threshold: PIXELMATCH_COLOR_THRESHOLD,
});

const totalPixels = canvasWidth * canvasHeight;
const diffRatio = diffPixels / totalPixels;
const pass = diffRatio <= diffRatioThreshold;

// ---- 差分クラスタ ----
// AI が画像を読まずに修正箇所のあたりを付けるための概算レポート。座標はセル（16px）精度で十分とする。

const CLUSTER_CELL = 16;
const MIN_CLUSTER_PIXELS = 8 * deviceScaleFactor ** 2; // 差分 8 CSS px² 相当未満はノイズとして除外
const MAX_CONSOLE_CLUSTERS = 5;

function findDiffClusters(diffData) {
	const cols = Math.ceil(canvasWidth / CLUSTER_CELL);
	const cellCounts = new Map(); // セル index → セル内の差分ピクセル数
	for (let y = 0; y < canvasHeight; y++) {
		for (let x = 0; x < canvasWidth; x++) {
			if (!isDiffPixel(diffData, (y * canvasWidth + x) * 4)) continue;
			const idx = Math.floor(y / CLUSTER_CELL) * cols + Math.floor(x / CLUSTER_CELL);
			cellCounts.set(idx, (cellCounts.get(idx) ?? 0) + 1);
		}
	}

	const clusters = [];
	// Map の live イテレータは削除済みキーを飛ばすので、走査中の delete と併用できる
	for (const start of cellCounts.keys()) {
		const box = { count: 0, minX: Infinity, maxX: -1, minY: Infinity, maxY: -1 };
		const stack = [start];
		while (stack.length > 0) {
			const idx = stack.pop();
			if (!cellCounts.has(idx)) continue;
			box.count += cellCounts.get(idx);
			cellCounts.delete(idx);
			const cx = idx % cols;
			const cy = Math.floor(idx / cols);
			box.minX = Math.min(box.minX, cx);
			box.maxX = Math.max(box.maxX, cx);
			box.minY = Math.min(box.minY, cy);
			box.maxY = Math.max(box.maxY, cy);
			// 8 近傍のセルを連結する。範囲外や差分の無いセルは Map に無いので自然に無視される
			for (let dy = -1; dy <= 1; dy++) {
				for (let dx = -1; dx <= 1; dx++) {
					if (cx + dx >= 0 && cx + dx < cols) stack.push(idx + dy * cols + dx);
				}
			}
		}
		clusters.push(box);
	}
	return clusters.sort((a, b) => b.count - a.count);
}

const clusters = findDiffClusters(diffPng.data).filter((c) => c.count >= MIN_CLUSTER_PIXELS);

// クラスタ座標は Figma 書き出し幅を基準にした CSS px に換算して報告する
const toCssPx = (cells) => Math.round((cells * CLUSTER_CELL) / deviceScaleFactor);
const clusterReports = clusters.map((c) => ({
	x: toCssPx(c.minX),
	y: toCssPx(c.minY),
	width: toCssPx(c.maxX - c.minX + 1),
	height: toCssPx(c.maxY - c.minY + 1),
	diffPixels: c.count,
}));

// ---- compare.png（figma | actual | diff を縮小して横並びにした閲覧用の 1 枚） ----

const COMPARE_PANE_WIDTH = 400;
const COMPARE_MAX_HEIGHT = 1000; // 縦長セクションで compare.png が読めない縦横比にならないよう高さも縛る

function downscale(png, scale) {
	if (scale >= 1) return png;
	const outWidth = Math.max(1, Math.round(png.width * scale));
	const outHeight = Math.max(1, Math.round(png.height * scale));
	const out = new PNG({ width: outWidth, height: outHeight });
	for (let y = 0; y < outHeight; y++) {
		for (let x = 0; x < outWidth; x++) {
			const sx = Math.min(png.width - 1, Math.floor(x / scale));
			const sy = Math.min(png.height - 1, Math.floor(y / scale));
			out.data.set(png.data.subarray((sy * png.width + sx) * 4, (sy * png.width + sx) * 4 + 4), (y * outWidth + x) * 4);
		}
	}
	return out;
}

// 縮小サンプリングで細い差分線が消えないよう、差分ピクセルは縮小後の該当位置を純赤で塗り直す
function markDiffRed(source, scaled, scale) {
	for (let y = 0; y < source.height; y++) {
		for (let x = 0; x < source.width; x++) {
			if (!isDiffPixel(source.data, (y * source.width + x) * 4)) continue;
			const ox = Math.min(scaled.width - 1, Math.floor(x * scale));
			const oy = Math.min(scaled.height - 1, Math.floor(y * scale));
			const o = (oy * scaled.width + ox) * 4;
			scaled.data[o] = 255;
			scaled.data[o + 1] = 0;
			scaled.data[o + 2] = 0;
		}
	}
}

function compositeRow(pngs, separator = 4) {
	const outWidth = pngs.reduce((sum, p) => sum + p.width, 0) + separator * (pngs.length - 1);
	const outHeight = Math.max(...pngs.map((p) => p.height));
	const out = new PNG({ width: outWidth, height: outHeight });
	fillPng(out, [128, 128, 128]);
	let offsetX = 0;
	for (const p of pngs) {
		PNG.bitblt(p, out, 0, 0, p.width, p.height, offsetX, 0);
		offsetX += p.width + separator;
	}
	return out;
}

const compareScale = Math.min(1, COMPARE_PANE_WIDTH / canvasWidth, COMPARE_MAX_HEIGHT / canvasHeight);
const diffPane = downscale(diffPng, compareScale);
if (compareScale < 1) markDiffRed(diffPng, diffPane, compareScale);
const comparePng = compositeRow([downscale(figmaCanvas, compareScale), downscale(actualCanvas, compareScale), diffPane]);

writeFileSync(join(outDir, "figma.png"), PNG.sync.write(figmaCanvas));
writeFileSync(join(outDir, "actual.png"), PNG.sync.write(actualCanvas));
writeFileSync(join(outDir, "diff.png"), PNG.sync.write(diffPng));
writeFileSync(join(outDir, "compare.png"), PNG.sync.write(comparePng));

const summary = {
	pass,
	diffRatio,
	diffPixels,
	totalPixels,
	diffClustersCssPx: clusterReports,
	figmaSize: { width: figmaPng.width, height: figmaPng.height },
	actualSize: { width: actualPng.width, height: actualPng.height },
	deviceScaleFactor,
	diffRatioThreshold,
	args: { url, selector, figmaPath, width, figmaWidth, height, wait },
	timestamp: new Date().toISOString(),
};
writeFileSync(join(outDir, "summary.json"), JSON.stringify(summary, null, 2));

console.log(
	`${pass ? "PASS" : "FAIL"} diffRatio=${(diffRatio * 100).toFixed(2)}% (threshold=${(diffRatioThreshold * 100).toFixed(2)}%)`,
);
if (!pass) {
	if (clusterReports.length > 0) {
		console.log("差分クラスタ（CSS px 概算、差分量の大きい順）:");
		clusterReports.slice(0, MAX_CONSOLE_CLUSTERS).forEach((c, i) => {
			console.log(`  ${i + 1}. x=${c.x} y=${c.y} w=${c.width} h=${c.height} 差分量=${c.diffPixels}`);
		});
		const rest = clusterReports.length - MAX_CONSOLE_CLUSTERS;
		if (rest > 0) console.log(`  …他 ${rest} 件（summary.json 参照）`);
	} else {
		console.log("差分クラスタなし（ノイズ級の微小差分が散在）。compare.png で全体を確認する");
	}
	console.log(
		`画像確認はまず compare.png（figma | actual | diff の縮小横並び）、詰めの確認のみ原寸 3 枚を読む（原寸画像上の座標はクラスタ座標の ${deviceScaleFactor} 倍）`,
	);
}
console.log(`出力先: ${outDir}`);

process.exit(pass ? 0 : 1);
