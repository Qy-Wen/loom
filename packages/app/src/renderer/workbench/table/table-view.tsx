import { type PointerEvent as ReactPointerEvent, useEffect, useMemo, useState } from "react";
import type {
	Asset,
	AssetPropertyValue,
	PropertyDefinition,
	PropertyType,
	PropertyValue,
} from "@loom/core";
import { endLibraryDrag, writeLibraryDrag } from "../../assets/asset-drag.ts";
import { formatBytes } from "../../assets/asset-utils.ts";
import { assetTypeLabel } from "../../../shared/locale.ts";
import { useLocale } from "../../locale.tsx";
import { comparePropertyValues, displayPropertyValue } from "./table-values.ts";
import { useConfirmation } from "../../components/confirm-dialog.tsx";

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
	onUpdateProperty: (propertyId: string, name: string, type: PropertyType) => Promise<void>;
	onRemoveProperty: (propertyId: string) => Promise<void>;
	onSetPropertyValue: (assetId: string, propertyId: string, value: PropertyValue) => Promise<void>;
	onRemovePropertyValue: (assetId: string, propertyId: string) => Promise<void>;
}

export function TableView({
	assets,
	properties,
	propertyValues,
	selectedAssetId,
	canEditProperties,
	onSelectAsset,
	onCreateProperty,
	onUpdateProperty,
	onRemoveProperty,
	onSetPropertyValue,
	onRemovePropertyValue,
}: TableViewProps): React.JSX.Element {
	const { t } = useLocale();
	const { confirm } = useConfirmation();
	const [query, setQuery] = useState("");
	const [fieldForm, setFieldForm] = useState<FieldForm | null>(null);
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
				const searchable = [asset.filename, asset.relativePath, asset.type, assetTypeLabel(t, asset.type)];
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
	}, [assets, properties, query, sortDirection, sortKey, t, values]);

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

	async function saveField(): Promise<void> {
		if (!fieldForm?.name.trim()) return;
		if (fieldForm.mode === "create") await onCreateProperty(fieldForm.name, fieldForm.type);
		else if (fieldForm.propertyId) await onUpdateProperty(fieldForm.propertyId, fieldForm.name, fieldForm.type);
		setFieldForm(null);
	}

	async function deleteField(): Promise<void> {
		if (fieldForm?.mode !== "edit") return;
		const property = properties.find((item) => item.propertyId === fieldForm.propertyId);
		if (!property) return;
		if (!await confirm({
			title: t.table.deleteProperty(property.name),
			description: t.table.deletePropertyBody,
			confirmLabel: t.table.deletePropertyAction,
			tone: "danger",
		})) return;
		await onRemoveProperty(property.propertyId);
		setFieldForm(null);
	}

	return (
		<div className="table-view">
			<div className="table-toolbar">
				<input
					type="search"
					placeholder={t.table.filter}
					value={query}
					onChange={(event) => setQuery(event.target.value)}
				/>
				<div className="table-toolbar-actions">
					<span>{t.table.assets(rows.length)}</span>
					<button
						type="button"
						disabled={!canEditProperties}
						onClick={() => setFieldForm({ mode: "create", name: "", type: "text" })}
					>{t.table.addField}</button>
				</div>
			</div>
			{fieldForm && (
				<div className="table-property-form">
					<input
						autoFocus
						placeholder={t.table.fieldName}
						value={fieldForm.name}
						onChange={(event) => setFieldForm({ ...fieldForm, name: event.target.value })}
						onKeyDown={(event) => {
							if (event.key === "Enter") void saveField().catch(() => undefined);
							if (event.key === "Escape") setFieldForm(null);
						}}
					/>
					<select
						value={fieldForm.type}
						onChange={(event) => setFieldForm({ ...fieldForm, type: event.target.value as PropertyType })}
					>
						<option value="text">{t.table.text}</option>
						<option value="number">{t.table.number}</option>
						<option value="boolean">{t.table.checkbox}</option>
						<option value="date">{t.table.date}</option>
					</select>
					<button type="button" onClick={() => setFieldForm(null)}>{t.common.cancel}</button>
					<button
						type="button"
						disabled={!fieldForm.name.trim()}
						onClick={() => void saveField().catch(() => undefined)}
					>{fieldForm.mode === "create" ? t.common.add : t.common.save}</button>
					{fieldForm.mode === "edit" && (
						<button type="button" className="danger" onClick={() => void deleteField().catch(() => undefined)}>{t.common.delete}</button>
					)}
				</div>
			)}
			<div className="asset-table-scroll thin-scroll">
				<table className="asset-table" style={{ width: tableWidth }}>
					<colgroup>
						{columns.map((column) => <col key={column} style={{ width: columnWidth(column) }} />)}
					</colgroup>
					<thead>
						<tr>
							<SortableHeader label={t.table.name} column="filename" active={sortKey} direction={sortDirection} onSort={changeSort} onResize={beginColumnResize} onResetWidth={resetColumnWidth} />
							<SortableHeader label={t.table.type} column="type" active={sortKey} direction={sortDirection} onSort={changeSort} onResize={beginColumnResize} onResetWidth={resetColumnWidth} />
							<SortableHeader label={t.table.size} column="size" active={sortKey} direction={sortDirection} onSort={changeSort} onResize={beginColumnResize} onResetWidth={resetColumnWidth} />
							<SortableHeader label={t.table.modified} column="modifiedAt" active={sortKey} direction={sortDirection} onSort={changeSort} onResize={beginColumnResize} onResetWidth={resetColumnWidth} />
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
									onEdit={canEditProperties ? () => setFieldForm({
										mode: "edit",
										propertyId: property.propertyId,
										name: property.name,
										type: property.type,
									}) : undefined}
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
								<td>{assetTypeLabel(t, asset.type)}</td>
								<td>{formatBytes(asset.size)}</td>
								<td>{new Date(asset.modifiedAt).toLocaleDateString()}</td>
								{properties.map((property) => (
									<PropertyCell
										key={property.propertyId}
										property={property}
										value={values.get(`${asset.assetId}:${property.propertyId}`)}
										disabled={!canEditProperties}
										onSet={(value) => onSetPropertyValue(asset.assetId, property.propertyId, value)}
										onClear={() => onRemovePropertyValue(asset.assetId, property.propertyId)}
									/>
								))}
							</tr>
						))}
					</tbody>
				</table>
				{rows.length === 0 && <div className="table-empty">{t.table.noMatches}</div>}
			</div>
		</div>
	);
}

