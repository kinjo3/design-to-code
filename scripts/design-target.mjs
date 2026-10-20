import { parseArgs } from "node:util";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

// #10 で設定できるようにするまでは、SKILL.md Step 5 項目 7 の「調整は最大 3 回」と同じ値を持つ
const MAX_ADJUSTMENTS = 3;

export function targetLabel({ selector, width, designWidth, out }) {
	if (out) return out;
	// 同じセレクタ・同じビューポートで書き出し幅だけ変えた実行が上書きし合わないよう、指定時は幅を重ねる
	const designWidthLabel = designWidth === undefined ? "" : `-${Number(designWidth)}`;
	return `${selector.replace(/[^a-zA-Z0-9_-]+/g, "-").replace(/^-+|-+$/g, "")}-${Number(width)}${designWidthLabel}`;
}

export function runLogPath(projectDir, label) {
	return join(projectDir, ".design-diff", label, "runs.jsonl");
}

function git(cwd, args) {
	return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
}

// 試行中はコミットしないので、HEAD とコミットしていないファイルの中身から求める。
// 全ファイルではなくコミットしていないファイルだけを読むので、大きいリポジトリでも計測のたびに求められる
export function workingTreeHash(cwd) {
	let root;
	try {
		root = git(cwd, ["rev-parse", "--show-toplevel"]).trim();
	} catch {
		return null;
	}
	// 親のリポジトリが除外しているディレクトリでは、ファイルを変えても一覧に出ず、変更を見逃す
	try {
		git(cwd, ["check-ignore", "-q", "."]);
		return null;
	} catch {}
	let head;
	try {
		head = git(root, ["rev-parse", "HEAD"]).trim();
	} catch {
		head = "";
	}
	// git diff はリポジトリのルートからのパスを返すので、一覧もファイルの読み込みもルートを基準にする。
	// ステージしただけのファイルも拾うよう、作業ツリーをインデックスではなく HEAD と比べる
	const changed = head ? git(root, ["diff", "--name-only", "-z", "HEAD"]) : git(root, ["ls-files", "-z", "--cached"]);
	const untracked = git(root, ["ls-files", "-z", "--others", "--exclude-standard"]);
	// .design-diff/ を .gitignore に入れ忘れたプロジェクトでも、実行記録を書き足すたびに値が変わらないようにする
	const files = [...new Set(`${changed}${untracked}`.split("\0"))]
		.filter((file) => file && !/(^|\/)\.design-diff\//.test(file))
		.sort();
	const hash = createHash("sha256");
	hash.update(head);
	for (const file of files) {
		hash.update(`\0${file}\0`);
		try {
			hash.update(readFileSync(join(root, file)));
		} catch {
			hash.update("<deleted>");
		}
	}
	return hash.digest("hex");
}

function readRuns(projectDir, label) {
	const path = runLogPath(projectDir, label);
	if (!existsSync(path)) return [];
	return readFileSync(path, "utf8")
		.split("\n")
		.filter(Boolean)
		.map((line) => JSON.parse(line));
}

function sessionPath(projectDir, sessionId) {
	return join(projectDir, ".design-diff", "sessions", `${sessionId}.json`);
}

function fail(message) {
	console.error(message);
	process.exit(1);
}

function register(argv) {
	const { values } = parseArgs({
		args: argv,
		options: {
			session: { type: "string" },
			selector: { type: "string" },
			width: { type: "string" },
			"design-width": { type: "string" },
			out: { type: "string" },
		},
	});
	const missing = ["session", "selector", "width"].filter((key) => !values[key]);
	if (missing.length > 0) fail(`必須引数が不足しています: ${missing.map((k) => `--${k}`).join(", ")}`);
	// SKILL.md の ${CLAUDE_SESSION_ID} が置き換えられない環境では、どのセッションの Stop hook からも見つからない登録になる
	if (!/^[A-Za-z0-9_-]+$/.test(values.session)) {
		fail(`--session がセッション ID になっていません（渡された値: "${values.session}"）。差分チェックの完走は Stop hook で確かめられません。`);
	}
	const projectDir = process.cwd();
	const path = sessionPath(projectDir, values.session);
	const session = existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : { targets: [] };
	const label = targetLabel({ selector: values.selector, width: values.width, designWidth: values["design-width"], out: values.out });
	// 登録し直して登録時刻を進めると、それまでの試行が数えられなくなるので、最初の登録を残す
	if (!session.targets.some((target) => target.label === label)) {
		session.targets.push({ label, selector: values.selector, width: Number(values.width), registeredAt: new Date().toISOString() });
	}
	mkdirSync(join(projectDir, ".design-diff", "sessions"), { recursive: true });
	writeFileSync(path, JSON.stringify(session, null, 2));
	console.log(`登録済み: ${label}`);
}

function judge(projectDir, target, treeHash) {
	const runs = readRuns(projectDir, target.label).filter((run) => run.at >= target.registeredAt);
	const latest = runs.at(-1);
	if (!latest) return { done: false, reason: "差分チェックを一度も実行していない" };
	// 作業ツリーのハッシュを求められない（git 管理外の）プロジェクトでは、変更の有無を問わずに合否だけで判定する
	const fresh = latest.treeHash === null || treeHash === null || latest.treeHash === treeHash;
	if (latest.pass && fresh) return { done: true };
	const adjustments = runs.length - 1;
	if (adjustments >= MAX_ADJUSTMENTS) return { done: true };
	if (latest.pass) return { done: false, reason: "合格したあとにファイルが変わったが、差分チェックを再実行していない" };
	return {
		done: false,
		reason: `pass: false のまま（diffRatio ${(latest.diffRatio * 100).toFixed(2)}%、調整 ${adjustments}/${MAX_ADJUSTMENTS} 回）`,
	};
}

function stopHook() {
	const input = JSON.parse(readFileSync(0, "utf8"));
	const projectDir = [input.cwd, process.env.CLAUDE_PROJECT_DIR].find(
		(dir) => dir && existsSync(sessionPath(dir, input.session_id)),
	);
	if (!projectDir) return;
	const path = sessionPath(projectDir, input.session_id);
	const session = JSON.parse(readFileSync(path, "utf8"));
	const treeHash = workingTreeHash(projectDir);
	const pending = session.targets
		.map((target) => ({ target, ...judge(projectDir, target, treeHash) }))
		.filter((result) => !result.done);
	if (pending.length === 0) return;

	// 開発サーバーが止まっているなどで差分チェックを実行できないと、止め続けても状態が変わらず終われなくなる。
	// 前回止めたときから実行記録も作業ツリーも変わっていなければ、同じ理由では止めない
	const state = JSON.stringify([treeHash, ...session.targets.map((target) => readRuns(projectDir, target.label).length)]);
	if (session.lastBlockedState === state) return;
	writeFileSync(path, JSON.stringify({ ...session, lastBlockedState: state }, null, 2));

	const lines = pending.map(({ target, reason }) => `- ${target.label}: ${reason}`);
	const reason = [
		"design-to-code の差分チェックが終わっていません。",
		...lines,
		"SKILL.md の Step 5 に沿って design-diff.mjs を実行し、合格するか調整が上限に達するまで続けてください。",
		"開発サーバーが止まっているなど差分チェックを実行できない場合は、その理由をユーザーに報告して終えてください。",
	].join("\n");
	console.log(JSON.stringify({ decision: "block", reason }));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
	const [command, ...argv] = process.argv.slice(2);
	if (command === "register") register(argv);
	else if (command === "stop-hook") stopHook();
	else fail("使い方: node scripts/design-target.mjs register --session <ID> --selector <セレクタ> --width <幅> [--design-width <幅>] [--out <名前>]");
}
