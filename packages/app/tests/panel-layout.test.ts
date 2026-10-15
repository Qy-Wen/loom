import assert from "node:assert/strict";
import { test } from "node:test";
import { activeTab, extractPanel, focusPanel, movePanel, PANEL_LAYOUT_KEY, readPanelLayout, reconcilePanels, reorderTabs, resizeSlots, slotFor, slotWeights, type PanelLayoutState, type PanelRegistration } from "../src/renderer/layout/panel-layout.ts";

const registrations: PanelRegistration[] = ["chat", "details", "grade", "timeline", "inspector", "notes"].map((id) => ({ id, visible: true }));
const storage = (rows: Record<string, string> = {}) => ({ getItem: (key: string) => rows[key] ?? null });
const initial = () => readPanelLayout(storage(), registrations);
const join = (state: PanelLayoutState, id: string, target: string) => movePanel(state, { kind: "panel", id }, { kind: "join", target: slotFor(state, target)!.id });

test("a fresh layout joins a panel into its anchor and leaves the anchor selected", () => {
	const panels = registrations.map((panel) => panel.id === "details" ? { ...panel, initialJoin: ["chat"] } : panel);
	const state = readPanelLayout(storage(), panels);
	const slot = slotFor(state, "chat")!;
	assert.deepEqual(slot.tabs, ["chat", "details"]);
	assert.equal(slot.active, "chat");
	assert.equal(slotFor(state, "details"), slot);
	assert.ok(state.opened.includes("details"));
	const saved = readPanelLayout(storage({ "loom.layout.chatPlace": '{"mode":"bottom"}' }), panels);
	assert.deepEqual(slotFor(saved, "details")!.tabs, ["details"]);
	assert.equal(slotFor(saved, "chat")!.place.mode, "bottom");
});

test("six registered panels support multiple independent tab groups and group-to-group merge", () => {
	let state = join(initial(), "details", "chat");
	state = join(state, "inspector", "timeline");
	assert.equal(state.slots.filter((slot) => slot.tabs.length > 1).length, 2);
	const source = slotFor(state, "timeline")!;
	state = movePanel(state, { kind: "slot", id: source.id }, { kind: "join", target: slotFor(state, "chat")!.id });
	assert.deepEqual(slotFor(state, "chat")!.tabs, ["chat", "details", "timeline", "inspector"]);
	assert.equal(slotFor(state, "notes")!.tabs.length, 1);
});

for (const region of ["dock", "beside", "above", "bottom"] as const) test(`all IDs support ordered split, resize, detach, and persistence in ${region}`, () => {
	let state = initial();
	state = movePanel(state, { kind: "panel", id: "timeline" }, { kind: "place", place: { mode: region } });
	state = movePanel(state, { kind: "panel", id: "inspector" }, { kind: "split", target: slotFor(state, "timeline")!.id, edge: "top" });
	state = movePanel(state, { kind: "panel", id: "notes" }, { kind: "split", target: slotFor(state, "timeline")!.id, edge: "bottom" });
	const slots = state.slots.filter((slot) => slot.place.mode === region && ["timeline", "inspector", "notes"].some((id) => slot.tabs.includes(id)));
	assert.deepEqual(slots.map((slot) => slot.tabs[0]), ["inspector", "timeline", "notes"]);
	state = resizeSlots(state, slots[0].id, slots[1].id, 0.7);
	const restored = readPanelLayout(storage({ [PANEL_LAYOUT_KEY]: JSON.stringify(state) }), registrations);
	assert.deepEqual(restored, state);
	const group = join(restored, "inspector", "timeline");
	const extracted = extractPanel(group, { kind: "panel", id: "timeline" })!;
	assert.equal(extracted.slot.tabs[0], "timeline");
	assert.ok(extracted.state.slots.some((slot) => slot.tabs.includes("inspector")));
});

test("every ordered pair of six panels uses the same split and merge operations in all regions", () => {
	for (const region of ["dock", "beside", "above", "bottom"] as const) for (const a of registrations) for (const b of registrations) if (a.id !== b.id) {
		let state = movePanel(initial(), { kind: "panel", id: b.id }, { kind: "place", place: { mode: region } });
		for (const edge of ["top", "bottom"] as const) {
			const split = movePanel(state, { kind: "panel", id: a.id }, { kind: "split", target: slotFor(state, b.id)!.id, edge });
			const aIndex = split.slots.indexOf(slotFor(split, a.id)!);
			const bIndex = split.slots.indexOf(slotFor(split, b.id)!);
			assert.equal(aIndex < bIndex, edge === "top", `${region}/${a.id}/${b.id}/${edge}`);
			state = join(split, a.id, b.id);
			assert.deepEqual(slotFor(state, a.id)!.tabs, [b.id, a.id]);
			state = movePanel(state, { kind: "panel", id: a.id }, { kind: "place", place: { mode: "float", x: 20, y: 20, width: 320, height: 240 } });
		}
	}
});

