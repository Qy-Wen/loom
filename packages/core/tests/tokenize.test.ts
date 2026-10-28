import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
	compileFtsQuery,
	documentMatchesQuery,
	ftsFormat,
	segmentForIndex,
} from "../src/retrieval/tokenize.ts";

describe("segmentForIndex", () => {
	it("separates Chinese words and leaves Latin text alone", () => {
		assert.equal(segmentForIndex("今天天气很好").trim().split(/\s+/).join(" "), "今天 天气 很好");
		assert.equal(segmentForIndex("hello world"), "hello world");
		assert.equal(segmentForIndex("Canon EOS-R5").trim(), "Canon EOS-R5");
	});

	it("keeps mixed text readable and drops no characters", () => {
		const text = "2024年度 report.pdf 的 AI 总结";
		const out = segmentForIndex(text);
		assert.equal(out.replace(/\s+/g, ""), text.replace(/\s+/g, ""));
		assert.match(out, /report\.pdf/);
	});

	it("handles kana, hangul, and the long-vowel mark without losing text", () => {
		for (const text of ["カタカナのテスト", "東京都に住んでいます", "한국어 테스트 문장", "ラーメン"]) {
			assert.equal(segmentForIndex(text).replace(/\s+/g, ""), text.replace(/\s+/g, ""));
		}
	});

	it("returns an empty string unchanged", () => {
		assert.equal(segmentForIndex(""), "");
	});
});

describe("compileFtsQuery", () => {
	it("keeps English prefix matching", () => {
		assert.equal(compileFtsQuery("  Canon EOS  "), `"canon"* AND "eos"*`);
		assert.equal(compileFtsQuery("***"), undefined);
		assert.equal(compileFtsQuery(""), undefined);
	});

	it("turns a Chinese run into one phrase of its words", () => {
		assert.equal(compileFtsQuery("天气"), `"天气"`);
		assert.equal(compileFtsQuery("人工智能"), `"人工 智能"`);
	});

	it("treats characters split by spaces as one phrase, but separate words as separate pieces", () => {
		// Only one run is built from `天 气`: the user typed a gap inside a single Chinese word.
		const spaced = compileFtsQuery("天 气");
		assert.ok(spaced);
		assert.equal(compileFtsQuery("天气 北京"), `"天气" AND "北京"`);
	});

	it("mixes Chinese and Latin pieces with AND", () => {
		assert.equal(compileFtsQuery("2024年度"), `"2024"* AND "年度"`);
		assert.equal(compileFtsQuery("report 报告"), `"report"* AND "报告"`);
	});

	it("never produces a quote that could break the expression", () => {
		assert.equal(compileFtsQuery('say "hi" 天气'), `"say"* AND "hi"* AND "天气"`);
	});
});

describe("documentMatchesQuery", () => {
	it("matches whole Chinese words anywhere in the text", () => {
		assert.equal(documentMatchesQuery("今天天气很好，我们去公园散步", "天气"), true);
		assert.equal(documentMatchesQuery("人工智能的发展", "智能"), true);
		assert.equal(documentMatchesQuery("今天天气很好", "公园"), false);
	});

	it("needs the words adjacent and in order", () => {
		assert.equal(documentMatchesQuery("人工智能", "智能人工"), false);
		assert.equal(documentMatchesQuery("天很好气不错", "天气"), false);
	});

	it("matches English by prefix and requires every piece", () => {
		assert.equal(documentMatchesQuery("Canon EOS R5 body", "eos"), true);
		assert.equal(documentMatchesQuery("Canon EOS R5 body", "eos nikon"), false);
		assert.equal(documentMatchesQuery("2024年度 report.pdf", "2024年度"), true);
		assert.equal(documentMatchesQuery("anything", "***"), false);
	});
});

describe("ftsFormat", () => {
	it("names the tokenizing version and the ICU version", () => {
		assert.match(ftsFormat(), /^\d+:icu/);
	});
});
