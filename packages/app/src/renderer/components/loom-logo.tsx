type LoomLogoProps = { size?: number; className?: string };

type Bar = readonly [x: number, y: number, w: number, h: number];

/** Two threads each way, woven: each one runs over one crossing and under the other. */
const BLUE: readonly Bar[] = [
	// Left vertical: under the top horizontal, over the orange one.
	[4.2, 1, 2.6, 2], [4.2, 8, 2.6, 11],
	// Right vertical: over the top horizontal, under the orange one.
	[13.2, 1, 2.6, 11], [13.2, 17, 2.6, 2],
	// Top horizontal: over the left vertical, under the right one.
	[1, 4.2, 11, 2.6], [17, 4.2, 2, 2.6],
];
const ORANGE: readonly Bar[] = [[1, 13.2, 2, 2.6], [8, 13.2, 11, 2.6]];

/** The app icon (`resources/icon.png`), reduced to a small weave for the sidebar. */
export function LoomLogo({ size = 16, className }: LoomLogoProps): React.JSX.Element {
	const rects = (bars: readonly Bar[]) => bars.map(([x, y, w, h]) => <rect key={`${x}-${y}`} x={x} y={y} width={w} height={h} rx="0.8" />);
	return (
		<svg className={className} viewBox="0 0 20 20" width={size} height={size} aria-hidden="true">
			<g fill="var(--lm-accent)">{rects(BLUE)}</g>
			<g fill="#c0775a">{rects(ORANGE)}</g>
		</svg>
	);
}
