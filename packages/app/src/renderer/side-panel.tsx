import { CopilotChat } from "@copilotkit/react-core/v2";
import type {
	Asset,
	AssetEnrichment,
	AssetPropertyValue,
	PropertyDefinition,
	PropertyType,
	PropertyValue,
} from "@loom/core";
import { formatBytes } from "./asset-utils.ts";
import { EnrichmentDetails } from "./enrichment-details.tsx";
import { PropertyEditor } from "./property-editor.tsx";

export type SidePanelTab = "agent" | "details";

interface SidePanelProps {
	activeTab: SidePanelTab;
	asset: Asset | null;
	properties: PropertyDefinition[];
	propertyValues: AssetPropertyValue[];
	onChangeTab: (tab: SidePanelTab) => void;
	onCreateProperty: (name: string, type: PropertyType) => Promise<void>;
	onUpdateProperty: (propertyId: string, name: string, type: PropertyType) => Promise<void>;
	onRemoveProperty: (propertyId: string) => Promise<void>;
	onSetPropertyValue: (assetId: string, propertyId: string, value: PropertyValue) => Promise<void>;
	onRemovePropertyValue: (assetId: string, propertyId: string) => Promise<void>;
	enrichment: AssetEnrichment | undefined;
	analyzing: boolean;
	onAnalyze: () => void;
}

export function SidePanel({
	activeTab,
	asset,
	properties,
	propertyValues,
	onChangeTab,
	onCreateProperty,
	onUpdateProperty,
	onRemoveProperty,
	onSetPropertyValue,
	onRemovePropertyValue,
	enrichment,
	analyzing,
	onAnalyze,
}: SidePanelProps): React.JSX.Element {
	const selectedValues = asset
		? propertyValues.filter((value) => value.assetId === asset.assetId)
		: [];

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
					<div className="section-label">File</div>
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
				{asset && (
					<EnrichmentDetails
						enrichment={enrichment}
						analyzing={analyzing}
						onAnalyze={onAnalyze}
					/>
				)}
				{asset && (
					<section>
						<PropertyEditor
							asset={asset}
							properties={properties}
							values={selectedValues}
							onCreateProperty={onCreateProperty}
							onUpdateProperty={onUpdateProperty}
							onRemoveProperty={onRemoveProperty}
							onSetValue={(propertyId, value) =>
								onSetPropertyValue(asset.assetId, propertyId, value)}
							onRemoveValue={(propertyId) =>
								onRemovePropertyValue(asset.assetId, propertyId)}
						/>
					</section>
				)}
				<section className="relations-section">
					<div className="section-label">Relations</div>
					<div className="empty no-padding">No relations yet.</div>
				</section>
			</div>
		</aside>
	);
}
