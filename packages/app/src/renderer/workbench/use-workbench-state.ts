import { useLayoutEffect, useMemo, useState, type SetStateAction } from "react";
import { readWorkspacePreference, writeWorkspacePreference } from "../library/workspace-storage.ts";
import { emptyAssetTabs, pruneTabs, type AssetTabs } from "./asset-tabs.ts";

type WorkbenchView = "library" | "table" | "graph";

interface WorkbenchState {
	workbenchView: WorkbenchView;
	tabs: AssetTabs;
}

const emptyWorkbench: WorkbenchState = { workbenchView: "library", tabs: emptyAssetTabs };

function readWorkbench(root: string | null): WorkbenchState {
	const value = root && readWorkspacePreference(root, "workbench");
	if (!value || typeof value !== "object") return emptyWorkbench;
	const saved = value as { workbenchView?: unknown; tabs?: Partial<Record<keyof AssetTabs, unknown>> };
	const workbenchView = saved.workbenchView === "table" || saved.workbenchView === "graph" ? saved.workbenchView : "library";
	const ids = readIds(saved.tabs?.ids);
	const active = typeof saved.tabs?.active === "string" && ids.includes(saved.tabs.active) ? saved.tabs.active : ids[0] ?? null;
	const previews = readIds(saved.tabs?.previews).filter((id) => ids.includes(id));
	return { workbenchView, tabs: { ids, active, previews } };
}

function readIds(value: unknown): string[] {
	if (!Array.isArray(value)) return [];
	return [...new Set(value.filter((id): id is string => typeof id === "string"))];
}

export function useWorkbenchState(root: string | null, assetIds: ReadonlySet<string>) {
	const [state, setState] = useState(() => ({ root, ...readWorkbench(root) }));
	const current = state.root === root ? state : emptyWorkbench;
	const tabs = useMemo(() => pruneTabs(current.tabs, (id) => assetIds.has(id)), [current.tabs, assetIds]);

	useLayoutEffect(() => {
		// A library reset includes its complete asset list. Load that library before saving any state.
		if (state.root !== root) {
			setState({ root, ...readWorkbench(root) });
			return;
		}
		if (tabs !== state.tabs) {
			setState({ ...state, tabs });
			return;
		}
		if (root) writeWorkspacePreference(root, "workbench", { workbenchView: state.workbenchView, tabs });
	}, [root, state, tabs]);

	return {
		workbenchView: current.workbenchView,
		tabs,
		setWorkbenchView: (workbenchView: WorkbenchView) => {
			setState((previous) => {
				if (previous.root !== root || previous.workbenchView === workbenchView) return previous;
				return { ...previous, workbenchView };
			});
		},
		setTabs: (update: SetStateAction<AssetTabs>) => {
			setState((previous) => {
				if (previous.root !== root) return previous;
				const next = typeof update === "function" ? update(previous.tabs) : update;
				return next === previous.tabs ? previous : { ...previous, tabs: next };
			});
		},
	};
}
