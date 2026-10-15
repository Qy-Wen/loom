import {
	type CSSProperties,
	type PointerEvent as ReactPointerEvent,
	useEffect,
	useRef,
	useState,
} from "react";

export const DEFAULT_LIBRARY_WIDTH = 240;
export const DEFAULT_SIDE_WIDTH = 380;
const MIN_LIBRARY_WIDTH = 180;
const MIN_WORKBENCH_WIDTH = 240;
const MIN_SIDE_WIDTH = 200;
const HANDLE_WIDTH = 10;
const COLLAPSED_LIBRARY_WIDTH = 0;
const COLLAPSED_LIBRARY_GAP = 0;
const LIBRARY_COLLAPSED_KEY = "loom.layout.libraryCollapsed";

type ResizeSide = "library" | "side" | "beside";
const BESIDE_KEY = "loom.layout.besideWidth";
const DEFAULT_BESIDE_WIDTH = 300;

/** Owns column drag state and persists the user's preferred sidebar widths. */
export function useResizableLayout(): {
	shellRef: React.RefObject<HTMLDivElement | null>;
	shellStyle: CSSProperties;
	libraryCollapsed: boolean;
	toggleLibraryCollapsed: () => void;
	beginResize: (side: ResizeSide, event: ReactPointerEvent<HTMLDivElement>) => void;
	resetLibraryWidth: () => void;
	resetSideWidth: () => void;
	resetBesideWidth: () => void;
} {
	const [libraryWidth, setLibraryWidth] = useState(() =>
		Number(localStorage.getItem("loom.layout.libraryWidth")) || DEFAULT_LIBRARY_WIDTH,
	);
	const [sideWidth, setSideWidth] = useState(() =>
		Number(localStorage.getItem("loom.layout.sideWidth")) || DEFAULT_SIDE_WIDTH,
	);
	const [besideWidth, setBesideWidth] = useState(() =>
		Number(localStorage.getItem(BESIDE_KEY)) || DEFAULT_BESIDE_WIDTH,
	);
	const [libraryCollapsed, setLibraryCollapsed] = useState(() => localStorage.getItem(LIBRARY_COLLAPSED_KEY) === "1");
	const shellRef = useRef<HTMLDivElement>(null);
	const libraryTaken = libraryCollapsed ? COLLAPSED_LIBRARY_WIDTH + COLLAPSED_LIBRARY_GAP : libraryWidth + HANDLE_WIDTH;

	useEffect(() => {
		localStorage.setItem("loom.layout.libraryWidth", String(libraryWidth));
	}, [libraryWidth]);

	useEffect(() => {
		localStorage.setItem("loom.layout.sideWidth", String(sideWidth));
	}, [sideWidth]);

	useEffect(() => {
		localStorage.setItem(BESIDE_KEY, String(besideWidth));
	}, [besideWidth]);

	useEffect(() => {
		localStorage.setItem(LIBRARY_COLLAPSED_KEY, libraryCollapsed ? "1" : "0");
	}, [libraryCollapsed]);

	function beginResize(side: ResizeSide, event: ReactPointerEvent<HTMLDivElement>): void {
		if (event.button !== 0 || !shellRef.current) return;
		event.preventDefault();
		const bounds = shellRef.current.getBoundingClientRect();
		const handle = event.currentTarget;
		handle.classList.add("dragging");
		document.body.classList.add("resizing-columns");

		const onPointerMove = (moveEvent: PointerEvent) => {
			const besideOpen = !!shellRef.current?.querySelector(".beside-resize");
			const sideOpen = !!shellRef.current?.querySelector(".side-resize");
			if (side === "library") {
				const taken = (besideOpen ? besideWidth + HANDLE_WIDTH : 0) + (sideOpen ? sideWidth + HANDLE_WIDTH : 0);
				const room = bounds.width - taken - MIN_WORKBENCH_WIDTH - HANDLE_WIDTH;
				setLibraryWidth(clampColumn(moveEvent.clientX - bounds.left, room, MIN_LIBRARY_WIDTH));
			} else if (side === "beside") {
				const rightInset = sideOpen ? sideWidth + HANDLE_WIDTH : 0;
				const room = bounds.width - libraryTaken - rightInset - MIN_WORKBENCH_WIDTH - HANDLE_WIDTH;
				setBesideWidth(clampColumn(bounds.right - rightInset - moveEvent.clientX, room, MIN_SIDE_WIDTH));
			} else {
				const leftInset = besideOpen ? besideWidth + HANDLE_WIDTH : 0;
				const room = bounds.width - libraryTaken - leftInset - MIN_WORKBENCH_WIDTH - HANDLE_WIDTH;
				setSideWidth(clampColumn(bounds.right - moveEvent.clientX, room, MIN_SIDE_WIDTH));
			}
		};

		const onPointerUp = () => {
			handle.classList.remove("dragging");
			document.body.classList.remove("resizing-columns");
			window.removeEventListener("pointermove", onPointerMove);
			window.removeEventListener("pointerup", onPointerUp);
		};

		window.addEventListener("pointermove", onPointerMove);
		window.addEventListener("pointerup", onPointerUp);
	}

	return {
		shellRef,
		shellStyle: {
			"--library-width": `${libraryCollapsed ? COLLAPSED_LIBRARY_WIDTH : libraryWidth}px`,
			"--library-gap": libraryCollapsed ? `${COLLAPSED_LIBRARY_GAP}px` : `${HANDLE_WIDTH}px`,
			"--side-width": `${sideWidth}px`,
			"--beside-width": `${besideWidth}px`,
		} as CSSProperties,
		libraryCollapsed,
		toggleLibraryCollapsed: () => setLibraryCollapsed((collapsed) => !collapsed),
		beginResize,
		resetLibraryWidth: () => setLibraryWidth(DEFAULT_LIBRARY_WIDTH),
		resetSideWidth: () => setSideWidth(DEFAULT_SIDE_WIDTH),
		resetBesideWidth: () => setBesideWidth(DEFAULT_BESIDE_WIDTH),
	};
}

/** Stop at the other columns' reserved room. The preferred minimum yields when that room is smaller. */
export function clampColumn(proposed: number, room: number, minimum: number): number {
	const ceiling = Math.max(room, 0);
	const floor = Math.min(minimum, ceiling);
	return Math.min(ceiling, Math.max(floor, proposed));
}