test("floating groups split into independent bounded rectangles and retain all tabs", () => {
	let state = join(initial(), "inspector", "timeline");
	state = movePanel(state, { kind: "slot", id: slotFor(state, "timeline")!.id }, { kind: "place", place: { mode: "float", x: 40, y: 20, width: 360, height: 500 } });
	state = movePanel(state, { kind: "panel", id: "notes" }, { kind: "split", target: slotFor(state, "timeline")!.id, edge: "bottom" });
	assert.deepEqual(slotFor(state, "timeline")!.place, { mode: "float", x: 40, y: 20, width: 360, height: 250 });
	assert.deepEqual(slotFor(state, "notes")!.place, { mode: "float", x: 40, y: 270, width: 360, height: 250 });
	assert.deepEqual(slotFor(state, "inspector")!.tabs, ["timeline", "inspector"]);
});

test("hidden tabs retain their slot and fallback selection; newly registered panels reconcile once", () => {
	const state = join(initial(), "inspector", "timeline");
	const hidden = registrations.map((panel) => ({ ...panel, visible: panel.id !== "inspector" }));
	assert.equal(activeTab(slotFor(state, "timeline")!, hidden), "timeline");
	const next = reconcilePanels(state, [...hidden, { id: "seventh", visible: true }]);
	assert.equal(next.slots.filter((slot) => slot.tabs.includes("seventh")).length, 1);
	assert.deepEqual(reconcilePanels(next, [...hidden, { id: "seventh", visible: true }]), next);
	assert.throws(() => reconcilePanels(state, [...registrations, registrations[0]]), /Duplicate/);
});

test("first-use policy is registration-owned and later floating placement survives reopen", () => {
	const panels = registrations.map((panel) => panel.id === "notes" ? { ...panel, visible: false, firstOpen: { place: { mode: "dock" as const }, join: ["timeline"] } } : panel);
	let state = readPanelLayout(storage(), panels);
	assert.ok(!state.opened.includes("notes"));
	state = readPanelLayout(storage({ [PANEL_LAYOUT_KEY]: JSON.stringify(state) }), panels);
	state = focusPanel(state, "notes", panels);
	assert.deepEqual(slotFor(state, "notes")!.tabs, ["timeline", "notes"]);
	const rect = { mode: "float" as const, x: 40, y: 60, width: 320, height: 240 };
	state = movePanel(state, { kind: "panel", id: "notes" }, { kind: "place", place: rect });
	state = focusPanel(readPanelLayout(storage({ [PANEL_LAYOUT_KEY]: JSON.stringify(state) }), panels), "notes", panels);
	assert.deepEqual(slotFor(state, "notes")!.place, rect);
});

test("legacy placement imports once and malformed/unknown slots cannot hide registered panels", () => {
	const legacy = readPanelLayout(storage({ "loom.layout.chatPlace": '{"mode":"bottom"}', "loom.layout.detailsPlace": '{"mode":"dock"}', "loom.layout.members": "chat,details", "loom.layout.tab": "details" }), registrations);
	assert.equal(slotFor(legacy, "details")!.place.mode, "bottom");
	assert.equal(slotFor(legacy, "details")!.active, "details");
	const bad = readPanelLayout(storage({ [PANEL_LAYOUT_KEY]: JSON.stringify({ version: 1, slots: [{ id: "unknown", tabs: ["ghost"], active: "ghost", place: { mode: "dock" }, weight: 1 }], opened: [] }) }), registrations);
	assert.equal(bad.slots.length, registrations.length);
});

test("reorder keeps hidden tabs in place and normalized weights always fill the region", () => {
	const slot = { id: "a", tabs: ["chat", "grade", "details"], active: "chat", place: { mode: "dock" as const }, weight: 0.05 };
	assert.deepEqual(reorderTabs(slot, ["chat", "details"], ["details", "chat"]).tabs, ["details", "grade", "chat"]);
	assert.equal(slotWeights([slot]).get("a"), 1);
});
