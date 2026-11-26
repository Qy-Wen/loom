import { useEffect, useState } from "react";
import type { AgentStatsView } from "../../shared/agent-stats.ts";
import { useTraceLocale } from "./trace-locale.tsx";

function pct(value: number): string {
	return `${(value * 100).toFixed(1)}%`;
}

function count(value: number): string {
	return value.toLocaleString();
}

export function StatsView(): React.JSX.Element {
	const { t } = useTraceLocale();
	const copy = t.stats;
	const [stats, setStats] = useState<AgentStatsView | null>(null);
	const [error, setError] = useState("");
	const [resetting, setResetting] = useState(false);

	useEffect(() => {
		let active = true;
		void window.loomDev.getAgentStats().then((view) => {
			if (active) setStats(view);
		}).catch(() => {
			if (active) setError(copy.unavailable);
		});
		return () => { active = false; };
	}, [copy.unavailable]);

	async function reset(): Promise<void> {
		setResetting(true);
		try {
			setStats(await window.loomDev.resetAgentStats());
			setError("");
		} catch {
			setError(copy.unavailable);
		} finally {
			setResetting(false);
		}
	}

	return (
		<div className="trace-stats" role="tabpanel" id="stats-panel" aria-labelledby="stats-tab">
			{error ? <p className="trace-metrics-error" role="status">{error}</p> : null}
			{stats === null ? <p className="trace-empty">{copy.loading}</p> : (
				<div className="trace-stats-body">
					<p className="trace-stats-note">{copy.note}</p>
					<div className="trace-stat-hero">
						<span>{copy.hitRate}</span>
						<strong>{stats.promptTokens === 0 ? "—" : pct(stats.cacheHit)}</strong>
						<p>{copy.hitNote}</p>
					</div>
					<dl className="trace-stat-grid">
						<div><dt>{copy.promptTokens}</dt><dd>{count(stats.promptTokens)}</dd></div>
						<div><dt>{copy.cacheRead}</dt><dd>{count(stats.cacheRead)}</dd></div>
						<div><dt>{copy.uncached}</dt><dd>{count(stats.input)}</dd></div>
						<div><dt>{copy.cacheWrite}</dt><dd>{count(stats.cacheWrite)}</dd></div>
						<div><dt>{copy.output}</dt><dd>{count(stats.output)}</dd></div>
						<div><dt>{copy.turns}</dt><dd>{count(stats.turns)}</dd></div>
					</dl>
					<div className="trace-stats-footer">
						<button type="button" onClick={() => { void reset(); }} disabled={resetting || stats.turns === 0}>
							{resetting ? copy.resetting : copy.reset}
						</button>
					</div>
				</div>
			)}
		</div>
	);
}
