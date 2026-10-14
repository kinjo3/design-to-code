import { parseArgs } from "node:util";
import { readFileSync } from "node:fs";
import { PNG } from "pngjs";

const USAGE = `使い方:
  node scripts/design-measure.mjs --image <PNG> --figma-width <表示幅> color <x>,<y> [<x>,<y> ...]
  node scripts/design-measure.mjs --image <PNG> --figma-width <表示幅> edges row <y> | col <x>
  node scripts/design-measure.mjs --image <PNG> --figma-width <表示幅> box <x>,<y>,<幅>,<高さ>
座標と寸法はすべて CSS px（画像の左上が 0,0、小数も可）
box は、指定した範囲の左上の画素を背景の色とみなす。範囲は中身より一回り大きく取る
--tolerance <数値>（既定 12）: 同じ色とみなす RGBA の差の合計。薄い罫線が edges で区切られないときは下げる`;

function fail(message) {
	console.error(message);
	process.exit(1);
}

let values;
let positionals;
try {
	({ values, positionals } = parseArgs({
		allowPositionals: true,
		options: {
			image: { type: "string" },
			"figma-width": { type: "string" },
			tolerance: { type: "string", default: "12" },
		},
	}));
} catch (error) {
	fail(`${error instanceof Error ? error.message : String(error)}\n${USAGE}`);
}

if (!values.image || !values["figma-width"] || positionals.length === 0) fail(USAGE);
const figmaWidth = Number(values["figma-width"]);
const tolerance = Number(values.tolerance);
if (!Number.isFinite(figmaWidth) || figmaWidth < 1) fail(`--figma-width には 1 以上の数値を指定してください（渡された値: "${values["figma-width"]}"）`);
if (!Number.isFinite(tolerance) || tolerance < 0) fail(`--tolerance には 0 以上の数値を指定してください（渡された値: "${values.tolerance}"）`);

let png;
let file;
try {
	file = readFileSync(values.image);
	png = PNG.sync.read(file);
} catch (error) {
	fail(`--image の画像を PNG として読めませんでした: ${values.image}\n${error instanceof Error ? error.message : String(error)}`);
}
// pngjs はカラープロファイルを適用せずに画素値を返すので、sRGB 以外のプロファイルでは表示される色とずれる
function iccProfileName(buffer) {
	for (let offset = 8; offset + 8 <= buffer.length; ) {
		const length = buffer.readUInt32BE(offset);
		const type = buffer.toString("latin1", offset + 4, offset + 8);
		if (type === "iCCP") {
			const data = buffer.subarray(offset + 8, offset + 8 + length);
			return data.toString("latin1", 0, data.indexOf(0));
		}
		if (type === "IDAT" || type === "IEND") return null;
		offset += 12 + length;
	}
	return null;
}
const profileName = iccProfileName(file);
const profileWarning = profileName === null ? "" : `\n注意: カラープロファイル「${profileName}」が埋め込まれています。sRGB でなければ、測った色は表示される色とずれます`;

const scale = png.width / figmaWidth;
const scaleWarning =
	Math.abs(scale - Math.round(scale)) > 1e-6 || scale < 1
		? `\n警告: 倍率（画像の px 幅 ${png.width} ÷ 表示幅 ${figmaWidth}）が 1 以上の整数ではありません。表示幅が正しいか確認してください`
		: "";

// 浮動小数の誤差で 3 が 2.9999… になると 1 画素手前を読むので、切り捨ての前にわずかに足す
const toImagePx = (cssPx) => Math.floor(cssPx * scale + 1e-9);
// 倍率 2 以上の画像では境界が CSS px の途中に来るので、小数第 1 位まで残す
const toCssPx = (imagePx) => Math.round((imagePx / scale) * 10) / 10;

function pixel(x, y) {
	const i = (y * png.width + x) * 4;
	return [png.data[i], png.data[i + 1], png.data[i + 2], png.data[i + 3]];
}
function hex([r, g, b, a]) {
	const rgb = [r, g, b].map((v) => v.toString(16).padStart(2, "0")).join("");
	return a === 255 ? `#${rgb}` : `#${rgb}${a.toString(16).padStart(2, "0")}`;
}
const distance = (p, q) => p.reduce((sum, v, i) => sum + Math.abs(v - q[i]), 0);

