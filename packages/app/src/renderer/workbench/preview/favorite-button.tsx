import type { MouseEventHandler } from "react";
import { useLocale } from "../../locale.tsx";

export function FavoriteButton({ favorite, onToggle, onMouseDown }: {
	favorite: boolean;
	onToggle: () => void;
	onMouseDown?: MouseEventHandler<HTMLButtonElement>;
}): React.JSX.Element {
	const { t } = useLocale();
	const label = favorite ? t.menu.removeFromFavorites : t.menu.addToFavorites;
	return (
		<button type="button" className="preview-favorite-button" data-tooltip={label} aria-label={label}
			aria-pressed={favorite} onMouseDown={onMouseDown} onClick={onToggle}>
			<svg viewBox="0 0 16 16" width="15" height="15" aria-hidden="true">
				<path fill={favorite ? "currentColor" : "none"} stroke="currentColor" strokeWidth="1.2" strokeLinejoin="round"
					d="M8 1.7 9.8 5.6l4.3.4-3.3 2.8.1 4.3L8 11.2 5.1 13.1l.1-4.3L1.9 6l4.3-.4L8 1.7z" />
			</svg>
		</button>
	);
}
