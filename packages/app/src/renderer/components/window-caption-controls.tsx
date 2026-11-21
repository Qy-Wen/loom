import { useEffect, useState } from "react";
import { useLocale } from "../locale.tsx";

export function WindowCaptionControls(): React.JSX.Element {
	const { t } = useLocale();
	const [maximized, setMaximized] = useState(false);
	useEffect(() => {
		let needsInitialState = true;
		const unsubscribe = window.loom.onMaximizedChanged((value) => {
			needsInitialState = false;
			setMaximized(value);
		});
		void window.loom.isMaximized().then((value) => {
			if (needsInitialState) setMaximized(value);
		});
		return () => {
			needsInitialState = false;
			unsubscribe();
		};
	}, []);

	const maximizeLabel = maximized ? t.app.restoreWindow : t.app.maximizeWindow;
	return (
		<div className="window-caption-controls">
			<button type="button" aria-label={t.app.minimizeWindow} data-tooltip={t.app.minimizeWindow}
				onClick={() => window.loom.windowAction("minimize")}>
				<svg viewBox="0 0 12 12" aria-hidden="true"><path d="M2 6h8" /></svg>
			</button>
			<button type="button" aria-label={maximizeLabel} data-tooltip={maximizeLabel}
				onClick={() => window.loom.windowAction("toggleMaximize")}>
				<svg viewBox="0 0 12 12" aria-hidden="true">
					{maximized ? <path d="M1.5 4.5h6v6h-6z M4.5 2.5v-1h6v6h-1" /> : <rect x="2" y="2" width="8" height="8" />}
				</svg>
			</button>
			<button className="window-caption-close" type="button" aria-label={t.app.closeWindow} data-tooltip={t.app.closeWindow}
				onClick={() => window.loom.windowAction("close")}>
				<svg viewBox="0 0 12 12" aria-hidden="true"><path d="m2.5 2.5 7 7m0-7-7 7" /></svg>
			</button>
		</div>
	);
}
