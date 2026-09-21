import { CopilotChat } from "@copilotkit/react-core/v2";
import type { Asset } from "@loom/core";
import { formatBytes } from "./asset-utils.ts";

export type SidePanelTab = "agent" | "details";

interface SidePanelProps {
	activeTab: SidePanelTab;
	asset: Asset | null;
	onChangeTab: (tab: SidePanelTab) => void;
}

export function SidePanel({ activeTab, asset, onChangeTab }: SidePanelProps): React.JSX.Element {
	return (
		<aside className="side-panel">
			<div className="panel-tabs">
				<button
					className={activeTab === "agent" ? "active" : ""}
					type="button"
					onClick={() => onChangeTab("agent")}
				>Agent</button>
				<button
					className={activeTab === "details" ? "active" : ""}
					type="button"
					onClick={() => onChangeTab("details")}
				>Details</button>
			</div>

			<div className={`panel-content agent-content ${activeTab === "agent" ? "active" : ""}`}>
				<CopilotChat />
			</div>

			<div className={`panel-content details-content ${activeTab === "details" ? "active" : ""}`}>
				<section>
					<div className="section-label">Properties</div>
					{asset ? (
						<dl className="properties">
							<dt>Type</dt><dd>{asset.type}</dd>
							<dt>Size</dt><dd>{formatBytes(asset.size)}</dd>
							<dt>Modified</dt><dd>{new Date(asset.modifiedAt).toLocaleString()}</dd>
							<dt>Asset ID</dt><dd title={asset.assetId}>{asset.assetId}</dd>
						</dl>
					) : (
						<div className="empty no-padding">Select an asset to see its properties.</div>
					)}
				</section>
				<section className="relations-section">
					<div className="section-label">Relations</div>
					<div className="empty no-padding">No relations yet.</div>
				</section>
			</div>
		</aside>
	);
}
