import type { AgentStatsView } from "../../shared/agent-stats.ts";
import { useLocale } from "../locale.tsx";

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
	const { t } = useLocale();
	return (
		<div className="settings-form">
			<div className="settings-stat-hero">
				<span>{t.settings.hitRate}</span>
				<strong>{stats.promptTokens === 0 ? "—" : pct(stats.cacheHit)}</strong>
				<p>{t.settings.hitNote}</p>
			</div>
			<dl className="settings-stat-grid">
				<div>
					<dt>{t.settings.promptTokens}</dt>
					<dd>{count(stats.promptTokens)}</dd>
				</div>
				<div>
					<dt>{t.settings.cacheRead}</dt>
					<dd>{count(stats.cacheRead)}</dd>
				</div>
				<div>
					<dt>{t.settings.uncached}</dt>
					<dd>{count(stats.input)}</dd>
				</div>
				<div>
					<dt>{t.settings.cacheWrite}</dt>
					<dd>{count(stats.cacheWrite)}</dd>
				</div>
				<div>
					<dt>{t.settings.output}</dt>
					<dd>{count(stats.output)}</dd>
				</div>
				<div>
					<dt>{t.settings.turns}</dt>
					<dd>{count(stats.turns)}</dd>
				</div>
			</dl>
			<p className="settings-lead">{t.settings.statsNote}</p>
			<div className="settings-actions">
				<button type="button" onClick={onReset} disabled={resetting || stats.turns === 0}>
					{resetting ? t.settings.resetting : t.settings.reset}
				</button>
			</div>
		</div>
	);
}
