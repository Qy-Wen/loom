import { markdownLanguage } from "@codemirror/lang-markdown";
import { ensureSyntaxTree, type syntaxTree } from "@codemirror/language";
import { EditorSelection, type EditorState, type TransactionSpec } from "@codemirror/state";
import { findWikiLinks } from "@loom/core/references";
import { markdownFormats, type MarkdownBlockFormat, type MarkdownFormat, type MarkdownInlineFormat } from "../../../shared/ipc.ts";
import { matchBlockMath, matchInlineMath } from "./math.ts";

type Tree = ReturnType<typeof syntaxTree>;
type Node = ReturnType<Tree["resolve"]>;
type Span = { from: number; to: number };
type FormatPlan = { checked: boolean; transaction: () => TransactionSpec | null };
type Block = Span & { kind: string; body: string; checkedTask?: boolean };

const inlineStyles = {
	bold: { node: "StrongEmphasis", mark: "EmphasisMark", delimiters: ["**", "__"] },
	italic: { node: "Emphasis", mark: "EmphasisMark", delimiters: ["*", "_"] },
	strikethrough: { node: "Strikethrough", mark: "StrikethroughMark", delimiters: ["~~"] },
	inlineCode: { node: "InlineCode", mark: "CodeMark", delimiters: [] },
};
const stylesByNode = new Map(Object.values(inlineStyles).map((style) => [style.node, style]));
const literalBlocks = new Set(["FencedCode", "CodeBlock", "Table", "HTMLBlock", "CommentBlock", "ProcessingInstructionBlock", "LinkReference", "HorizontalRule"]);
const structuralMarks = new Set(["HeaderMark", "ListMark", "TaskMarker", "QuoteMark"]);
const inlineMarks = new Set(["EmphasisMark", "StrikethroughMark", "CodeMark", "LinkMark", "Escape", "Entity", "URL", "Autolink", "HTMLTag"]);

function overlaps(first: Span, second: Span): boolean {
	return first.from < second.to && second.from < first.to;
}

function contains(outer: Span, inner: Span): boolean {
	return outer.from <= inner.from && outer.to >= inner.to;
}

function selection(state: EditorState, from: number, to: number): EditorSelection {
	return state.selection.main.anchor <= state.selection.main.head ? EditorSelection.single(from, to) : EditorSelection.single(to, from);
}

