export function formatClock(seconds: number): string {
	const total = Math.max(0, Math.floor(Number.isFinite(seconds) ? seconds : 0));
	const hours = Math.floor(total / 3600);
	const minutes = Math.floor((total % 3600) / 60);
	const rest = String(total % 60).padStart(2, "0");
	if (hours > 0) return `${hours}:${String(minutes).padStart(2, "0")}:${rest}`;
	return `${minutes}:${rest}`;
}

export function PlayIcon(): React.JSX.Element {
	return <svg viewBox="2 2 12 12" width="15" height="15" aria-hidden="true">
		<path fill="currentColor" d="M5.2 3.3v9.4L12.6 8 5.2 3.3z" />
	</svg>;
}

export function PauseIcon(): React.JSX.Element {
	return <svg viewBox="2 2 12 12" width="15" height="15" aria-hidden="true">
		<path fill="currentColor" d="M4.2 3.2h2.4v9.6H4.2zM9.4 3.2h2.4v9.6H9.4z" />
	</svg>;
}

export function VolumeIcon(): React.JSX.Element {
	return <svg viewBox="2 2 12 12" width="15" height="15" aria-hidden="true">
		<path fill="currentColor" d="M3 6.2h2.1L8.2 3.5v9L5.1 9.8H3V6.2z" />
		<path fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" d="M10.2 6.1a2.7 2.7 0 0 1 0 3.8" />
	</svg>;
}

export function MutedIcon(): React.JSX.Element {
	return <svg viewBox="2 2 12 12" width="15" height="15" aria-hidden="true">
		<path fill="currentColor" d="M3 6.2h2.1L8.2 3.5v9L5.1 9.8H3V6.2z" />
		<path fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" d="m10.2 6.4 3.2 3.2M13.4 6.4l-3.2 3.2" />
	</svg>;
}
