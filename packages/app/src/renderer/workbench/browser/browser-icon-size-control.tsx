import type { CSSProperties } from "react";
import { useLocale } from "../../locale.tsx";
import { BROWSER_ICON_SIZE } from "./use-browser-icon-size.ts";

export function BrowserIconSizeControl({ size, onSize }: { size: number; onSize: (size: number) => void }): React.JSX.Element {
	const { t } = useLocale();
	const { min, max, step } = BROWSER_ICON_SIZE;
	const style = { "--browser-size-fill": `${(size - min) / (max - min) * 100}%` } as CSSProperties;
	return (
		<div className="browser-icon-size" role="group" aria-label={t.browser.iconSize} style={style}>
			<button type="button" aria-label={t.browser.smallerIcons} data-tooltip={t.browser.smallerIcons} disabled={size <= min} onClick={() => onSize(size - step)}>
				<svg viewBox="0 0 16 16" width="13" height="13" aria-hidden="true">
					<path d="M3.5 8h9" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
				</svg>
			</button>
			<input
				type="range"
				aria-label={t.browser.iconSize}
				aria-valuetext={`${size}px`}
				min={min}
				max={max}
				step={step}
				value={size}
				onChange={(event) => onSize(Number(event.target.value))}
			/>
			<button type="button" aria-label={t.browser.largerIcons} data-tooltip={t.browser.largerIcons} disabled={size >= max} onClick={() => onSize(size + step)}>
				<svg viewBox="0 0 16 16" width="13" height="13" aria-hidden="true">
					<path d="M3.5 8h9M8 3.5v9" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
				</svg>
			</button>
		</div>
	);
}
