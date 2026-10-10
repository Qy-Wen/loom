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
const MIN_WORKBENCH_WIDTH = 320;
const MIN_SIDE_WIDTH = 300;
const HANDLE_WIDTH = 10;

type ResizeSide = "library" | "side";

/** Owns column drag state and persists the user's preferred sidebar widths. */
export function useResizableLayout(): {
	shellRef: React.RefObject<HTMLDivElement | null>;
	shellStyle: CSSProperties;
	beginResize: (side: ResizeSide, event: ReactPointerEvent<HTMLDivElement>) => void;
	resetLibraryWidth: () => void;
	resetSideWidth: () => void;
} {
	const [libraryWidth, setLibraryWidth] = useState(() =>
		Number(localStorage.getItem("loom.layout.libraryWidth")) || DEFAULT_LIBRARY_WIDTH,
	);
	const [sideWidth, setSideWidth] = useState(() =>
		Number(localStorage.getItem("loom.layout.sideWidth")) || DEFAULT_SIDE_WIDTH,
	);
	const shellRef = useRef<HTMLDivElement>(null);

	useEffect(() => {
		localStorage.setItem("loom.layout.libraryWidth", String(libraryWidth));
	}, [libraryWidth]);

	useEffect(() => {
		localStorage.setItem("loom.layout.sideWidth", String(sideWidth));
	}, [sideWidth]);

	function beginResize(side: ResizeSide, event: ReactPointerEvent<HTMLDivElement>): void {
		if (event.button !== 0 || !shellRef.current) return;
		event.preventDefault();
		const bounds = shellRef.current.getBoundingClientRect();
		document.body.classList.add("resizing-columns");

		const onPointerMove = (moveEvent: PointerEvent) => {
			if (side === "library") {
				const sideGap = shellRef.current?.querySelector(".side-stack") ? sideWidth + HANDLE_WIDTH : 0;
				const maximum = Math.max(
					MIN_LIBRARY_WIDTH,
					Math.min(360, bounds.width - sideGap - MIN_WORKBENCH_WIDTH - HANDLE_WIDTH),
				);
				setLibraryWidth(Math.min(maximum, Math.max(MIN_LIBRARY_WIDTH, moveEvent.clientX - bounds.left)));
			} else {
				const maximum = Math.max(
					MIN_SIDE_WIDTH,
					Math.min(520, bounds.width - libraryWidth - MIN_WORKBENCH_WIDTH - HANDLE_WIDTH * 2),
				);
				setSideWidth(Math.min(maximum, Math.max(MIN_SIDE_WIDTH, bounds.right - moveEvent.clientX)));
			}
		};

		const onPointerUp = () => {
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
			"--library-width": `${libraryWidth}px`,
			"--side-width": `${sideWidth}px`,
		} as CSSProperties,
		beginResize,
		resetLibraryWidth: () => setLibraryWidth(DEFAULT_LIBRARY_WIDTH),
		resetSideWidth: () => setSideWidth(DEFAULT_SIDE_WIDTH),
	};
}