type FieldForm = {
	mode: "create" | "edit";
	propertyId?: string;
	name: string;
	type: PropertyType;
};

interface SortableHeaderProps {
	label: string;
	column: SortKey;
	active: SortKey;
	direction: SortDirection;
	onSort: (column: SortKey) => void;
	onResize: (column: SortKey, event: ReactPointerEvent<HTMLSpanElement>) => void;
	onResetWidth: (column: SortKey) => void;
	onEdit?: () => void;
}

function SortableHeader({
	label,
	column,
	active,
	direction,
	onSort,
	onResize,
	onResetWidth,
	onEdit,
}: SortableHeaderProps): React.JSX.Element {
	const { t } = useLocale();
	return (
		<th>
			<div className="table-head">
				<button type="button" onClick={() => onSort(column)}>
					{label}{active === column ? (direction === "asc" ? " ↑" : " ↓") : ""}
				</button>
				{onEdit && (
					<button type="button" className="text-button" onClick={onEdit}>{t.common.edit}</button>
				)}
			</div>
			<span
				className="column-resize-handle"
				role="separator"
				aria-label={t.table.resizeColumn(label)}
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

function PropertyCell({
	property,
	value,
	disabled,
	onSet,
	onClear,
}: {
	property: PropertyDefinition;
	value: PropertyValue | undefined;
	disabled: boolean;
	onSet: (value: PropertyValue) => Promise<void>;
	onClear: () => Promise<void>;
}): React.JSX.Element {
	const { t } = useLocale();
	const [draft, setDraft] = useState(value === undefined ? "" : String(value));
	useEffect(() => setDraft(value === undefined ? "" : String(value)), [value]);

	function stopRow(event: { stopPropagation: () => void }): void {
		event.stopPropagation();
	}

	if (disabled) {
		return <td>{displayPropertyValue(value, property.type)}</td>;
	}

	if (property.type === "boolean") {
		return (
			<td className="property-cell" onClick={stopRow} onDragStart={stopRow}>
				<label className="property-boolean">
					<input
						type="checkbox"
						checked={value === true}
						aria-label={property.name}
						onChange={(event) => {
							void onSet(event.target.checked).catch(() => undefined);
						}}
					/>
					{value === undefined ? "—" : value ? t.common.yes : t.common.no}
				</label>
				{value !== undefined && (
					<button type="button" className="text-button" aria-label={t.table.clearValue(property.name)} onClick={() => void onClear().catch(() => undefined)}>×</button>
				)}
			</td>
		);
	}

	async function commit(): Promise<void> {
		const trimmed = draft.trim();
		if (!trimmed) {
			if (value !== undefined) await onClear();
			return;
		}
		if (property.type === "number") {
			const next = Number(trimmed);
			if (!Number.isFinite(next)) {
				setDraft(value === undefined ? "" : String(value));
				return;
			}
			if (next !== value) await onSet(next);
			return;
		}
		if (draft !== value) await onSet(property.type === "date" ? trimmed : draft);
	}

	return (
		<td className="property-cell" onClick={stopRow} onDragStart={stopRow}>
			<input
				type={property.type === "number" ? "number" : property.type === "date" ? "date" : "text"}
				value={draft}
				aria-label={property.name}
				placeholder="—"
				onChange={(event) => setDraft(event.target.value)}
				onBlur={() => void commit().catch(() => undefined)}
				onKeyDown={(event) => {
					if (event.key === "Enter") event.currentTarget.blur();
				}}
			/>
		</td>
	);
}
