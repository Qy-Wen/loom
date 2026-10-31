import { useEffect, useState } from "react";

/** State kept in localStorage. A stored value outside `allowed` falls back to `fallback`. */
export function useStoredState<T extends string>(key: string, allowed: readonly T[], fallback: T): [T, (value: T) => void] {
	const [value, setValue] = useState<T>(() => {
		const stored = localStorage.getItem(key);
		return allowed.find((item) => item === stored) ?? fallback;
	});
	useEffect(() => {
		localStorage.setItem(key, value);
	}, [key, value]);
	return [value, setValue];
}
