import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import {
	AGENT_PERMISSION_OPTIONS,
	DEFAULT_AGENT_PERMISSION,
	parseAgentPermissionLevel,
	type AgentPermissionLevel,
} from "@loom/agent/tool-permission";
import { useLocale } from "../locale.tsx";

const AgentPermissionContext = createContext<{
	level: AgentPermissionLevel;
	setLevel: (level: AgentPermissionLevel) => void;
}>({
	level: DEFAULT_AGENT_PERMISSION,
	setLevel: () => undefined,
});

export function AgentPermissionProvider({ children }: { children: ReactNode }): React.JSX.Element {
	const [level, setLevelState] = useState<AgentPermissionLevel>(DEFAULT_AGENT_PERMISSION);

	useEffect(() => {
		void window.loom.getAgentPermission().then(setLevelState);
	}, []);

	return (
		<AgentPermissionContext.Provider
			value={{
				level,
				setLevel: (next) => {
					setLevelState(next);
					void window.loom.setAgentPermission(next).then(setLevelState);
				},
			}}
		>
			{children}
		</AgentPermissionContext.Provider>
	);
}

export function useAgentPermission(): {
	level: AgentPermissionLevel;
	setLevel: (level: AgentPermissionLevel) => void;
} {
	return useContext(AgentPermissionContext);
}

export function AgentPermissionSelect(): React.JSX.Element {
	const { level, setLevel } = useAgentPermission();
	const { t } = useLocale();
	const labels = { basic: t.permission.basic, standard: t.permission.standard, full: t.permission.full };
	return (
		<label className="session-permission">
			<select
				aria-label={t.permission.label}
				value={level}
				onChange={(event) => {
					setLevel(parseAgentPermissionLevel(event.target.value));
					event.currentTarget.dataset.hold = "true";
					event.currentTarget.blur();
				}}
				onPointerMove={(event) => {
					delete event.currentTarget.dataset.hold;
				}}
			>
				{AGENT_PERMISSION_OPTIONS.map((option) => (
					<option key={option.value} value={option.value}>{labels[option.value]}</option>
				))}
			</select>
		</label>
	);
}
