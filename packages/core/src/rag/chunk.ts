import MarkdownIt from "markdown-it";
import {
	CHILD_TOKEN_LIMIT,
	CHILD_TOKEN_OVERLAP,
	PARENT_TOKEN_LIMIT,
} from "../model/text-embed.ts";
import { countTokens, decodeTokens, encodeTokens } from "./tokenize.ts";

export interface TextSpan {
	start: number;
	end: number;
	text: string;
	tokenCount: number;
}

export interface ParentPlan extends TextSpan {
	children: TextSpan[];
}

export interface ChunkPlan {
	parents: ParentPlan[];
}

interface SourceUnit {
	start: number;
	end: number;
	text: string;
}

const markdown = new MarkdownIt({ html: false, breaks: false, linkify: false });

export function chunkMarkdown(source: string): ChunkPlan {
	const children = splitChildren(source);
	if (children.length === 0) {
		const empty = spanOf(source, 0, source.length);
		return { parents: [{ ...empty, children: [empty] }] };
	}
	return { parents: packParents(source, children) };
}

function splitChildren(source: string): TextSpan[] {
	const children: TextSpan[] = [];
	let group: SourceUnit[] = [];

	const flush = (): void => {
		if (group.length === 0) return;
		children.push(spanOf(source, group[0]!.start, group[group.length - 1]!.end));
		group = [];
	};

	for (const unit of collectUnits(source)) {
		if (countTokens(unit.text) > CHILD_TOKEN_LIMIT) {
			flush();
			children.push(...windowUnit(source, unit));
			continue;
		}
		if (group.length === 0) {
			group = [unit];
			continue;
		}
		if (countTokens(source.slice(group[0]!.start, unit.end)) > CHILD_TOKEN_LIMIT) {
			flush();
			group = [unit];
			continue;
		}
		group.push(unit);
	}
	flush();
	return children;
}

function packParents(source: string, children: TextSpan[]): ParentPlan[] {
	const parents: ParentPlan[] = [];
	let group: TextSpan[] = [];

	const flush = (): void => {
		if (group.length === 0) return;
		const packed = spanOf(source, group[0]!.start, group[group.length - 1]!.end);
		parents.push({ ...packed, children: group });
		group = [];
	};

	for (const child of children) {
		if (group.length === 0) {
			group = [child];
			continue;
		}
		if (countTokens(source.slice(group[0]!.start, child.end)) > PARENT_TOKEN_LIMIT) {
			flush();
			group = [child];
			continue;
		}
		group.push(child);
	}
	flush();
	return parents;
}

function collectUnits(source: string): SourceUnit[] {
	const tokens = markdown.parse(source, {});
	const lineStarts = buildLineStarts(source);
	const units: SourceUnit[] = [];
	let index = 0;
	while (index < tokens.length) {
		const token = tokens[index]!;
		if (!token.map || token.nesting === -1 || token.type === "inline") {
			index += 1;
			continue;
		}
		if (token.nesting === 0) {
			units.push(unitFromLines(source, lineStarts, token.map[0], token.map[1]));
			index += 1;
			continue;
		}
		const close = findMatchingClose(tokens, index);
		const endLine = tokens[close]?.map?.[1] ?? token.map[1];
		units.push(unitFromLines(source, lineStarts, token.map[0], endLine));
		index = close + 1;
	}
	if (units.length === 0 && source.length > 0) {
		return [{ start: 0, end: source.length, text: source }];
	}
	return units.filter((unit) => unit.start < unit.end);
}

function findMatchingClose(tokens: Array<{ nesting: number }>, openIndex: number): number {
	let depth = 0;
	for (let index = openIndex; index < tokens.length; index += 1) {
		depth += tokens[index]!.nesting;
		if (depth === 0) return index;
	}
	return tokens.length - 1;
}

function windowUnit(source: string, unit: SourceUnit): TextSpan[] {
	const ids = encodeTokens(unit.text);
	if (ids.length <= CHILD_TOKEN_LIMIT) return [spanOf(source, unit.start, unit.end)];

	const children: TextSpan[] = [];
	let startTok = 0;
	let searchFrom = 0;
	while (startTok < ids.length) {
		const endTok = Math.min(startTok + CHILD_TOKEN_LIMIT, ids.length);
		const sliceText = decodeTokens(ids.slice(startTok, endTok));
		const found = unit.text.indexOf(sliceText, searchFrom);
		let start: number;
		let end: number;
		if (found >= 0) {
			start = unit.start + found;
			end = start + sliceText.length;
			searchFrom = found;
		} else {
			const prefix = decodeTokens(ids.slice(0, startTok));
			start = Math.min(unit.start + prefix.length, unit.end);
			end = Math.min(start + sliceText.length, unit.end);
		}
		children.push(spanOf(source, start, Math.max(start, end)));
		if (endTok === ids.length) break;
		startTok += CHILD_TOKEN_LIMIT - CHILD_TOKEN_OVERLAP;
	}
	return children;
}

function unitFromLines(source: string, lineStarts: number[], startLine: number, endLine: number): SourceUnit {
	const start = lineStarts[startLine] ?? source.length;
	const end = endLine < lineStarts.length ? lineStarts[endLine]! : source.length;
	return { start, end, text: source.slice(start, end) };
}

function buildLineStarts(source: string): number[] {
	const starts = [0];
	for (let index = 0; index < source.length; index += 1) {
		if (source[index] === "\n") starts.push(index + 1);
	}
	return starts;
}

function spanOf(source: string, start: number, end: number): TextSpan {
	const text = source.slice(start, end);
	return { start, end, text, tokenCount: countTokens(text) };
}
