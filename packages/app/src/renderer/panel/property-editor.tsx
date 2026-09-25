import { useEffect, useState } from "react";
import type {
	Asset,
	AssetPropertyValue,
	PropertyDefinition,
	PropertyType,
	PropertyValue,
} from "@loom/core";

interface PropertyEditorProps {
	asset: Asset;
	properties: PropertyDefinition[];
	values: AssetPropertyValue[];
	onCreateProperty: (name: string, type: PropertyType) => Promise<void>;
	onUpdateProperty: (propertyId: string, name: string, type: PropertyType) => Promise<void>;
	onRemoveProperty: (propertyId: string) => Promise<void>;
	onSetValue: (propertyId: string, value: PropertyValue) => Promise<void>;
	onRemoveValue: (propertyId: string) => Promise<void>;
}

export function PropertyEditor({
	asset,
	properties,
	values,
	onCreateProperty,
	onUpdateProperty,
	onRemoveProperty,
	onSetValue,
	onRemoveValue,
}: PropertyEditorProps): React.JSX.Element {
	const [form, setForm] = useState<{ propertyId?: string; name: string; type: PropertyType } | null>(null);
	const valuesByProperty = new Map(values.map((value) => [value.propertyId, value.value]));

	async function submitDefinition(): Promise<void> {
		if (!form?.name.trim()) return;
		if (form.propertyId) await onUpdateProperty(form.propertyId, form.name, form.type);
		else await onCreateProperty(form.name, form.type);
		setForm(null);
	}

	return (
		<div className="custom-properties">
			<div className="property-heading">
				<div className="section-label">Custom Properties</div>
				<button
					className="icon-button"
					type="button"
					title="Add property"
					onClick={() => setForm({ name: "", type: "text" })}
				>+</button>
			</div>

			{form && (
				<div className="property-definition-form">
					<input
						autoFocus
						placeholder="Property name"
						value={form.name}
						onChange={(event) => setForm({ ...form, name: event.target.value })}
					/>
					<select
						value={form.type}
						onChange={(event) => setForm({ ...form, type: event.target.value as PropertyType })}
					>
						<option value="text">Text</option>
						<option value="number">Number</option>
						<option value="boolean">Checkbox</option>
						<option value="date">Date</option>
					</select>
					<div className="property-form-actions">
						<button type="button" onClick={() => setForm(null)}>Cancel</button>
						<button
							type="button"
							disabled={!form.name.trim()}
							onClick={() => void submitDefinition().catch(() => undefined)}
						>Save</button>
					</div>
				</div>
			)}

			{properties.length === 0 && !form ? (
				<div className="empty no-padding">No custom properties yet.</div>
			) : (
				<div className="property-fields">
					{properties.map((property) => (
						<div className="property-field" key={property.propertyId}>
							<div className="property-field-header">
								<span title={property.type}>{property.name}</span>
								<div>
									<button
										className="text-button"
										type="button"
										onClick={() => setForm({
											propertyId: property.propertyId,
											name: property.name,
											type: property.type,
										})}
									>Edit</button>
									<button
										className="text-button danger"
										type="button"
										onClick={() => {
											if (window.confirm(`Delete property “${property.name}” and all its values?`)) {
												void onRemoveProperty(property.propertyId).catch(() => undefined);
											}
										}}
									>Delete</button>
								</div>
							</div>
							<PropertyValueInput
								key={`${asset.assetId}:${property.propertyId}`}
								property={property}
								value={valuesByProperty.get(property.propertyId)}
								onSet={(value) => onSetValue(property.propertyId, value)}
								onRemove={() => onRemoveValue(property.propertyId)}
							/>
						</div>
					))}
				</div>
			)}
		</div>
	);
}

interface PropertyValueInputProps {
	property: PropertyDefinition;
	value: PropertyValue | undefined;
	onSet: (value: PropertyValue) => Promise<void>;
	onRemove: () => Promise<void>;
}

function PropertyValueInput({ property, value, onSet, onRemove }: PropertyValueInputProps): React.JSX.Element {
	const [draft, setDraft] = useState(value === undefined ? "" : String(value));
	useEffect(() => setDraft(value === undefined ? "" : String(value)), [value]);

	if (property.type === "boolean") {
		return (
			<div className="property-value boolean-value">
				<label>
					<input
						type="checkbox"
						checked={value === true}
						onChange={(event) => void onSet(event.target.checked).catch(() => undefined)}
					/>
					{value === undefined ? "Not set" : value ? "Yes" : "No"}
				</label>
				{value !== undefined && <button type="button" onClick={() => void onRemove().catch(() => undefined)}>Clear</button>}
			</div>
		);
	}

	async function commit(): Promise<void> {
		const trimmed = draft.trim();
		if (!trimmed) {
			if (value !== undefined) await onRemove();
			return;
		}
		const nextValue: PropertyValue = property.type === "number" ? Number(trimmed) : draft;
		await onSet(nextValue);
	}

	return (
		<div className="property-value">
			<input
				type={property.type === "number" ? "number" : property.type === "date" ? "date" : "text"}
				value={draft}
				placeholder="Not set"
				onChange={(event) => setDraft(event.target.value)}
				onBlur={() => void commit().catch(() => undefined)}
				onKeyDown={(event) => {
					if (event.key === "Enter") event.currentTarget.blur();
				}}
			/>
			{value !== undefined && <button type="button" onClick={() => void onRemove().catch(() => undefined)}>Clear</button>}
		</div>
	);
}
