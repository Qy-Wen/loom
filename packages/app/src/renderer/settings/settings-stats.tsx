import type { AgentStatsView } from "../../shared/agent-stats.ts";

function pct(value: number): string {
	return `${(value * 100).toFixed(1)}%`;
}

function count(value: number): string {
	return value.toLocaleString();
}

interface SettingsStatsProps {
	stats: AgentStatsView;
	resetting: boolean;
	onReset: () => void;
}

export function SettingsStats({ stats, resetting, onReset }: SettingsStatsProps): React.JSX.Element {
	return (
		<div className="settings-form">
			<div className="settings-stat-hero">
				<span>Prompt-cache hit rate</span>
				<strong>{stats.promptTokens === 0 ? "—" : pct(stats.cacheHit)}</strong>
				<p>cacheRead / (input + cacheRead + cacheWrite) from Chat usage, same as the eval.</p>
			</div>
			<dl className="settings-stat-grid">
				<div>
					<dt>Prompt tokens</dt>
					<dd>{count(stats.promptTokens)}</dd>
				</div>
				<div>
					<dt>Cache read</dt>
					<dd>{count(stats.cacheRead)}</dd>
				</div>
				<div>
					<dt>Uncached input</dt>
					<dd>{count(stats.input)}</dd>
				</div>
				<div>
					<dt>Cache write</dt>
					<dd>{count(stats.cacheWrite)}</dd>
				</div>
				<div>
					<dt>Output</dt>
					<dd>{count(stats.output)}</dd>
				</div>
				<div>
					<dt>Usage turns</dt>
					<dd>{count(stats.turns)}</dd>
				</div>
			</dl>
			<p className="settings-lead">
				These are the same totals pi keeps on SessionStats.usage. Loom does not price tokens, so cost is omitted. Reasoning tokens are not reported by the current Chat slot.
			</p>
			<div className="settings-actions">
				<button type="button" onClick={onReset} disabled={resetting || stats.turns === 0}>
					{resetting ? "Resetting…" : "Reset stats"}
				</button>
			</div>
		</div>
	);
}
