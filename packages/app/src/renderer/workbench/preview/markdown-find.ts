import { closeSearchPanel, findNext, findPrevious, getSearchQuery, replaceAll, replaceNext, SearchQuery, selectMatches, setSearchQuery } from "@codemirror/search";
import { EditorView, runScopeHandlers, type Panel, type ViewUpdate } from "@codemirror/view";
import type { Messages } from "../../../shared/locale.ts";
import { isImeComposing } from "../../components/ime-composition.ts";

export type MarkdownFindLabels = Messages["find"];
export const markdownFindIconPath = "M17 10.5a6.5 6.5 0 1 1-13 0 6.5 6.5 0 0 1 13 0Zm-1.9 4.6L20 20";
// Navigation still uses CodeMirror's full search. Only the panel's index is bounded.
const countLimit = 10_000;

type Match = { from: number; to: number };

function sameSearch(first: SearchQuery, second: SearchQuery): boolean {
	return first.search === second.search && first.caseSensitive === second.caseSensitive && first.regexp === second.regexp
		&& first.wholeWord === second.wholeWord && first.literal === second.literal && first.test === second.test;
}

/** The panel owns presentation. CodeMirror owns the query, highlights and replacement transactions. */
export class MarkdownFindPanel implements Panel {
	readonly top = true;
	readonly dom: HTMLElement;
	private readonly field: HTMLInputElement;
	private readonly replacement: HTMLInputElement;
	private readonly options: HTMLElement;
	private readonly replaceRow: HTMLElement;
	private readonly replaceActions: HTMLElement;
	private readonly feedback: HTMLElement;
	private readonly count: HTMLElement;
	private readonly announcement: HTMLElement;
	private readonly resultButtons: HTMLButtonElement[];
	private readonly checkboxes: Record<"caseSensitive" | "wholeWord" | "regexp", HTMLInputElement>;
	private query: SearchQuery;
	private matches: Match[] = [];
	private more = false;
	private timer: ReturnType<typeof setTimeout> | undefined;

