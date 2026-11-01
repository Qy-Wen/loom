import { useEffect, useRef, useState } from "react";
import { normalizeCurve, type CurvePoint } from "@loom/core/grade";
import { token } from "../../design/tokens.ts";
import { onThemeChange } from "../../design/theme.ts";

const PAD = 10;

export function GradeCurve({
	points,
	colorToken,
	onChange,
}: {
	points: CurvePoint[];
	/** Name of the color token, without `--lm-`. Read at paint time so the curve follows the theme. */
	colorToken: string;
	onChange: (points: CurvePoint[]) => void;
}): React.JSX.Element {
	const canvasRef = useRef<HTMLCanvasElement>(null);
	const pointsRef = useRef(points);
	const dragRef = useRef<number | null>(null);
	pointsRef.current = points;

	const [themeTick, setThemeTick] = useState(0);
	useEffect(() => onThemeChange(() => setThemeTick((n) => n + 1)), []);

	useEffect(() => {
		const canvas = canvasRef.current;
		if (!canvas) return;
		const context = canvas.getContext("2d");
		if (!context) return;
		const width = canvas.clientWidth;
		const height = canvas.clientHeight;
		const ratio = window.devicePixelRatio || 1;
		canvas.width = Math.max(1, Math.round(width * ratio));
		canvas.height = Math.max(1, Math.round(height * ratio));
		context.setTransform(ratio, 0, 0, ratio, 0, 0);
		context.clearRect(0, 0, width, height);
		context.strokeStyle = token("surface-active");
		context.lineWidth = 1;
		for (const step of [0.25, 0.5, 0.75]) {
			const vertical = toCanvas({ x: step, y: 0 }, width, height).x;
			const horizontal = toCanvas({ x: 0, y: step }, width, height).y;
			context.beginPath();
			context.moveTo(vertical, PAD);
			context.lineTo(vertical, height - PAD);
			context.moveTo(PAD, horizontal);
			context.lineTo(width - PAD, horizontal);
			context.stroke();
		}
		context.strokeStyle = token("border-strong");
		context.beginPath();
		context.moveTo(PAD, height - PAD);
		context.lineTo(width - PAD, PAD);
		context.stroke();
		const color = token(colorToken);
		context.strokeStyle = color;
		context.lineWidth = 1.5;
		context.beginPath();
		points.forEach((point, index) => {
			const plotted = toCanvas(point, width, height);
			if (index === 0) context.moveTo(plotted.x, plotted.y);
			else context.lineTo(plotted.x, plotted.y);
		});
		context.stroke();
		for (const point of points) {
			const plotted = toCanvas(point, width, height);
			context.beginPath();
			context.fillStyle = token("surface-raised");
			context.arc(plotted.x, plotted.y, 4, 0, Math.PI * 2);
			context.fill();
			context.lineWidth = 1.5;
			context.strokeStyle = color;
			context.stroke();
		}
	}, [colorToken, points, themeTick]);

	function update(next: CurvePoint[]): void {
		onChange(normalizeCurve(next));
	}

	function pointerPoint(event: React.MouseEvent<HTMLCanvasElement>): CurvePoint {
		const bounds = event.currentTarget.getBoundingClientRect();
		return fromCanvas(event.clientX - bounds.left, event.clientY - bounds.top, bounds.width, bounds.height);
	}

	function hitIndex(point: CurvePoint, width: number, height: number): number {
		const plotted = toCanvas(point, width, height);
		let found = -1;
		pointsRef.current.forEach((candidate, index) => {
			const other = toCanvas(candidate, width, height);
			const distance = Math.hypot(other.x - plotted.x, other.y - plotted.y);
			if (distance <= 8) found = index;
		});
		return found;
	}

	return (
		<canvas
			ref={canvasRef}
			className="grade-curve"
			onPointerDown={(event) => {
				event.currentTarget.setPointerCapture(event.pointerId);
				const bounds = event.currentTarget.getBoundingClientRect();
				const point = pointerPoint(event);
				const hit = hitIndex(point, bounds.width, bounds.height);
				if (hit >= 0) {
					dragRef.current = hit;
					return;
				}
				if (pointsRef.current.length >= 16) return;
				const next = normalizeCurve([...pointsRef.current, point]);
				const created = next.findIndex((candidate) => Math.abs(candidate.x - point.x) < 0.0001);
				dragRef.current = created > 0 && created < next.length - 1 ? created : null;
				update(next);
			}}
			onPointerMove={(event) => {
				const index = dragRef.current;
				if (index === null) return;
				const point = pointerPoint(event);
				const current = pointsRef.current;
				const next = current.map((candidate, candidateIndex) => {
					if (candidateIndex !== index) return candidate;
					if (candidateIndex === 0) return { x: 0, y: point.y };
					if (candidateIndex === current.length - 1) return { x: 1, y: point.y };
					return point;
				});
				update(next);
			}}
			onPointerUp={() => {
				dragRef.current = null;
			}}
			onDoubleClick={(event) => {
				const bounds = event.currentTarget.getBoundingClientRect();
				const hit = hitIndex(pointerPoint(event), bounds.width, bounds.height);
				if (hit <= 0 || hit >= pointsRef.current.length - 1) return;
				update(pointsRef.current.filter((_, index) => index !== hit));
			}}
			onContextMenu={(event) => {
				event.preventDefault();
				const bounds = event.currentTarget.getBoundingClientRect();
				const hit = hitIndex(pointerPoint(event), bounds.width, bounds.height);
				if (hit <= 0 || hit >= pointsRef.current.length - 1) return;
				update(pointsRef.current.filter((_, index) => index !== hit));
			}}
		/>
	);
}

function toCanvas(point: CurvePoint, width: number, height: number): { x: number; y: number } {
	return {
		x: PAD + point.x * (width - PAD * 2),
		y: PAD + (1 - point.y) * (height - PAD * 2),
	};
}

function fromCanvas(x: number, y: number, width: number, height: number): CurvePoint {
	const spanX = Math.max(1, width - PAD * 2);
	const spanY = Math.max(1, height - PAD * 2);
	return {
		x: clamp((x - PAD) / spanX),
		y: clamp(1 - (y - PAD) / spanY),
	};
}

function clamp(value: number): number {
	return Math.min(1, Math.max(0, value));
}
