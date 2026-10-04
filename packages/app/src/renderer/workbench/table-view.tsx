import { type PointerEvent as ReactPointerEvent, useEffect, useMemo, useState } from "react";
import type {
	Asset,
	AssetPropertyValue,
	PropertyDefinition,
	PropertyType,
	PropertyValue,
} from "@loom/core";
import { endLibraryDrag, writeLibraryDrag } from "../assets/asset-drag.ts";
import { formatBytes } from "../assets/asset-utils.ts";
import { comparePropertyValues, displayPropertyValue } from "./table-values.ts";

type SortKey = "filename" | "type" | "size" | "modifiedAt" | `property:${string}`;
type SortDirection = "asc" | "desc";

const DEFAULT_COLUMN_WIDTHS: Record<string, number> = {
	filename: 220,
	type: 90,
	size: 100,
	modifiedAt: 120,
};
const DEFAULT_PROPERTY_WIDTH = 140;
const MIN_COLUMN_WIDTH = 72;
const MAX_COLUMN_WIDTH = 480;

interface TableViewProps {
	assets: Asset[];
	properties: PropertyDefinition[];
	propertyValues: AssetPropertyValue[];
	selectedAssetId: string | null;
	canEditProperties: boolean;
	onSelectAsset: (assetId: string) => void;
	onCreateProperty: (name: string, type: PropertyType) => Promise<void>;
}

export function TableView({
	assets,
	properties,
	propertyValues,
	selectedAssetId,
	canEditProperties,
	onSelectAsset,
	onCreateProperty,
}: TableViewProps): React.JSX.Element {
	const [query, setQuery] = useState("");
	const [addingProperty, setAddingProperty] = useState(false);
	const [propertyName, setPropertyName] = useState("");
	const [propertyType, setPropertyType] = useState<PropertyType>("text");
	const [columnWidths, setColumnWidths] = useState<Record<string, number>>(() => {
		try {
			const stored = JSON.parse(localStorage.getItem("loom.table.columnWidths") ?? "{}");
			return stored && typeof stored === "object" ? stored : {};
		} catch {
			return {};
		}
	});
	const [sortKey, setSortKey] = useState<SortKey>("filename");
	const [sortDirection, setSortDirection] = useState<SortDirection>("asc");
	useEffect(() => {
		localStorage.setItem("loom.table.columnWidths", JSON.stringify(columnWidths));
	}, [columnWidths]);

	const values = useMemo(
		() => new Map(propertyValues.map((value) => [`${value.assetId}:${value.propertyId}`, value.value])),
		[propertyValues],
	);
	const columns = useMemo<SortKey[]>(
		() => ["filename", "type", "size", "modifiedAt", ...properties.map((property) => `property:${property.propertyId}` as const)],
		[properties],
	);
	const tableWidth = columns.reduce((total, column) => total + columnWidth(column), 0);

	const rows = useMemo(() => {
		const normalizedQuery = query.trim().toLowerCase();
		const filtered = normalizedQuery
			? assets.filter((asset) => {
				const searchable = [asset.filename, asset.relativePath, asset.type];
				for (const property of properties) {
					const value = values.get(`${asset.assetId}:${property.propertyId}`);
					if (value !== undefined) searchable.push(String(value));
				}
				return searchable.some((value) => value.toLowerCase().includes(normalizedQuery));
			})
			: [...assets];

		return filtered.sort((left, right) => {
			const leftValue = sortValue(left, sortKey, values);
			const rightValue = sortValue(right, sortKey, values);
			if (leftValue === undefined && rightValue === undefined) return left.filename.localeCompare(right.filename);
			if (leftValue === undefined) return 1;
			if (rightValue === undefined) return -1;
			const comparison = comparePropertyValues(leftValue, rightValue);
			return sortDirection === "asc" ? comparison : -comparison;
		});
	}, [assets, properties, query, sortDirection, sortKey, values]);

	function changeSort(nextKey: SortKey): void {
		if (sortKey === nextKey) setSortDirection((current) => current === "asc" ? "desc" : "asc");
		else {
			setSortKey(nextKey);
			setSortDirection("asc");
		}
	}

	function columnWidth(column: SortKey): number {
		const stored = columnWidths[column];
		if (Number.isFinite(stored)) return Math.min(MAX_COLUMN_WIDTH, Math.max(MIN_COLUMN_WIDTH, stored));
		return DEFAULT_COLUMN_WIDTHS[column] ?? DEFAULT_PROPERTY_WIDTH;
	}

	function beginColumnResize(column: SortKey, event: ReactPointerEvent<HTMLSpanElement>): void {
		event.preventDefault();
		event.stopPropagation();
		const startX = event.clientX;
		const startWidth = columnWidth(column);
		document.body.classList.add("resizing-table-columns");

		const onPointerMove = (moveEvent: PointerEvent) => {
			const width = Math.min(MAX_COLUMN_WIDTH, Math.max(MIN_COLUMN_WIDTH, startWidth + moveEvent.clientX - startX));
			setColumnWidths((current) => ({ ...current, [column]: width }));
		};
		const onPointerUp = () => {
			document.body.classList.remove("resizing-table-columns");
			window.removeEventListener("pointermove", onPointerMove);
			window.removeEventListener("pointerup", onPointerUp);
		};
		window.addEventListener("pointermove", onPointerMove);
		window.addEventListener("pointerup", onPointerUp);
	}

	function resetColumnWidth(column: SortKey): void {
		setColumnWidths((current) => {
			const next = { ...current };
			delete next[column];
			return next;
		});
	}

	async function addProperty(): Promise<void> {
		if (!propertyName.trim()) return;
		await onCreateProperty(propertyName, propertyType);
		setPropertyName("");
		setPropertyType("text");
		setAddingProperty(false);
	}

	return (
		<div className="table-view">
			<div className="table-toolbar">
				<input
					type="search"
					placeholder="Filter assets and properties…"
					value={query}
					onChange={(event) => setQuery(event.target.value)}
				/>
				<div className="table-toolbar-actions">
					<span>{rows.length} assets</span>
					<button
						type="button"
						disabled={!canEditProperties}
						onClick={() => setAddingProperty((current) => !current)}
					>+ Add field</button>
				</div>
			</div>
			{addingProperty && (
				<div className="table-property-form">
					<input
						autoFocus
						placeholder="Field name"
						value={propertyName}
						onChange={(event) => setPropertyName(event.target.value)}
						onKeyDown={(event) => {
							if (event.key === "Enter") void addProperty().catch(() => undefined);
							if (event.key === "Escape") setAddingProperty(false);
						}}
					/>
					<select value={propertyType} onChange={(event) => setPropertyType(event.target.value as PropertyType)}>
						<option value="text">Text</option>
						<option value="number">Number</option>
						<option value="boolean">Checkbox</option>
						<option value="date">Date</option>
					</select>
					<button type="button" onClick={() => setAddingProperty(false)}>Cancel</button>
					<button
						type="button"
						disabled={!propertyName.trim()}
						onClick={() => void addProperty().catch(() => undefined)}
					>Add</button>
				</div>
			)}
			<div className="asset-table-scroll">
				<table className="asset-table" style={{ width: tableWidth }}>
					<colgroup>
						{columns.map((column) => <col key={column} style={{ width: columnWidth(column) }} />)}
					</colgroup>
					<thead>
						<tr>
							<SortableHeader label="Name" column="filename" active={sortKey} direction={sortDirection} onSort={changeSort} onResize={beginColumnResize} onResetWidth={resetColumnWidth} />
							<SortableHeader label="Type" column="type" active={sortKey} direction={sortDirection} onSort={changeSort} onResize={beginColumnResize} onResetWidth={resetColumnWidth} />
							<SortableHeader label="Size" column="size" active={sortKey} direction={sortDirection} onSort={changeSort} onResize={beginColumnResize} onResetWidth={resetColumnWidth} />
							<SortableHeader label="Modified" column="modifiedAt" active={sortKey} direction={sortDirection} onSort={changeSort} onResize={beginColumnResize} onResetWidth={resetColumnWidth} />
							{properties.map((property) => (
								<SortableHeader
									key={property.propertyId}
									label={property.name}
									column={`property:${property.propertyId}`}
									active={sortKey}
									direction={sortDirection}
									onSort={changeSort}
									onResize={beginColumnResize}
									onResetWidth={resetColumnWidth}
								/>
							))}
						</tr>
					</thead>
					<tbody>
						{rows.map((asset) => (
							<tr
								className={asset.assetId === selectedAssetId ? "selected" : ""}
								key={asset.assetId}
								draggable
								onDragStart={(event) => {
									writeLibraryDrag(event.dataTransfer, { kind: "asset", assetId: asset.assetId, path: asset.relativePath }, asset);
								}}
								onDragEnd={() => {
									endLibraryDrag();
								}}
								onClick={() => onSelectAsset(asset.assetId)}
							>
								<td title={asset.relativePath}>
									<strong>{asset.filename}</strong>
									<small>{asset.relativePath}</small>
								</td>
								<td>{asset.type}</td>
								<td>{formatBytes(asset.size)}</td>
								<td>{new Date(asset.modifiedAt).toLocaleDateString()}</td>
								{properties.map((property) => (
									<td key={property.propertyId}>
										{displayPropertyValue(
											values.get(`${asset.assetId}:${property.propertyId}`),
											property.type,
										)}
									</td>
								))}
							</tr>
						))}
					</tbody>
				</table>
				{rows.length === 0 && <div className="table-empty">No matching assets.</div>}
			</div>
		</div>
	);
}