function codeDelimiters(text: string): readonly [string, string] {
	let size = 1;
	for (const ticks of text.matchAll(/`+/g)) size = Math.max(size, ticks[0].length + 1);
	const fence = "`".repeat(size);
	return /^`|`$/.test(text) ? [`${fence} `, ` ${fence}`] : [fence, fence];
}

function inlineBody(state: EditorState, node: Node): Span | null {
	const style = stylesByNode.get(node.name);
	if (!style) return null;
	const marks = node.getChildren(style.mark);
	if (marks.length < 2) return null;
	const from = marks[0].to;
	const to = marks.at(-1)!.from;
	if (node.name === "InlineCode") {
		const code = state.sliceDoc(from, to);
		if (code.startsWith(" ") && code.endsWith(" ") && code.trim()) return { from: from + 1, to: to - 1 };
	}
	return { from, to };
}

function selectsBody(state: EditorState, node: Node, body: Span, picked: Span): boolean {
	let current = node;
	let span = body;
	while (contains(span, picked)) {
		if (span.from === picked.from && span.to === picked.to) return true;
		// A nested style can use every character of its parent's body (e.g. ***word***).
		const child = current.childAfter(span.from);
		if (!child || child.from !== span.from || child.to !== span.to) return false;
		const inner = inlineBody(state, child);
		if (!inner) return false;
		current = child;
		span = inner;
	}
	return false;
}

function inlinePlans(state: EditorState, tree: Tree, plans: Map<MarkdownFormat, FormatPlan>): void {
	const range = state.selection.main;
	const line = state.doc.lineAt(range.from);
	if (range.to > line.to) return;
	const raw = state.sliceDoc(range.from, range.to);
	const text = raw.trim();
	if (!text) return;
	const from = range.from + raw.length - raw.trimStart().length;
	const to = from + text.length;
	const picked = { from, to };
	const targetNodes = new Map<string, { span: Span; body: Span }>();
	const coveredStyles = new Set<string>();
	let mayWrap = true;
	let literal = false;
	tree.iterate({ from, to, enter(ref) {
		if (!overlaps(ref, picked)) return false;
		if (literalBlocks.has(ref.name) || structuralMarks.has(ref.name) || (ref.name === "Paragraph" && isFormula(state, ref))) {
			literal = true;
			return false;
		}
		const body = inlineBody(state, ref.node);
		if (body) {
			if (contains(body, picked)) coveredStyles.add(ref.name);
			if ((from === ref.from && to === ref.to) || selectsBody(state, ref.node, body, picked)) {
				targetNodes.set(ref.name, { span: { from: ref.from, to: ref.to }, body });
			}
			if (contains(picked, ref)) return false;
			if (ref.name === "InlineCode") { mayWrap = false; return false; }
		}
		if (inlineMarks.has(ref.name) && !contains(picked, ref.node.parent ?? ref)) mayWrap = false;
	} });
	if (literal) return;
	const splits = (start: number, end: number) => {
		const span = { from: line.from + start, to: line.from + end };
		return overlaps(picked, span) && !contains(picked, span);
	};
	if (findWikiLinks(line.text).some((link) => splits(link.from, link.end))) return;
	for (const match of line.text.matchAll(/\$|\\\(/g)) {
		const math = matchInlineMath(line.text, match.index);
		if (math && splits(match.index, math.end)) return;
	}

	const before = line.text.slice(0, from - line.from);
	const after = line.text.slice(to - line.from);
	for (const format of markdownFormats.inline) {
		const style = inlineStyles[format];
		const existing = targetNodes.get(style.node);
		if (existing) {
			const body = state.sliceDoc(existing.body.from, existing.body.to);
			const selected = contains(existing.body, picked) ? picked : existing.body;
			const removed = existing.body.from - existing.span.from;
			plans.set(format, { checked: true, transaction: () => ({
				changes: { ...existing.span, insert: body },
				selection: selection(state, selected.from - removed, selected.to - removed),
			}) });
			continue;
		}
		if (!mayWrap || coveredStyles.has(style.node)) continue;
		const delimiters = format === "inlineCode" ? [codeDelimiters(text)] : style.delimiters.map((mark) => [mark, mark] as const);
		for (const [open, close] of delimiters) {
			const insert = open + text + close;
			const end = before.length + insert.length;
			const parsed = markdownLanguage.parser.parse(before + insert + after);
			let valid = false;
			parsed.iterate({ from: before.length, to: end, enter(node) {
				if (node.name === style.node && node.from === before.length && node.to === end) valid = true;
			} });
			if (!valid) continue;
			plans.set(format, { checked: false, transaction: () => ({
				changes: { from, to, insert },
				selection: selection(state, from + open.length, to + open.length),
			}) });
			break;
		}
	}
}

function isFormula(state: EditorState, node: Span): boolean {
	const text = state.sliceDoc(node.from, node.to);
	return matchBlockMath(text)?.end === text.length;
}

function readBlock(state: EditorState, node: Node): Block | null {
	const from = state.doc.lineAt(node.from).from;
	const to = node.to;
	const text = (start: number, end = to) => state.sliceDoc(start, end);
	if (node.name === "Paragraph" && !isFormula(state, node)) return { from, to, kind: "paragraph", body: text(node.from) };
	if (/^(ATX|Setext)Heading[1-6]$/.test(node.name)) {
		const marks = node.getChildren("HeaderMark");
		const kind = `heading${node.name.at(-1)}`;
		if (node.name.startsWith("Setext")) {
			return { from, to, kind, body: text(node.from, state.doc.lineAt(marks[0].from).from - 1) };
		}
		return { from, to, kind, body: text(marks[0].to, marks[1]?.from).trim() };
	}
	if (node.name === "Blockquote") {
		for (let child = node.firstChild; child; child = child.nextSibling) {
			if (child.name !== "QuoteMark" && child.name !== "Paragraph") return null;
		}
		return { from, to, kind: "quote", body: text(from).replace(/^ {0,3}>[ \t]?/gm, "") };
	}
	if (node.name === "ListItem") {
		const content = node.firstChild?.nextSibling;
		if (!content || content.nextSibling || (content.name !== "Paragraph" && content.name !== "Task")) return null;
		const task = content.getChild("TaskMarker");
		const kind = task ? "task" : node.parent?.name === "OrderedList" ? "ordered" : "bullet";
		const indent = new RegExp(`^ {1,${content.from - from}}`);
		const lines = text(task?.to ?? content.from).trimStart().split("\n");
		const body = lines.map((line, index) => index ? line.replace(indent, "") : line).join("\n");
		return { from, to, kind, body, checkedTask: task ? /x/i.test(text(task.from, task.to)) : undefined };
	}
	return null;
}

function selectedBlocks(state: EditorState, tree: Tree): Block[] {
	const range = state.selection.main;
	const from = state.doc.lineAt(range.from).from;
	const to = state.doc.lineAt(range.to - 1).to;
	const picked = { from, to };
	const blocks: Block[] = [];
	let valid = true;
	tree.iterate({ from, to, enter(ref) {
		if (!overlaps(picked, ref)) return false;
		if (["Document", "BulletList", "OrderedList"].includes(ref.name)) return;
		const block = readBlock(state, ref.node);
		if (block?.body.trim()) blocks.push(block);
		else valid = false;
		return false;
	} });
	return valid ? blocks : [];
}

function blockText(block: Block, format: MarkdownBlockFormat, index: number): string {
	const lines = block.body.split("\n");
	switch (format) {
		case "paragraph": return block.body;
		case "heading1": case "heading2": case "heading3": return `${"#".repeat(Number(format.at(-1)))} ${lines.map((line) => line.trim()).join(" ")}`;
		case "quote": return lines.map((line) => line ? `> ${line}` : ">").join("\n");
		case "bullet": case "ordered": case "task": {
			const marker = format === "ordered" ? `${index + 1}. ` : "- ";
			const task = format === "task" ? (block.checkedTask ? "[x] " : "[ ] ") : "";
			return [marker + task + lines[0], ...lines.slice(1).map((line) => " ".repeat(marker.length) + line)].join("\n");
		}
	}
}

function blockTransaction(state: EditorState, blocks: Block[], format: MarkdownBlockFormat): TransactionSpec | null {
	const from = blocks[0].from;
	const to = blocks.at(-1)!.to;
	const first = state.doc.lineAt(from);
	const last = state.doc.lineAt(to);
	// A blank line keeps a conversion from becoming a lazy continuation of an unselected neighbor.
	const before = first.number > 1 && state.doc.line(first.number - 1).text.trim() ? "\n" : "";
	const after = last.number < state.doc.lines && state.doc.line(last.number + 1).text.trim() ? "\n" : "";
	const separator = format === "quote" ? "\n>\n" : ["bullet", "ordered", "task"].includes(format) ? "\n" : "\n\n";
	const text = blocks.map((block, index) => blockText(block, format, index)).join(separator);
	const expected = {
		paragraph: "Paragraph", heading1: "ATXHeading1", heading2: "ATXHeading2", heading3: "ATXHeading3",
		quote: "Blockquote", bullet: "BulletList", ordered: "OrderedList", task: "BulletList",
	}[format];
	for (let node = markdownLanguage.parser.parse(text).topNode.firstChild; node; node = node.nextSibling) {
		if (node.name !== expected) return null;
	}
	const start = from + before.length;
	return { changes: { from, to, insert: before + text + after }, selection: selection(state, start, start + text.length) };
}

/** Plan against the snapshot that opened the native menu. Every command is a single edit. */
export function markdownFormatPlans(state: EditorState): Map<MarkdownFormat, FormatPlan> {
	const plans = new Map<MarkdownFormat, FormatPlan>();
	const range = state.selection.main;
	if (state.readOnly || range.empty || !state.sliceDoc(range.from, range.to).trim()) return plans;
	const tree = ensureSyntaxTree(state, state.doc.lineAt(range.to - 1).to, 30);
	if (!tree) return plans;
	inlinePlans(state, tree, plans);
	const blocks = selectedBlocks(state, tree);
	if (!blocks.length) return plans;
	for (const format of markdownFormats.block) {
		const checked = blocks.every((block) => block.kind === format);
		plans.set(format, { checked, transaction: () => checked ? null : blockTransaction(state, blocks, format) });
	}
	return plans;
}
