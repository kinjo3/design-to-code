import { mkdirSync, readdirSync, readFileSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

// design-diff は --allow-domain で渡した外部の宛先へ、撮影中の Chrome を通信させる。auto mode では承認を判定役のモデルが代わりに行うので、
// 外部の宛先を許可する実行は、PreToolUse の ask でどのモードでも人の承認画面に回す。
// 承認画面に並べる宛先と実際に渡る引数が食い違わないよう、シェルの展開を含むコマンドは引数を推測せずに拒否する。
// サンドボックスの除外ルールは、つないだコマンドがすべて一致すればまとめて外で動かすので、design-diff を ; や && でつないだコマンドも拒否する。
// 調整のたびの再実行で同じ宛先を尋ね続けないよう、実行まで進んだ（人が承認した）宛先をセッションの間だけ覚える

// cat .design-diff/… や git diff …/design-diff.mjs のように、design-diff を実行しないコマンドまで拒否しないよう、プログラムの語だけを見る
function mentionsDesignDiff(command) {
	const words = command.split(/[\s;&|()`'"<>]+/);
	return words.some(
		(word) => word === "design-diff" || word.endsWith("/design-diff") || (word.endsWith("design-diff.mjs") && words.some((w) => w === "node" || w.endsWith("/node"))),
	);
}

// 引用符とバックスラッシュだけを解釈して語に分ける。変数やコマンドの置き換え、ファイル名の展開、複数のコマンドのつなぎを含むと null を返す
function splitWords(command) {
	const words = [];
	let word = null;
	let i = 0;
	while (i < command.length) {
		const c = command[i];
		if (c === "'") {
			const end = command.indexOf("'", i + 1);
			if (end === -1) return null;
			word = (word ?? "") + command.slice(i + 1, end);
			i = end + 1;
		} else if (c === '"') {
			word ??= "";
			i++;
			while (command[i] !== '"') {
				if (i >= command.length || command[i] === "$" || command[i] === "`") return null;
				if (command[i] === "\\" && '$`"\\\n'.includes(command[i + 1])) i++;
				word += command[i];
				i++;
			}
			i++;
		} else if (c === "\\") {
			if (i + 1 >= command.length) return null;
			if (command[i + 1] !== "\n") word = (word ?? "") + command[i + 1];
			i += 2;
		} else if (c === " " || c === "\t") {
			if (word !== null) words.push(word);
			word = null;
			i++;
		} else if ("$`;&|<>()\n*?[]{}~#".includes(c)) {
			return null;
		} else {
			word = (word ?? "") + c;
			i++;
		}
	}
	if (word !== null) words.push(word);
	return words;
}

function designDiffArgs(words) {
	const [program, script] = words;
	if (program === "design-diff" || program?.endsWith("/design-diff")) return words.slice(1);
	if ((program === "node" || program?.endsWith("/node")) && script?.endsWith("design-diff.mjs")) return words.slice(2);
	return null;
}

function allowDomainsIn(args) {
	const domains = [];
	args.forEach((arg, index) => {
		if (arg === "--allow-domain" && index + 1 < args.length) domains.push(args[index + 1]);
		else if (arg.startsWith("--allow-domain=")) domains.push(arg.slice("--allow-domain=".length));
	});
	return domains;
}

const UNREADABLE_DESIGN_DIFF =
	"design-diff は、変数やコマンドの置き換え・&& などのつなぎ・ファイル名の展開を使わずに、単独のコマンドとして実行してください。$ やバッククォートを含む引数は単一引用符で囲みます。";

// design-diff を実行しないコマンドなら null を返す。拒否するコマンドなら拒否の理由を返す
function parseDesignDiff(command) {
	if (!mentionsDesignDiff(command)) return null;
	const words = splitWords(command);
	if (words === null) return { denyReason: UNREADABLE_DESIGN_DIFF };
	const firstNonAssignment = words.findIndex((word) => !/^[A-Za-z_][A-Za-z0-9_]*=/.test(word));
	if (firstNonAssignment > 0 && designDiffArgs(words.slice(firstNonAssignment)) !== null) {
		return { denyReason: "design-diff は、環境変数を前に付けずに実行してください。" };
	}
	const args = designDiffArgs(words);
	if (args === null) return null;
	return { domains: allowDomainsIn(args).map((domain) => domain.toLowerCase()) };
}

// 承認の記録は、サンドボックスの中から書けないプラグインのデータ用ディレクトリに置き、AI が承認を偽れないようにする
const SESSION_ID = /^[A-Za-z0-9_-]+$/;
function approvalFile(sessionId) {
	const dataDir = process.env.CLAUDE_PLUGIN_DATA;
	if (!dataDir || typeof sessionId !== "string" || !SESSION_ID.test(sessionId)) return null;
	return join(dataDir, "approved-domains", `${sessionId}.json`);
}

function readApproved(sessionId) {
	const file = approvalFile(sessionId);
	if (file === null) return [];
	try {
		const value = JSON.parse(readFileSync(file, "utf8"));
		return Array.isArray(value) ? value : [];
	} catch {
		return [];
	}
}

// 終えたセッションの記録が溜まり続けないよう、しばらく更新の無いものを消す
const STALE_AFTER_MS = 7 * 24 * 60 * 60 * 1000;

function rememberApproved(sessionId, domains) {
	const file = approvalFile(sessionId);
	if (file === null) return;
	mkdirSync(dirname(file), { recursive: true });
	writeFileSync(file, JSON.stringify([...new Set([...readApproved(sessionId), ...domains])]));
	for (const name of readdirSync(dirname(file))) {
		const path = join(dirname(file), name);
		try {
			if (Date.now() - statSync(path).mtimeMs > STALE_AFTER_MS) unlinkSync(path);
		} catch {}
	}
}

function decide(permissionDecision, permissionDecisionReason) {
	console.log(JSON.stringify({ hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision, permissionDecisionReason } }));
	process.exit(0);
}

let input = null;
try {
	input = JSON.parse(readFileSync(0, "utf8"));
} catch {}
const command = typeof input?.tool_input?.command === "string" ? input.tool_input.command : null;

// 失敗した（差分が閾値を超えて終了コード 1 で終えた）実行も、人が承認して実行まで進んだことに変わりはない
if (input?.hook_event_name === "PostToolUse" || input?.hook_event_name === "PostToolUseFailure") {
	const parsed = command === null ? null : parseDesignDiff(command);
	if (parsed?.domains?.length > 0) rememberApproved(input.session_id, parsed.domains);
	process.exit(0);
}

// Claude Code の入力の形が変わって読めなくなったときに、黙って承認を回さなくなるのを避ける
if (command === null) {
	decide("ask", "design-to-code の hook が Bash のコマンドを読み取れませんでした。外部サイトとの通信を見逃さないよう、すべての Bash の実行を承認画面に回しています。");
}
const parsed = parseDesignDiff(command);
if (parsed === null) process.exit(0);
if (parsed.denyReason) decide("deny", parsed.denyReason);

const approved = readApproved(input.session_id);
const domains = parsed.domains;
if (domains.every((domain) => approved.includes(domain))) process.exit(0);

decide(
	"ask",
	[
		"デザインとの比較のため、開発中のページが次の外部サイトと通信することを許可しますか？",
		"",
		...domains.map((domain) => `  ・${domain}`),
		"",
		"許可すると、開発中のページのプログラムがこれらのサイトへデータを送れるようになります。フォントや画像の配信元として知っているサイトだけを許可してください。",
		"このセッションの間は、許可したサイトだけを使う実行では再び尋ねません。",
	].join("\n"),
);