interface SortableHeaderProps {
	label: string;
	column: SortKey;
	active: SortKey;
	direction: SortDirection;
	onSort: (column: SortKey) => void;
	onResize: (column: SortKey, event: ReactPointerEvent<HTMLSpanElement>) => void;
	onResetWidth: (column: SortKey) => void;
}

function SortableHeader({
	label,
	column,
	active,
	direction,
	onSort,
	onResize,
	onResetWidth,
}: SortableHeaderProps): React.JSX.Element {
	return (
		<th>
			<button type="button" onClick={() => onSort(column)}>
				{label}{active === column ? (direction === "asc" ? " ↑" : " ↓") : ""}
			</button>
			<span
				className="column-resize-handle"
				role="separator"
				aria-label={`Resize ${label} column`}
				aria-orientation="vertical"
				onPointerDown={(event) => onResize(column, event)}
				onDoubleClick={(event) => {
					event.stopPropagation();
					onResetWidth(column);
				}}
			/>
		</th>
	);
}

function sortValue(
	asset: Asset,
	key: SortKey,
	values: Map<string, PropertyValue>,
): PropertyValue | undefined {
	if (key === "filename") return asset.filename;
	if (key === "type") return asset.type;
	if (key === "size") return asset.size;
	if (key === "modifiedAt") return asset.modifiedAt;
	return values.get(`${asset.assetId}:${key.slice("property:".length)}`);
}
