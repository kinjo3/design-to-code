// サンドボックスの外で開けるのを開発サーバーに限り、file: や外部の URL から読み込んだ内容を撮影させない。
// 先頭一致で判定すると、http://localhost@example.com のようにユーザー情報の位置に localhost を書いた URL を通してしまう
const LOCAL_HOSTNAMES = ["localhost", "127.0.0.1", "[::1]"];

export function isLocalDevServerUrl(value) {
	let parsed;
	try {
		parsed = new URL(value);
	} catch {
		return false;
	}
	if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return false;
	return LOCAL_HOSTNAMES.includes(parsed.hostname) || parsed.hostname.endsWith(".localhost");
}
