import { after, beforeEach, describe, test } from "node:test";
import assert from "node:assert/strict";
import { linkSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	appendResultsFile,
	readResultsFile,
	UnsafeResultsPathError,
	writeResultsFiles,
} from "../plugin/scripts/design-results.mjs";

const base = mkdtempSync(join(tmpdir(), "design-results-"));
after(() => rmSync(base, { recursive: true, force: true }));

let project;
let outside;
let secret;
beforeEach(() => {
	const dir = mkdtempSync(join(base, "case-"));
	project = join(dir, "project");
	outside = join(dir, "outside");
	mkdirSync(project);
	mkdirSync(outside);
	secret = join(outside, "secret.txt");
	writeFileSync(secret, "SECRET");
});

function assertOutsideUntouched() {
	assert.deepEqual(readdirSync(outside), ["secret.txt"]);
	assert.equal(readFileSync(secret, "utf8"), "SECRET");
}

function labelDir(label = "a-375") {
	const dir = join(project, ".design-diff", label);
	mkdirSync(dir, { recursive: true });
	return dir;
}

describe("通常の読み書き", () => {
	test("書き出し、追記し、読み戻せる", () => {
		writeResultsFiles(project, ["a-375"], { "summary.json": "{}" });
		appendResultsFile(project, ["a-375"], "runs.jsonl", "1\n");
		appendResultsFile(project, ["a-375"], "runs.jsonl", "2\n");
		assert.equal(readFileSync(join(project, ".design-diff", "a-375", "summary.json"), "utf8"), "{}");
		assert.equal(readResultsFile(project, ["a-375"], "runs.jsonl"), "1\n2\n");
	});

	test("無いファイルは null を返し、ディレクトリを作らない", () => {
		assert.equal(readResultsFile(project, ["a-375"], "runs.jsonl"), null);
		assert.deepEqual(readdirSync(project), []);
	});

	test("読み書きのあとにカレントディレクトリを戻す", () => {
		const before = process.cwd();
		writeResultsFiles(project, ["a-375"], { "x.json": "1" });
		assert.equal(process.cwd(), before);
		symlinkSync(outside, join(project, ".design-diff", "b"));
		assert.throws(() => writeResultsFiles(project, ["b"], { "x.json": "1" }), UnsafeResultsPathError);
		assert.equal(process.cwd(), before);
	});
});

describe("ディレクトリがリンクや普通のファイルなら、読み書きしない", () => {
	test(".design-diff がシンボリックリンク", () => {
		symlinkSync(outside, join(project, ".design-diff"));
		assert.throws(() => writeResultsFiles(project, ["a-375"], { "x.json": "1" }), UnsafeResultsPathError);
		assertOutsideUntouched();
	});

	test("ラベルのディレクトリがシンボリックリンク", () => {
		mkdirSync(join(project, ".design-diff"));
		symlinkSync(outside, join(project, ".design-diff", "a-375"));
		assert.throws(() => appendResultsFile(project, ["a-375"], "runs.jsonl", "1\n"), UnsafeResultsPathError);
		assertOutsideUntouched();
	});

	test(".design-diff が普通のファイル", () => {
		writeFileSync(join(project, ".design-diff"), "");
		assert.throws(() => writeResultsFiles(project, ["a-375"], { "x.json": "1" }), UnsafeResultsPathError);
	});

	test("ラベルに .. を含む", () => {
		labelDir();
		assert.throws(() => readResultsFile(project, ["../.."], "secret.txt"), UnsafeResultsPathError);
	});
});

describe("ファイルがリンクなら、リンク先を読み書きしない", () => {
	test("書き出し先のシンボリックリンクは、リンクごと置き換わる", () => {
		symlinkSync(secret, join(labelDir(), "summary.json"));
		writeResultsFiles(project, ["a-375"], { "summary.json": "{}" });
		assert.equal(lstatSync(join(labelDir(), "summary.json")).isSymbolicLink(), false);
		assertOutsideUntouched();
	});

	test("書き出し先のハードリンクは、リンクごと置き換わる", () => {
		linkSync(secret, join(labelDir(), "summary.json"));
		writeResultsFiles(project, ["a-375"], { "summary.json": "{}" });
		assertOutsideUntouched();
	});

	test("追記先がシンボリックリンク", () => {
		symlinkSync(secret, join(labelDir(), "runs.jsonl"));
		assert.throws(() => appendResultsFile(project, ["a-375"], "runs.jsonl", "1\n"), UnsafeResultsPathError);
		assertOutsideUntouched();
	});

	test("追記先がハードリンク", () => {
		linkSync(secret, join(labelDir(), "runs.jsonl"));
		assert.throws(() => appendResultsFile(project, ["a-375"], "runs.jsonl", "1\n"), UnsafeResultsPathError);
		assertOutsideUntouched();
	});

	test("読み込み先がシンボリックリンク", () => {
		symlinkSync(secret, join(labelDir("sessions"), "s1.json"));
		assert.throws(() => readResultsFile(project, ["sessions"], "s1.json"), UnsafeResultsPathError);
	});
});
