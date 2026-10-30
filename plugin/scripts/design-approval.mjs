import { readFileSync } from "node:fs";

// design-diff は --allow-domain で渡した外部の宛先へ、撮影中の Chrome を通信させる。auto mode では承認を判定役のモデルが代わりに行うので、
// 外部の宛先を許可する実行は、PreToolUse の ask でどのモードでも人の承認画面に回す。
// 承認画面に並べる宛先と実際に渡る引数が食い違わないよう、シェルの展開を含むコマンドは引数を推測せずに拒否する。
// サンドボックスの除外ルールは、つないだコマンドがすべて一致すればまとめて外で動かすので、design-diff を ; や && でつないだコマンドも拒否する

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

function decide(permissionDecision, permissionDecisionReason) {
	console.log(JSON.stringify({ hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision, permissionDecisionReason } }));
	process.exit(0);
}

// Claude Code の入力の形が変わって読めなくなったときに、黙って承認を回さなくなるのを避ける
let command = null;
try {
	const value = JSON.parse(readFileSync(0, "utf8")).tool_input?.command;
	if (typeof value === "string") command = value;
} catch {}
if (command === null) {
	decide("ask", "design-to-code の hook が Bash のコマンドを読み取れませんでした。外部サイトとの通信を見逃さないよう、すべての Bash の実行を承認画面に回しています。");
}
if (!mentionsDesignDiff(command)) process.exit(0);

const words = splitWords(command);
if (words === null) {
	decide(
		"deny",
		"design-diff は、変数やコマンドの置き換え・&& などのつなぎ・ファイル名の展開を使わずに、単独のコマンドとして実行してください。$ やバッククォートを含む引数は単一引用符で囲みます。",
	);
}
const firstNonAssignment = words.findIndex((word) => !/^[A-Za-z_][A-Za-z0-9_]*=/.test(word));
if (firstNonAssignment > 0 && designDiffArgs(words.slice(firstNonAssignment)) !== null) {
	decide("deny", "design-diff は、環境変数を前に付けずに実行してください。");
}
const args = designDiffArgs(words);
if (args === null) process.exit(0);

const domains = allowDomainsIn(args);
if (domains.length === 0) process.exit(0);

decide(
	"ask",
	[
		"デザインとの比較のため、開発中のページが次の外部サイトと通信することを許可しますか？",
		"",
		...domains.map((domain) => `  ・${domain}`),
		"",
		"許可すると、開発中のページのプログラムがこれらのサイトへデータを送れるようになります。フォントや画像の配信元として知っているサイトだけを許可してください。",
	].join("\n"),
);