function parseNumbers(text, count) {
	const parts = (text ?? "").split(",");
	if (parts.length !== count || parts.some((part) => !/^\d+(\.\d+)?$/.test(part))) fail(USAGE);
	return parts.map(Number);
}
function assertInside(x, y) {
	if (x >= png.width || y >= png.height) {
		fail(`座標が画像の外です（画像は ${toCssPx(png.width)}×${toCssPx(png.height)} CSS px）`);
	}
}

console.log(`画像 ${png.width}×${png.height} px、倍率 ${scale}（${toCssPx(png.width)}×${toCssPx(png.height)} CSS px）${scaleWarning}${profileWarning}`);

const [command, ...rest] = positionals;
if (command === "color") {
	if (rest.length === 0) fail(USAGE);
	for (const point of rest) {
		const [x, y] = parseNumbers(point, 2).map(toImagePx);
		assertInside(x, y);
		console.log(`${point}: ${hex(pixel(x, y))}`);
	}
} else if (command === "edges") {
	const [axis, position] = rest;
	if ((axis !== "row" && axis !== "col") || position === undefined) fail(USAGE);
	const fixed = toImagePx(parseNumbers(position, 1)[0]);
	const length = axis === "row" ? png.width : png.height;
	if (axis === "row") assertInside(0, fixed);
	else assertInside(fixed, 0);
	const at = (i) => (axis === "row" ? pixel(i, fixed) : pixel(fixed, i));
	// 写真のようなグラデーションでは 1 画素ごとに色が変わるので、区間の先頭の色からの差が tolerance を超えたときだけ区切る
	let start = 0;
	let startColor = at(0);
	const report = (end) => console.log(`${toCssPx(start)}〜${toCssPx(end)}（${toCssPx(end - start)}）: ${hex(startColor)}`);
	for (let i = 1; i < length; i++) {
		const color = at(i);
		if (distance(color, startColor) <= tolerance) continue;
		report(i);
		start = i;
		startColor = color;
	}
	report(length);
} else if (command === "box") {
	const [x, y, w, h] = parseNumbers(rest[0], 4);
	const left = toImagePx(x);
	const top = toImagePx(y);
	const right = Math.min(toImagePx(x + w), png.width);
	const bottom = Math.min(toImagePx(y + h), png.height);
	assertInside(left, top);
	if (right <= left || bottom <= top) fail("範囲が画像の 1 画素より小さいので測れません。範囲を広げてください");
	if (toImagePx(x + w) > png.width || toImagePx(y + h) > png.height) console.log("注意: 範囲が画像の外へはみ出した分は切り捨てて測りました");
	const background = pixel(left, top);
	const corners = [pixel(right - 1, top), pixel(left, bottom - 1), pixel(right - 1, bottom - 1)];
	if (corners.some((corner) => distance(corner, background) > tolerance)) {
		console.log("注意: 範囲の四隅の色が揃っていません。左上の画素が背景でない可能性があるので、範囲を中身より一回り大きく取り直してください");
	}
	let maxDistance = 0;
	for (let py = top; py < bottom; py++) {
		for (let px = left; px < right; px++) maxDistance = Math.max(maxDistance, distance(pixel(px, py), background));
	}
	if (maxDistance <= tolerance) {
		console.log(`背景 ${hex(background)} と異なる画素はありません`);
		process.exit(0);
	}
	// アンチエイリアスの薄い縁まで含めると寸法が 1px ほど膨らむので、背景との差が最大の半分以上ある画素だけで外接矩形を取る
	const threshold = maxDistance / 2;
	let minX = Infinity;
	let minY = Infinity;
	let maxX = -1;
	let maxY = -1;
	let contentColor = null;
	for (let py = top; py < bottom; py++) {
		for (let px = left; px < right; px++) {
			const color = pixel(px, py);
			const d = distance(color, background);
			if (d < threshold) continue;
			minX = Math.min(minX, px);
			minY = Math.min(minY, py);
			maxX = Math.max(maxX, px);
			maxY = Math.max(maxY, py);
			if (!contentColor || d > distance(contentColor, background)) contentColor = color;
		}
	}
	console.log(`背景 ${hex(background)}、中身の色 ${hex(contentColor)}`);
	console.log(
		`中身の外接矩形: x=${toCssPx(minX)} y=${toCssPx(minY)} 幅=${toCssPx(maxX + 1 - minX)} 高さ=${toCssPx(maxY + 1 - minY)}`,
	);
} else {
	fail(USAGE);
}
