// サンドボックスの外で動く Chrome に、file: のファイルや外部のページを --url で直接開かせない。
// 確かめるのは最初に開く URL だけで、リダイレクトの先とページが読み込む資源の宛先は、#35 で制限するまで確かめていない。
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
