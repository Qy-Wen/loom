import { autocompletion, closeCompletion, completionStatus, pickedCompletion, startCompletion, type Completion } from "@codemirror/autocomplete";
import { isolateHistory } from "@codemirror/commands";
import { syntaxTree } from "@codemirror/language";
import { StateEffect, StateField, type EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import type { Asset } from "@loom/core";
import { messages, type Messages } from "../../../shared/locale.ts";
import { markdownFilePath } from "./live-markdown.ts";
import { enterTable } from "./live-table.ts";
import { markdownLibraryReference } from "../../../shared/markdown-reference.ts";
import { wikiLinkCompletion, wikiTargetAt } from "./markdown-wiki-completion.ts";

type Labels = Messages["preview"]["insertCommands"];
type Insertion = { text: string; cursor: number };
type Command = { id: keyof Labels; icon: string; aliases?: string; text?: string; cursor?: number };
const commands: readonly Command[] = [
	{ id: "heading1", icon: "M4 6v12m9-12v12M4 12h9m4 1 2-2v7m-2 0h4", aliases: "h1 一级", text: "# " },
	{ id: "heading2", icon: "M4 6v12m9-12v12M4 12h9m4 1a2 2 0 1 1 3.4 1.4L17 18h4", aliases: "h2 二级", text: "## " },
	{ id: "heading3", icon: "M4 6v12m9-12v12M4 12h9m4-1h4l-2 3a2 2 0 1 1-2 3", aliases: "h3 三级", text: "### " },
	{ id: "bullet", icon: "M4 6h.01M4 12h.01M4 18h.01M9 6h11M9 12h11M9 18h11", aliases: "ul 项目符号", text: "- " },
	{ id: "ordered", icon: "M4 7l2-2v5m-2 0h4m-4 5a2 2 0 1 1 3.4 1.4L4 20h4m4-13h8m-8 10h8", aliases: "ol 序号 数字", text: "1. " },
	{ id: "task", icon: "M14 5h5v14H5V5h5m-2 6 3 3 7-8", aliases: "todo checklist 待办 复选框", text: "- [ ] " },
	{ id: "quote", icon: "M10 11H4v6h6v-6m-6 0c0-3 1-5 4-6m12 6h-6v6h6v-6m-6 0c0-3 1-5 4-6", aliases: "blockquote 引述", text: "> " },
	{ id: "table", icon: "M4 5h16v14H4zM4 10h16m-8 0v9", text: "|  |  |\n| --- | --- |\n|  |  |", cursor: 2 },
	{ id: "code", icon: "m8 7-5 5 5 5m8-10 5 5-5 5m-2-13-4 16", aliases: "fence 代码", text: "```\n\n```", cursor: 4 },
	{ id: "divider", icon: "M4 12h16", aliases: "hr 横线", text: "---\n" },
	{ id: "formula", icon: "M18 5H6l6 7-6 7h12", aliases: "math latex 数学", text: "$$\n\n$$", cursor: 3 },
	{ id: "diagram", icon: "M9 3h6v5H9zM3 16h6v5H3zm12 0h6v5h-6zM12 8v4m-6 4v-4h12v4",
		aliases: "flowchart 图表", text: "```mermaid\nflowchart TD\n    A --> B\n```", cursor: 28 },
	{ id: "asset", icon: "M10 13a4 4 0 0 0 5.7 0l4-4A4 4 0 0 0 14 3.3l-2 2m2 5.7a4 4 0 0 0-5.7 0l-4 4A4 4 0 0 0 10 20.7l2-2", aliases: "link wiki 链接 引用 素材" },
];
const query = /^[\p{L}\p{M}\p{N} _-]*$/u;
const codeBlocks = new Set(["FencedCode", "CodeBlock", "HTMLBlock", "Table"]);
const requestInsert = StateEffect.define<null>();
const insertRequested = StateField.define<boolean>({
	create: () => false,
	update(value, transaction) {
		return transaction.effects.some((effect) => effect.is(requestInsert))
			|| value && !transaction.docChanged && !transaction.selection;
	},
});

function renderCommandIcon(completion: Completion, _state: EditorState, view: EditorView): SVGSVGElement | null {
	const command = commands.find(({ id }) => id === completion.type);
	if (!command) return null;
	const document = view.dom.ownerDocument;
	const namespace = "http://www.w3.org/2000/svg";
	const icon = document.createElementNS(namespace, "svg");
	icon.classList.add("markdown-insert-icon");
	icon.setAttribute("viewBox", "0 0 24 24");
	icon.setAttribute("aria-hidden", "true");
	const path = document.createElementNS(namespace, "path");
	path.setAttribute("d", command.icon);
	icon.append(path);
	return icon;
}

function blockAt(state: EditorState, position: number) {
	let node = syntaxTree(state).resolveInner(position, -1);
	while (node.parent && node.parent.name !== "Document") node = node.parent;
	return node.name === "Document" ? null : node;
}

function isLiteral(state: EditorState, position: number): boolean {
	for (let node = syntaxTree(state).resolveInner(position, -1); node; ) {
		if (codeBlocks.has(node.name)) return true;
		if (!node.parent) break;
		node = node.parent;
	}
	return false;
}

function slashQueryStart(state: EditorState, position: number): number | null {
	const line = state.doc.lineAt(position);
	const offset = position - line.from;
	if (offset < 1 || !line.text.startsWith("/") || !query.test(line.text.slice(1, offset))
		|| line.text.slice(offset).trim() || isLiteral(state, position)) return null;
	return line.from + 1;
}

const openCompletionAtCaret = EditorView.updateListener.of((update) => {
	const { state, view } = update;
	const deleted = update.docChanged && update.transactions.some((transaction) => transaction.isUserEvent("delete"));
	const moved = !update.docChanged && update.selectionSet && !update.startState.selection.eq(state.selection);
	if ((!deleted && !moved) || state.readOnly || !state.selection.main.empty) return;
	const position = state.selection.main.head;
	const wikiTarget = wikiTargetAt(state, position);
	const shouldOpen = deleted
		? wikiTarget !== null || slashQueryStart(state, position) !== null
		: wikiTarget?.canOpenOnMove;
	if (!shouldOpen) return;
	queueMicrotask(() => {
		if (view.dom.isConnected && view.hasFocus && view.state.doc === state.doc
			&& view.state.selection.eq(state.selection) && !completionStatus(view.state)) startCompletion(view);
	});
});

function insert(view: EditorView, completion: Completion, from: number, to: number, insertion: Insertion, typedSlash: boolean): number {
	const doc = view.state.doc;
	const line = doc.lineAt(from);
	const startsNewBlock = !typedSlash && !!line.text.slice(0, from - line.from).trim();
	const start = startsNewBlock ? from : line.from;
	const end = startsNewBlock ? to : line.to;
	const before = startsNewBlock ? "\n\n" : line.number > 1 && doc.line(line.number - 1).text.trim() ? "\n" : "";
	const after = line.number < doc.lines && doc.line(line.number + 1).text.trim() ? "\n" : "";
	view.dispatch({
		changes: { from: start, to: end, insert: before + insertion.text + after },
		selection: { anchor: start + before.length + insertion.cursor },
		annotations: [pickedCompletion.of(completion), isolateHistory.of("full")],
		userEvent: "input.complete",
		scrollIntoView: true,
	});
	return start + before.length;
}

export function markdownInsert(labels: Labels, pickAsset: (onPick: (file: Asset) => void) => void) {
	const options = (typedSlash: boolean): Completion[] => commands.map((command, index) => {
		const displayLabel = labels[command.id];
		return {
			label: [...new Set([displayLabel, messages.en.preview.insertCommands[command.id], messages["zh-CN"].preview.insertCommands[command.id], command.aliases].filter(Boolean))].join(" "),
			displayLabel,
			type: command.id,
			sortText: String(index).padStart(2, "0"),
			apply(view, completion, from, to) {
				if (view.state.readOnly) return;
				if (command.text !== undefined) {
					const start = insert(view, completion, from, to, { text: command.text, cursor: command.cursor ?? command.text.length }, typedSlash);
					if (command.id === "table") enterTable(view, start, "first");
					return;
				}
				closeCompletion(view);
				const original = view.state.doc;
				pickAsset((file) => {
					if (!view.dom.isConnected || view.state.doc !== original || view.state.readOnly) return;
					const sourcePath = markdownFilePath(view.state);
					if (!sourcePath) return;
					const text = markdownLibraryReference(sourcePath, file.relativePath);
					insert(view, completion, from, to, { text, cursor: text.length }, typedSlash);
					view.focus();
				});
			},
		};
	});
	const typedOptions = options(true);
	const explicitOptions = options(false);
	return [insertRequested, openCompletionAtCaret, autocompletion({
		override: [(context) => {
			if (context.state.readOnly || !context.state.selection.main.empty) return null;
			if (!context.explicit || !context.state.field(insertRequested)) {
				const wiki = wikiLinkCompletion(context);
				if (wiki) return wiki;
			}
			const from = slashQueryStart(context.state, context.pos);
			if (from !== null) {
				return {
					from, options: typedOptions,
					validFor: (_text, start, end, state) => slashQueryStart(state, end) === start,
				};
			}
			if (!context.explicit) return null;
			const line = context.state.doc.lineAt(context.pos);
			return !line.text.slice(context.pos - line.from).trim()
				? { from: context.pos, options: explicitOptions, validFor: query }
				: null;
		}],
		tooltipClass: () => "cm-markdown-insert",
		icons: false,
		addToOptions: [{ position: 20, render: renderCommandIcon }],
		interactionDelay: 0,
	})];
}

/** An explicit insertion starts after the current Markdown block, or in an empty line. */
export function openMarkdownInsert(view: EditorView): void {
	if (view.state.readOnly) return;
	const { doc, selection } = view.state;
	const line = doc.lineAt(selection.main.head);
	const block = blockAt(view.state, selection.main.head);
	const position = line.text.trim() || block ? doc.lineAt(block?.to ?? line.to).to : line.to;
	view.dispatch({ selection: { anchor: position }, effects: requestInsert.of(null), scrollIntoView: true });
	view.focus();
	startCompletion(view);
}
