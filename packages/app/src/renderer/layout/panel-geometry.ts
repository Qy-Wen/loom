export interface FloatRect {
	x: number;
	y: number;
	width: number;
	height: number;
}

export type PanelPlace =
	| { mode: "dock" }
	| { mode: "bottom" }
	| { mode: "beside" }
	| { mode: "above" }
	| ({ mode: "float" } & FloatRect);

export const MIN_PANEL_WIDTH = 300;
export const MIN_PANEL_HEIGHT = 200;
/** Cursor within this many pixels of the shell's right edge docks the window. */
export const DOCK_EDGE = 36;
/** Slack around the lower band before the pointer snaps a window onto it. */
export const LOWER_SNAP_X = 48;
export const LOWER_SNAP_Y = 48;

export function clampFloat(rect: FloatRect, shell: { width: number; height: number }): FloatRect {
	const width = Math.min(shell.width, Math.max(rect.width, Math.min(MIN_PANEL_WIDTH, shell.width)));
	const height = Math.min(shell.height, Math.max(rect.height, Math.min(MIN_PANEL_HEIGHT, shell.height)));
	return {
		x: Math.min(Math.max(rect.x, 0), Math.max(0, shell.width - width)),
		y: Math.min(Math.max(rect.y, 0), Math.max(0, shell.height - height)),
		width,
		height,
	};
}

export function pointerDocks(clientX: number, shellRight: number): boolean {
	return shellRight - clientX <= DOCK_EDGE;
}

export function pointerInside(
	clientX: number,
	clientY: number,
	rect: { left: number; top: number; right: number; bottom: number },
): boolean {
	return clientX >= rect.left && clientX <= rect.right && clientY >= rect.top && clientY <= rect.bottom;
}

/** Bottom band whose edges meet the library, the other sidebar, and the top divider. */
export function bottomBand(
	shell: { width: number; height: number },
	libraryWidth: number,
	sideWidth: number,
	bandHeight: number,
): FloatRect {
	const x = libraryWidth + 5;
	const rowHeight = Math.min(Math.max(160, bandHeight), Math.max(160, shell.height - 180));
	const right = sideWidth > 0 ? sideWidth + 5 : 0;
	const y = Math.max(0, shell.height - rowHeight - 5);
	return {
		x,
		y,
		width: Math.max(0, shell.width - x - right),
		height: shell.height - y,
	};
}

type Box = { left: number; top: number; right: number; bottom: number };

/** Left strip of a right-hand panel, plus a little of the workbench just beside it. */
export function pointerOnLeftEdge(clientX: number, clientY: number, box: Box): boolean {
	if (clientY < box.top || clientY > box.bottom) return false;
	const edge = Math.min(96, Math.max(36, (box.right - box.left) * 0.34));
	return clientX >= box.left - 28 && clientX <= box.left + edge;
}

/** Vertical docking wins at a right panel's top/bottom; the middle remains a tab target. */
export function dockSplitEdge(clientX: number, clientY: number, box: Box): "top" | "bottom" | null {
	if (!pointerInside(clientX, clientY, box)) return null;
	const edge = Math.min(64, Math.max(24, (box.bottom - box.top) * 0.2));
	if (clientY <= box.top + edge) return "top";
	if (clientY >= box.bottom - edge) return "bottom";
	return null;
}

/** Top strip of a lower panel, plus the gap just above it. */
export function pointerOnTopEdge(clientX: number, clientY: number, box: Box): boolean {
	if (clientX < box.left || clientX > box.right) return false;
	const edge = Math.min(80, Math.max(36, (box.bottom - box.top) * 0.34));
	return clientY >= box.top - LOWER_SNAP_Y && clientY <= box.top + edge;
}

/** Snap follows the pointer. A tall window's center must not keep the snap after the cursor leaves. */
export function pointerNearLowerBand(x: number, y: number, slot: FloatRect): boolean {
	return x >= slot.x - LOWER_SNAP_X
		&& x <= slot.x + slot.width
		&& y >= slot.y - LOWER_SNAP_Y
		&& y <= slot.y + slot.height;
}
