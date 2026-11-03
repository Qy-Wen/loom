import { useRef } from "react";
import { clickMode } from "./tree-context.tsx";

/** Count click pairs so two quick double-clicks fold twice, even in one continuous run of clicks. */
export function useFolderDoubleClick(): (event: React.MouseEvent) => boolean {
	const lastClick = useRef(0);
	return (event) => {
		if (clickMode(event) !== "replace") {
			lastClick.current = 0;
			return false;
		}
		const double = lastClick.current > 0 && event.timeStamp - lastClick.current <= 400;
		lastClick.current = double ? 0 : event.timeStamp;
		return double;
	};
}
