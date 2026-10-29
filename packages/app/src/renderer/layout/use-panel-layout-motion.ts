import { useEffect, useLayoutEffect, useRef, type RefObject } from "react";

interface Frame { x: number; y: number; width: number; height: number }
interface Snapshot { element: HTMLElement; frame: Frame; animation?: Animation }

/** Drop zones use layout coordinates, independent of the visual transition. */
export function readPanelLayoutRect(element: HTMLElement): DOMRect {
	const box = element.getBoundingClientRect();
	const slot = element.closest<HTMLElement>(".panel-slot[data-slot]") ?? (element.matches(".workbench") ? element : null);
	if (!slot) return box;
	const transform = getComputedStyle(slot).transform;
	if (transform === "none") return box;
	const matrix = new DOMMatrixReadOnly(transform);
	const origin = slot.getBoundingClientRect();
	return new DOMRect(origin.x - matrix.e + (box.x - origin.x) / matrix.a,
		origin.y - matrix.f + (box.y - origin.y) / matrix.d, box.width / matrix.a, box.height / matrix.d);
}

function visualFrame(snapshot: Snapshot): Frame {
	const { element, frame, animation } = snapshot;
	if (!animation || animation.playState === "finished" || !element.isConnected) return frame;
	const matrix = new DOMMatrixReadOnly(getComputedStyle(element).transform);
	return { x: frame.x + matrix.e, y: frame.y + matrix.f, width: frame.width * matrix.a, height: frame.height * matrix.d };
}

/** Animate only preview changes. Pointer movement and resizing remain immediate. */
export function usePanelLayoutMotion(shellRef: RefObject<HTMLDivElement | null>, transitionKey: string, movingSlot: string | null, previewSlot: string | null, horizontal: boolean) {
	const snapshots = useRef(new Map<string, Snapshot>());
	const previousPreview = useRef<string | null>(null);
	useEffect(() => () => { for (const snapshot of snapshots.current.values()) snapshot.animation?.cancel(); }, []);
	useLayoutEffect(() => {
		const shell = shellRef.current;
		if (!shell) return;
		const animate = !!(previewSlot || previousPreview.current) && !matchMedia("(prefers-reduced-motion: reduce)").matches;
		const next = new Map<string, Snapshot>();
		for (const element of shell.querySelectorAll<HTMLElement>(".panel-slot[data-slot], :scope > .workbench")) {
			const id = element.dataset.slot ?? "";
			const old = snapshots.current.get(id);
			const box = readPanelLayoutRect(element);
			const frame = { x: box.x, y: box.y, width: box.width, height: box.height };
			const entering = id === previewSlot && id !== previousPreview.current;
			if (!entering && old?.element === element && Object.keys(frame).every((key) => frame[key as keyof Frame] === old.frame[key as keyof Frame])) {
				next.set(id, old);
				continue;
			}
			const from = entering ? { ...frame, ...(horizontal ? { width: Math.min(8, frame.width) } : { height: Math.min(8, frame.height) }) } : old && visualFrame(old);
			old?.animation?.cancel();
			let animation: Animation | undefined;
			if (animate && from && (id !== movingSlot || id === previewSlot) && frame.width > 0 && frame.height > 0) {
				animation = element.animate([
					{ transformOrigin: "0 0", transform: `translate(${from.x - frame.x}px, ${from.y - frame.y}px) scale(${from.width / frame.width}, ${from.height / frame.height})` },
					{ transformOrigin: "0 0", transform: "none" },
				], { duration: 180, easing: "cubic-bezier(0.2, 0.8, 0.2, 1)" });
			}
			next.set(id, { element, frame, animation });
		}
		for (const [id, snapshot] of snapshots.current) if (!next.has(id)) snapshot.animation?.cancel();
		snapshots.current = next;
		previousPreview.current = previewSlot;
	}, [shellRef, transitionKey]);
}