	constructor(private readonly view: EditorView, private readonly labels: MarkdownFindLabels) {
		const document = view.dom.ownerDocument;
		const element = <K extends keyof HTMLElementTagNameMap>(tag: K, className: string) => {
			const node = document.createElement(tag);
			node.className = className;
			return node;
		};
		const field = (name: string, placeholder: string, label = placeholder) => {
			const input = element("input", "markdown-find-field");
			input.name = name;
			input.placeholder = placeholder;
			input.setAttribute("aria-label", label);
			input.autocomplete = "off";
			input.spellcheck = false;
			input.addEventListener("input", (event) => { if (!(event as InputEvent).isComposing) this.commit(); });
			input.addEventListener("compositionend", () => this.commit());
			return input;
		};
		const button = (text: string, action?: () => void, label = text) => {
			const item = element("button", "markdown-find-button");
			item.type = "button";
			item.textContent = text;
			item.setAttribute("aria-label", label);
			item.title = label;
			if (action) item.addEventListener("click", action);
			return item;
		};
		const phrase = (key: string) => view.state.phrase(key);
		this.query = getSearchQuery(view.state);
		this.dom = element("div", "cm-search markdown-find");
		const main = element("div", "markdown-find-row");
		this.options = element("div", "markdown-find-options");
		this.options.setAttribute("popover", "auto");
		this.options.setAttribute("role", "group");
		this.options.setAttribute("aria-label", labels.options);
		this.field = field("search", labels.placeholder, labels.label);
		this.field.setAttribute("main-field", "true");
		this.count = element("span", "markdown-find-count");
		this.count.setAttribute("aria-hidden", "true");
		const searchField = element("div", "markdown-find-search");
		const searchLabel = element("label", "markdown-find-entry");
		searchLabel.append(this.field, this.count);
		const searchButton = button("", () => closeSearchPanel(view), labels.label);
		searchButton.classList.add("markdown-find-toggle");
		searchButton.setAttribute("aria-expanded", "true");
		searchButton.addEventListener("mousedown", (event) => event.preventDefault());
		const svgNamespace = "http://www.w3.org/2000/svg";
		const icon = document.createElementNS(svgNamespace, "svg");
		icon.classList.add("markdown-find-icon");
		icon.setAttribute("aria-hidden", "true");
		icon.setAttribute("viewBox", "0 0 24 24");
		const path = document.createElementNS(svgNamespace, "path");
		path.setAttribute("d", markdownFindIconPath);
		icon.append(path);
		searchButton.append(icon);
		searchField.append(searchButton, searchLabel);
		this.announcement = element("span", "markdown-find-announcement");
		this.announcement.setAttribute("role", "status");
		const previous = button("↑", () => findPrevious(view), labels.previous);
		const next = button("↓", () => findNext(view), labels.next);
		const optionsButton = button("⋯", undefined, labels.options);
		optionsButton.popoverTargetElement = this.options;
		this.options.addEventListener("toggle", () => optionsButton.setAttribute("aria-expanded", String(this.options.matches(":popover-open"))));
		optionsButton.setAttribute("aria-expanded", "false");
		const controls = element("div", "markdown-find-controls");
		controls.append(previous, next, optionsButton, button("×", () => closeSearchPanel(view), labels.close));
		main.append(searchField, this.announcement, controls);

		const advanced = element("div", "markdown-find-filters");
		this.checkboxes = {
			caseSensitive: document.createElement("input"), wholeWord: document.createElement("input"), regexp: document.createElement("input"),
		};
		const names = { caseSensitive: "match case", wholeWord: "by word", regexp: "regexp" } as const;
		for (const key of Object.keys(names) as (keyof typeof names)[]) {
			const input = this.checkboxes[key];
			input.type = "checkbox";
			input.addEventListener("change", () => this.commit());
			const label = element("label", "markdown-find-filter");
			label.append(input, phrase(names[key]));
			advanced.append(label);
		}
		const allMatches = button(phrase("Select matches"), () => selectMatches(view));
		this.replacement = field("replace", phrase("Replace with"));
		this.replaceRow = element("div", "markdown-find-replace");
		this.replaceRow.append(this.replacement);
		const actions = element("div", "markdown-find-actions");
		this.replaceActions = element("div", "markdown-find-replace-actions");
		const replace = button(phrase("Replace"), () => replaceNext(view));
		const every = button(phrase("Replace all"), () => replaceAll(view));
		every.classList.add("markdown-find-replace-all");
		this.replaceActions.append(replace, every);
		actions.append(allMatches, this.replaceActions);
		this.feedback = element("div", "markdown-find-feedback");
		this.options.append(advanced, actions, this.feedback);
		this.dom.append(main, this.options);
		this.resultButtons = [previous, next, allMatches, replace, every];
		this.syncFields();
		this.syncAccess();
		this.dom.addEventListener("keydown", (event) => {
			if (isImeComposing(event)) return;
			// The browser dismisses the options before CodeMirror handles Escape for the find bar.
			if (event.key === "Escape" && this.options.matches(":popover-open")) return;
			if (runScopeHandlers(view, event, "search-panel")) event.preventDefault();
			else if (event.key === "Enter" && event.target === this.field) {
				event.preventDefault();
				if (this.query.valid) (event.shiftKey ? findPrevious : findNext)(view);
			} else if (event.key === "Enter" && event.target === this.replacement) {
				event.preventDefault();
				if (this.query.valid) replaceNext(view);
			}
		});
	}

	mount(): void {
		this.field.select();
		this.scan(true);
	}

	destroy(): void { clearTimeout(this.timer); }

