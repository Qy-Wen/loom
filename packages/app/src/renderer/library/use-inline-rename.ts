import { useEffect, useRef, useState } from "react";

/**
 * Props for the text input of an in-place rename. Enter and blur commit, Escape cancels.
 * The typed text is reset to `initial` whenever the rename is not active, so a cancelled edit never comes back.
 */
export function useInlineRename(
	initial: string,
	renaming: boolean,
	onCommit: (value: string) => void | Promise<void>,
	onCancel: () => void,
): React.InputHTMLAttributes<HTMLInputElement> {
	const [value, setValue] = useState(initial);
	const cancelled = useRef(false);

	useEffect(() => {
		if (renaming) return;
		cancelled.current = false;
		setValue(initial);
	}, [initial, renaming]);

	return {
		autoFocus: true,
		value,
		onChange: (event) => setValue(event.target.value),
		onFocus: (event) => event.currentTarget.select(),
		onKeyDown: (event) => {
			if (event.key === "Enter") event.currentTarget.blur();
			if (event.key === "Escape") {
				cancelled.current = true;
				onCancel();
				event.currentTarget.blur();
			}
		},
		onBlur: () => {
			if (!cancelled.current) void onCommit(value);
		},
	};
}
