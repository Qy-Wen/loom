import {
	type CSSProperties,
	type PointerEvent as ReactPointerEvent,
	type RefObject,
	useEffect,
	useRef,
	useState,
} from "react";
import {
	bottomBand,
	clampFloat,
	type FloatRect,
	MIN_PANEL_HEIGHT,
	pointerNearLowerBand,
	type PanelPlace,
	pointerDocks,
	pointerInside,
} from "./panel-geometry.ts";

export type PanelId = "agent" | "details";
type ResizeEdge = "right" | "bottom" | "corner";

interface TabReorder {
	id: PanelId;
	insertX: number | null;
}

interface DragState {
	id: PanelId;
	rect: FloatRect;
	dock: boolean;
	lower: FloatRect | null;
	join: PanelId | null;
	joinFrame: FloatRect | null;
	group: boolean;
}

const PLACE_KEY: Record<PanelId, string> = {
	agent: "loom.layout.agentPlace",
	details: "loom.layout.detailsPlace",
};
const SPLIT_KEY = "loom.layout.dockSplit";
const BOTTOM_KEY = "loom.layout.bottomHeight";
const JOINED_KEY = "loom.layout.joined";
const TAB_KEY = "loom.layout.tab";
const TAB_ORDER_KEY = "loom.layout.tabOrder";

function readTabOrder(): [PanelId, PanelId] {
	return localStorage.getItem(TAB_ORDER_KEY) === "details,agent" ? ["details", "agent"] : ["agent", "details"];
}

/** Swap the two tabs once the pointer crosses the midpoint of the other one. */
export function nextTabOrder(
	order: readonly [PanelId, PanelId],
	id: PanelId,
	clientX: number,
	otherMidX: number,
): [PanelId, PanelId] {
	const leading = order[0] === id;
	const crossed = leading ? clientX > otherMidX : clientX < otherMidX;
	return crossed ? [order[1], order[0]] : [order[0], order[1]];
}

function readPlace(id: PanelId): PanelPlace {
	try {
		const raw = JSON.parse(localStorage.getItem(PLACE_KEY[id]) ?? "") as Partial<FloatRect> & { mode?: string };
		if (raw.mode === "dock" || raw.mode === "bottom") return { mode: raw.mode };
		if (
			raw.mode === "float"
			&& typeof raw.x === "number"
			&& typeof raw.y === "number"
			&& typeof raw.width === "number"
			&& typeof raw.height === "number"
		) {
			return { mode: "float", x: raw.x, y: raw.y, width: raw.width, height: raw.height };
		}
	} catch {
		// A missing or old value stays docked.
	}
	return { mode: "dock" };
}

function readBottom(): number {
	const value = Number(localStorage.getItem(BOTTOM_KEY));
	if (!Number.isFinite(value)) return 340;
	return Math.min(640, Math.max(160, value));
}

function readSplit(): number {
	const value = Number(localStorage.getItem(SPLIT_KEY));
	if (!Number.isFinite(value)) return 0.5;
	return Math.min(0.72, Math.max(0.28, value));
}