	update(update: ViewUpdate): void {
		const next = getSearchQuery(update.state);
		const searchChanged = !sameSearch(this.query, next);
		const replacementChanged = this.query.replace !== next.replace;
		if (searchChanged || replacementChanged) {
			this.query = next;
			this.syncFields();
		}
		const replacement = update.transactions.find((tr) => tr.docChanged && tr.isUserEvent("input.replace"));
		if (replacement) {
			const message = replacement.effects.find((effect) => effect.is(EditorView.announce));
			if (message) this.feedback.textContent = message.value;
		} else if (searchChanged || replacementChanged || update.docChanged) this.feedback.textContent = "";
		if (update.state.readOnly !== update.startState.readOnly) this.syncAccess();
		if (searchChanged || update.docChanged) this.scan(searchChanged);
		else if (update.selectionSet) this.showStatus();
	}

	private commit(): void {
		const next = new SearchQuery({
			...this.query, search: this.field.value, replace: this.replacement.value,
			caseSensitive: this.checkboxes.caseSensitive.checked, regexp: this.checkboxes.regexp.checked, wholeWord: this.checkboxes.wholeWord.checked,
		});
		if (!this.query.eq(next)) this.view.dispatch({ effects: setSearchQuery.of(next) });
	}

	private syncFields(): void {
		if (this.field.value !== this.query.search) this.field.value = this.query.search;
		if (this.replacement.value !== this.query.replace) this.replacement.value = this.query.replace;
		this.checkboxes.caseSensitive.checked = this.query.caseSensitive;
		this.checkboxes.wholeWord.checked = this.query.wholeWord;
		this.checkboxes.regexp.checked = this.query.regexp;
	}

	private syncAccess(): void {
		if (this.view.state.readOnly) {
			const focused = this.dom.ownerDocument.activeElement;
			if (this.replaceRow.contains(focused) || this.replaceActions.contains(focused)) this.field.focus();
			this.replaceRow.remove();
			this.feedback.textContent = "";
		} else this.options.insertBefore(this.replaceRow, this.replaceActions.parentElement!);
		this.replaceActions.hidden = this.view.state.readOnly;
	}

	private scan(selectMatch: boolean): void {
		clearTimeout(this.timer);
		this.timer = undefined;
		this.matches = [];
		this.more = false;
		if (this.query.valid) this.timer = setTimeout(() => {
			this.timer = undefined;
			const { state } = this.view;
			const cursor = this.query.getCursor(state);
			for (let match = cursor.next(); !match.done; match = cursor.next()) {
				if (this.matches.length === countLimit) { this.more = true; break; }
				this.matches.push(match.value);
			}
			if (selectMatch && this.activeIndex() === -1) {
				const match = this.matches.find(({ from }) => from >= state.selection.main.from) ?? this.matches[0];
				if (match) this.view.dispatch({
					selection: { anchor: match.from, head: match.to },
					effects: EditorView.scrollIntoView(match.from), userEvent: "select.search",
				});
			}
			this.showStatus();
		}, 120);
		this.showStatus();
	}

	private activeIndex(): number {
		const selected = this.view.state.selection.main;
		return this.matches.findIndex(({ from, to }) => from === selected.from && to === selected.to);
	}

	private showStatus(): void {
		const invalid = !!this.query.search && !this.query.valid;
		for (const button of this.resultButtons) button.disabled = !this.query.valid || this.timer === undefined && !this.matches.length;
		this.field.setAttribute("aria-invalid", String(invalid));
		let text = "";
		let announcement = "";
		if (invalid) text = announcement = this.labels.invalidRegex;
		else if (this.query.search && this.timer === undefined) {
			const index = this.activeIndex() + 1;
			const count = String(this.matches.length) + (this.more ? "+" : "");
			if (!this.matches.length) text = announcement = this.labels.none;
			else if (!index) text = announcement = this.labels.count(count);
			else {
				text = `${index} / ${count}`;
				announcement = this.labels.position(String(index), count);
			}
		}
		if (this.count.textContent !== text) this.count.textContent = text;
		if (this.announcement.textContent !== announcement) this.announcement.textContent = announcement;
	}
}
