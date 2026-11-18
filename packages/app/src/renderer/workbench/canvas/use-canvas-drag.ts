import { useEffect, useRef, type PointerEvent, type RefObject } from "react";
import type { Point } from "./canvas-layout.ts";

type Drag = {
	id: number;
	origin: Point;
	point: Point;
	frame: number;
	threshold: number;
	started: boolean;
	update: (delta: Point) => void;
	finish: (delta: Point | null) => void;
};

export function useCanvasDrag(surface: RefObject<HTMLDivElement | null>) {
	const drag = useRef<Drag | null>(null);

	function delta(current: Drag, point: Point): Point {
		return { x: point.x - current.origin.x, y: point.y - current.origin.y };
	}

	function begin(event: PointerEvent, update: Drag["update"], finish: Drag["finish"], threshold = 0): void {
		if (drag.current || !surface.current) return;
		const point = { x: event.clientX, y: event.clientY };
		drag.current = { id: event.pointerId, origin: point, point, frame: 0, threshold, started: threshold === 0, update, finish };
		if (threshold === 0) surface.current.setPointerCapture(event.pointerId);
	}

	function move(event: PointerEvent): void {
		const current = drag.current;
		if (!current || current.id !== event.pointerId) return;
		current.point = { x: event.clientX, y: event.clientY };
		if (!current.started) {
			const distance = delta(current, current.point);
			if (Math.hypot(distance.x, distance.y) < current.threshold) return;
			current.started = true;
			surface.current?.setPointerCapture(event.pointerId);
		}
		if (!current.frame) current.frame = requestAnimationFrame(() => {
			current.frame = 0;
			current.update(delta(current, current.point));
		});
	}

	function end(event: PointerEvent, cancelled = false): void {
		const current = drag.current;
		if (!current || current.id !== event.pointerId) return;
		drag.current = null;
		cancelAnimationFrame(current.frame);
		current.finish(cancelled || !current.started ? null : delta(current, { x: event.clientX, y: event.clientY }));
	}

	useEffect(() => () => {
		if (drag.current) cancelAnimationFrame(drag.current.frame);
	}, []);

	return { drag, begin, move, end };
}