/** Docked or floating placement for the Agent and Details windows. */
export function usePanelLayout(shellRef: RefObject<HTMLDivElement | null>): {
	place: (id: PanelId) => PanelPlace;
	style: (id: PanelId) => CSSProperties;
	anyDocked: boolean;
	anyBottom: boolean;
	bothDocked: boolean;
	bothBottom: boolean;
	bottomHeight: number;
	dragDock: boolean;
	lowerFrame: FloatRect | null;
	joined: boolean;
	tab: PanelId;
	tabOrder: [PanelId, PanelId];
	tabReorder: TabReorder | null;
	joinTarget: PanelId | null;
	joinFrame: FloatRect | null;
	groupDrag: boolean;
	stackStyle: () => CSSProperties | undefined;
	isSnapping: (id: PanelId) => boolean;
	focus: (id: PanelId) => void;
	beginDrag: (id: PanelId, event: ReactPointerEvent<HTMLElement>) => void;
	beginTabDrag: (id: PanelId, event: ReactPointerEvent<HTMLElement>) => void;
	beginGroupDrag: (event: ReactPointerEvent<HTMLElement>) => void;
	beginResize: (id: PanelId, edge: ResizeEdge, event: ReactPointerEvent<HTMLElement>) => void;
	beginDockSplit: (event: ReactPointerEvent<HTMLElement>) => void;
	beginBottomResize: (event: ReactPointerEvent<HTMLElement>) => void;
} {
	const [places, setPlaces] = useState<Record<PanelId, PanelPlace>>(() => {
		const agent = readPlace("agent");
		const details = readPlace("details");
		if (localStorage.getItem(JOINED_KEY) === "1") return { agent, details: agent };
		return { agent, details };
	});
	const [split, setSplit] = useState(readSplit);
	const [bottomHeight, setBottomHeight] = useState(readBottom);
	const [joined, setJoined] = useState(() => localStorage.getItem(JOINED_KEY) === "1");
	const [tab, setTab] = useState<PanelId>(localStorage.getItem(TAB_KEY) === "details" ? "details" : "agent");
	const [tabOrder, setTabOrder] = useState<[PanelId, PanelId]>(readTabOrder);
	const tabOrderRef = useRef(tabOrder);
	const [tabReorder, setTabReorder] = useState<TabReorder | null>(null);
	const tabReorderRef = useRef<TabReorder | null>(null);
	const [z, setZ] = useState<Record<PanelId, number>>({ agent: 2, details: 1 });
	const [drag, setDrag] = useState<DragState | null>(null);

	useEffect(() => {
		localStorage.setItem(PLACE_KEY.agent, JSON.stringify(places.agent));
		localStorage.setItem(PLACE_KEY.details, JSON.stringify(places.details));
	}, [places]);

	useEffect(() => {
		localStorage.setItem(SPLIT_KEY, String(split));
	}, [split]);

	useEffect(() => {
		localStorage.setItem(BOTTOM_KEY, String(bottomHeight));
	}, [bottomHeight]);

	useEffect(() => {
		localStorage.setItem(JOINED_KEY, joined ? "1" : "0");
	}, [joined]);

	useEffect(() => {
		localStorage.setItem(TAB_KEY, tab);
	}, [tab]);

	useEffect(() => {
		localStorage.setItem(TAB_ORDER_KEY, tabOrder.join(","));
	}, [tabOrder]);

	useEffect(() => {
		const shell = shellRef.current;
		if (!shell) return;
		const observer = new ResizeObserver(() => {
			const bounds = shell.getBoundingClientRect();
			setPlaces((current) => {
				let changed = false;
				const next = { ...current };
				for (const id of ["agent", "details"] as const) {
					const place = current[id];
					if (place.mode !== "float") continue;
					const clamped = clampFloat(place, bounds);
					if (clamped.x !== place.x || clamped.y !== place.y || clamped.width !== place.width || clamped.height !== place.height) {
						next[id] = { mode: "float", ...clamped };
						changed = true;
					}
				}
				return changed ? next : current;
			});
		});
		observer.observe(shell);
		return () => observer.disconnect();
	}, [shellRef]);

	function focus(id: PanelId): void {
		setTab(id);
		setZ((current) => {
			const top = Math.max(current.agent, current.details);
			if (current[id] === top) return current;
			return { ...current, [id]: top + 1 };
		});
	}

	function otherHit(id: PanelId, clientX: number, clientY: number): PanelId | null {
		const otherId: PanelId = id === "agent" ? "details" : "agent";
		const other = document.querySelector(`.work-panel[data-panel="${otherId}"]`);
		if (!(other instanceof HTMLElement)) return null;
		return pointerInside(clientX, clientY, other.getBoundingClientRect()) ? otherId : null;
	}

	function panelFrame(id: PanelId, bounds: DOMRect): FloatRect | null {
		const panel = document.querySelector(`.work-panel[data-panel="${id}"]`);
		if (!(panel instanceof HTMLElement)) return null;
		const box = panel.getBoundingClientRect();
		return {
			x: box.left - bounds.left,
			y: box.top - bounds.top,
			width: box.width,
			height: box.height,
		};
	}

	function place(id: PanelId): PanelPlace {
		if (drag?.id === id && !drag.group) return { mode: "float", ...drag.rect };
		return places[id];
	}

	function beginDrag(
		id: PanelId,
		event: ReactPointerEvent<HTMLElement> | PointerEvent,
		kind: "panel" | "tab" | "group" = "panel",
		source?: HTMLElement,
		immediate = false,
	): void {
		if (!immediate && event.button !== 0) return;
		const handle = source ?? (event.currentTarget instanceof HTMLElement ? event.currentTarget : null);
		const shell = shellRef.current;
		const panel = handle && ((kind === "group" || (kind === "tab" && joined))
			? handle.closest(".side-stack")
			: handle.closest(".work-panel"));
		if (!shell || !(panel instanceof HTMLElement)) return;
		event.preventDefault();
		event.stopPropagation();
		if (kind !== "group") focus(id);
		const origin = panel.getBoundingClientRect();
		const shellOrigin = shell.getBoundingClientRect();
		const grabX = event.clientX - origin.left;
		const startX = event.clientX;
		const startY = event.clientY;
		let grabY = event.clientY - origin.top;
		let width = origin.width;
		let height = origin.height;
		const canReturnToDock = places[id].mode === "float" || places[id].mode === "bottom";
		let moved = false;
		let rect: FloatRect = {
			x: origin.left - shellOrigin.left,
			y: origin.top - shellOrigin.top,
			width,
			height,
		};
		let dockHit = false;
		let lowerHit: FloatRect | null = null;
		let joinHit: PanelId | null = null;
		const group = kind === "group";
		// A tab drag starts inside the joined window. Rejoin only after the pointer has left it,
		// so the same gesture can pull a tab out and drop it back.
		let joinArmed = kind !== "tab";
		const originBox = origin;

		const engage = (bounds: DOMRect) => {
			moved = true;
			document.body.classList.add("dragging-panel");
			if (kind === "tab" && joined) setJoined(false);
			if (height > bounds.height * 0.62) {
				height = Math.max(MIN_PANEL_HEIGHT, Math.round(bounds.height * 0.55));
				grabY = Math.min(grabY, height - 24);
			}
		};

		const onMove = (move: PointerEvent) => {
			const bounds = shell.getBoundingClientRect();
			if (!moved) {
				if (Math.hypot(move.clientX - startX, move.clientY - startY) < 4) return;
				engage(bounds);
			}
			const free = clampFloat({
				x: move.clientX - bounds.left - grabX,
				y: move.clientY - bounds.top - grabY,
				width,
				height,
			}, bounds);
			if (!joinArmed && !pointerInside(move.clientX, move.clientY, originBox)) joinArmed = true;
			joinHit = group || !joinArmed ? null : otherHit(id, move.clientX, move.clientY);
			dockHit = !joinHit && pointerDocks(move.clientX, bounds.right);
			const otherId: PanelId = id === "agent" ? "details" : "agent";
			const metrics = readShellMetrics(shell);
			const sideInset = group || places[otherId].mode !== "dock" ? 0 : metrics.side;
			const slot = bottomBand(bounds, metrics.library, sideInset, bottomHeight);
			lowerHit = !joinHit && !dockHit && pointerNearLowerBand(move.clientX - bounds.left, move.clientY - bounds.top, slot) ? slot : null;
			rect = lowerHit ?? free;
			setDrag({ id, rect, dock: dockHit, lower: lowerHit, join: joinHit, joinFrame: joinHit ? panelFrame(joinHit, bounds) : null, group });
		};

		const onUp = (up: PointerEvent) => {
			document.body.classList.remove("dragging-panel");
			window.removeEventListener("pointermove", onMove);
			window.removeEventListener("pointerup", onUp);
			setDrag(null);
			if (!moved) {
				if (kind === "tab") setTab(id);
				else if ((group || canReturnToDock) && up.detail >= 2) {
					const dock = { mode: "dock" } as const;
					setPlaces(group ? { agent: dock, details: dock } : (current) => ({ ...current, [id]: dock }));
				}
				return;
			}
			const otherId: PanelId = id === "agent" ? "details" : "agent";
			if (joinHit) {
				const target = places[otherId];
				setJoined(true);
				setTab(id);
				setPlaces({ agent: target, details: target });
				return;
			}
			const bounds = shell.getBoundingClientRect();
			const next: PanelPlace = dockHit
				? { mode: "dock" }
				: lowerHit
					? { mode: "bottom" }
					: { mode: "float", ...clampFloat(rect, bounds) };
			setPlaces((current) => group ? { agent: next, details: next } : { ...current, [id]: next });
		};

		window.addEventListener("pointermove", onMove);
		window.addEventListener("pointerup", onUp);
		if (immediate) {
			engage(shell.getBoundingClientRect());
			onMove(event instanceof PointerEvent ? event : new PointerEvent("pointermove"));
		}
	}

	function beginTabDrag(id: PanelId, event: ReactPointerEvent<HTMLElement>): void {
		if (event.button !== 0) return;
		const bar = event.currentTarget.closest(".panel-tabs");
		if (!(bar instanceof HTMLElement) || !joined) {
			beginDrag(id, event, "tab");
			return;
		}
		event.preventDefault();
		event.stopPropagation();
		const originX = event.clientX;
		const originY = event.clientY;
		const source = event.currentTarget;

		const showReorder = (next: TabReorder | null) => {
			const current = tabReorderRef.current;
			if (current?.id === next?.id && current?.insertX === next?.insertX) return;
			tabReorderRef.current = next;
			setTabReorder(next);
		};

		const onMove = (move: PointerEvent) => {
			if (Math.hypot(move.clientX - originX, move.clientY - originY) < 4) return;
			const barBox = bar.getBoundingClientRect();
			const outside = move.clientY < barBox.top - 8
				|| move.clientY > barBox.bottom + 8
				|| move.clientX < barBox.left - 12
				|| move.clientX > barBox.right + 12;
			if (outside) {
				window.removeEventListener("pointermove", onMove);
				window.removeEventListener("pointerup", onUp);
				showReorder(null);
				beginDrag(id, move, "tab", source, true);
				return;
			}
			const order = tabOrderRef.current;
			const otherId: PanelId = order[0] === id ? order[1] : order[0];
			const other = bar.querySelector(`button[data-tab="${otherId}"]`);
			if (!(other instanceof HTMLElement)) return;
			const otherBox = other.getBoundingClientRect();
			const crossed = nextTabOrder(order, id, move.clientX, otherBox.left + otherBox.width / 2)[0] !== order[0];
			const insertX = crossed
				? (order[0] === id ? otherBox.right : otherBox.left) - barBox.left
				: null;
			showReorder({ id, insertX });
		};

		const onUp = (up: PointerEvent) => {
			window.removeEventListener("pointermove", onMove);
			window.removeEventListener("pointerup", onUp);
			const insert = tabReorderRef.current?.insertX != null;
			showReorder(null);
			if (insert) {
				const order = tabOrderRef.current;
				const next: [PanelId, PanelId] = [order[1], order[0]];
				tabOrderRef.current = next;
				setTabOrder(next);
				return;
			}
			if (Math.hypot(up.clientX - originX, up.clientY - originY) < 4) setTab(id);
		};

		window.addEventListener("pointermove", onMove);
		window.addEventListener("pointerup", onUp);
	}

	function beginGroupDrag(event: ReactPointerEvent<HTMLElement>): void {
		beginDrag("agent", event, "group");
	}

	function beginResize(id: PanelId, edge: ResizeEdge, event: ReactPointerEvent<HTMLElement>): void {
		if (event.button !== 0) return;
		const shell = shellRef.current;
		const current = places[id];
		if (!shell || current.mode !== "float") return;
		event.preventDefault();
		event.stopPropagation();
		if (!joined) focus(id);
		const startX = event.clientX;
		const startY = event.clientY;
		const origin = current;
		document.body.classList.add("resizing-panel");

		const onMove = (move: PointerEvent) => {
			const bounds = shell.getBoundingClientRect();
			const next = clampFloat({
				x: origin.x,
				y: origin.y,
				width: origin.width + (edge === "bottom" ? 0 : move.clientX - startX),
				height: origin.height + (edge === "right" ? 0 : move.clientY - startY),
			}, bounds);
			const place = { mode: "float" as const, ...next };
			setPlaces((placesNow) => joined ? { agent: place, details: place } : { ...placesNow, [id]: place });
		};

		const onUp = () => {
			document.body.classList.remove("resizing-panel");
			window.removeEventListener("pointermove", onMove);
			window.removeEventListener("pointerup", onUp);
		};

		window.addEventListener("pointermove", onMove);
		window.addEventListener("pointerup", onUp);
	}

	function beginBottomResize(event: ReactPointerEvent<HTMLElement>): void {
		const shell = shellRef.current;
		if (event.button !== 0 || !shell) return;
		event.preventDefault();
		const bounds = shell.getBoundingClientRect();
		document.body.classList.add("resizing-rows");

		const onMove = (move: PointerEvent) => {
			setBottomHeight(Math.min(bounds.height - 180, Math.max(160, bounds.bottom - move.clientY)));
		};

		const onUp = () => {
			document.body.classList.remove("resizing-rows");
			window.removeEventListener("pointermove", onMove);
			window.removeEventListener("pointerup", onUp);
		};

		window.addEventListener("pointermove", onMove);
		window.addEventListener("pointerup", onUp);
	}

	function beginDockSplit(event: ReactPointerEvent<HTMLElement>): void {
		const stack = event.currentTarget.parentElement;
		if (event.button !== 0 || !stack) return;
		event.preventDefault();
		const bounds = stack.getBoundingClientRect();
		document.body.classList.add("resizing-rows");

		const onMove = (move: PointerEvent) => {
			const ratio = (move.clientY - bounds.top) / bounds.height;
			setSplit(Math.min(0.72, Math.max(0.28, ratio)));
		};

		const onUp = () => {
			document.body.classList.remove("resizing-rows");
			window.removeEventListener("pointermove", onMove);
			window.removeEventListener("pointerup", onUp);
		};

		window.addEventListener("pointermove", onMove);
		window.addEventListener("pointerup", onUp);
	}

	const agentPlace = place("agent");
	const detailsPlace = place("details");
	const bothDocked = agentPlace.mode === "dock" && detailsPlace.mode === "dock";
	const anyDocked = agentPlace.mode === "dock" || detailsPlace.mode === "dock";
	const bothBottom = agentPlace.mode === "bottom" && detailsPlace.mode === "bottom";
	const anyBottom = agentPlace.mode === "bottom" || detailsPlace.mode === "bottom";
	function style(id: PanelId): CSSProperties {
		if (joined || drag?.group) return {};
		const shown = place(id);
		if (shown.mode === "float") {
			return {
				left: shown.x,
				top: shown.y,
				width: shown.width,
				height: shown.height,
				zIndex: 8 + z[id],
			};
		}
		if (shown.mode === "bottom" && bothBottom) {
			return { flexGrow: id === "agent" ? split : 1 - split, flexBasis: 0 };
		}
		if (shown.mode === "bottom" || (shown.mode === "dock" && anyBottom)) return {};
		return { flexGrow: bothDocked ? (id === "agent" ? split : 1 - split) : 1, flexBasis: 0 };
	}

	function stackStyle(): CSSProperties | undefined {
		if (drag?.group) return { left: drag.rect.x, top: drag.rect.y, width: drag.rect.width, height: drag.rect.height };
		if (joined && places.agent.mode === "float") {
			return {
				left: places.agent.x,
				top: places.agent.y,
				width: places.agent.width,
				height: places.agent.height,
				zIndex: 8 + Math.max(z.agent, z.details),
			};
		}
		return undefined;
	}

	return {
		place,
		style,
		anyDocked,
		anyBottom,
		bothDocked,
		bothBottom,
		bottomHeight,
		dragDock: drag?.dock ?? false,
		lowerFrame: drag?.lower ?? null,
		joined,
		tab,
		tabOrder,
		tabReorder,
		joinTarget: drag?.join ?? null,
		joinFrame: drag?.joinFrame ?? null,
		groupDrag: drag?.group ?? false,
		stackStyle,
		isSnapping: (id) => drag?.id === id && !drag.group && (drag.dock || drag.lower !== null),
		focus,
		beginDrag,
		beginTabDrag,
		beginGroupDrag,
		beginResize,
		beginDockSplit,
		beginBottomResize,
	};
}

function readShellMetrics(shell: HTMLElement): { library: number; side: number } {
	const style = getComputedStyle(shell);
	const library = Number.parseFloat(style.getPropertyValue("--library-width"));
	const side = Number.parseFloat(style.getPropertyValue("--side-width"));
	return {
		library: Number.isFinite(library) ? library : 0,
		side: Number.isFinite(side) ? side : 0,
	};
}
