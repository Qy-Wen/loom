import type { LocalCore, PropertyType, PropertyValue } from "@loom/core";
import type { LoomTool, LoomToolResult } from "@loom/agent";

const PROPERTY_TYPES = ["text", "number", "boolean", "date"] as const;

/**
 * Agent-facing table tools. Columns are library properties; cells are values on an asset.
 */
export function createPropertyTools(core: LocalCore): LoomTool[] {
	return [
		{
			name: "list_properties",
			description:
				"List the table columns in the open library. " +
				"Each item has propertyId, name, and type. Copy propertyId into the other property tools.",
			parameters: objectSchema({}, []),
			execute: async () => {
				const properties = await core.getPropertySnapshot();
				return jsonResult(properties.properties.map(({ propertyId, name, type }) => ({ propertyId, name, type })));
			},
		},
		{
			name: "create_property",
			description:
				"Add one table column. name is unique in the library, ignoring case. " +
				"type is text, number, boolean, or date. Returns propertyId.",
			parameters: objectSchema({
				name: { type: "string", description: "Column name." },
				type: { type: "string", enum: [...PROPERTY_TYPES], description: "text, number, boolean, or date." },
			}, ["name", "type"]),
			execute: async (rawArgs) => {
				const property = await core.createProperty(requiredText(rawArgs, "name"), requiredType(rawArgs));
				return jsonResult({ propertyId: property.propertyId, name: property.name, type: property.type });
			},
		},
		{
			name: "update_property",
			description:
				"Rename a column or change its type. Copy propertyId from list_properties. " +
				"Changing type is refused while the column still has values.",
			parameters: objectSchema({
				propertyId: { type: "string", description: "propertyId from list_properties or create_property." },
				name: { type: "string", description: "New column name." },
				type: { type: "string", enum: [...PROPERTY_TYPES], description: "text, number, boolean, or date." },
			}, ["propertyId", "name", "type"]),
			execute: async (rawArgs) => {
				const property = await core.updateProperty(
					requiredText(rawArgs, "propertyId"),
					requiredText(rawArgs, "name"),
					requiredType(rawArgs),
				);
				return jsonResult({ propertyId: property.propertyId, name: property.name, type: property.type });
			},
		},
		{
			name: "remove_property",
			description:
				"Delete one table column and every value in it. Copy propertyId from list_properties.",
			parameters: objectSchema({
				propertyId: { type: "string", description: "propertyId from list_properties or create_property." },
			}, ["propertyId"]),
			execute: async (rawArgs) => {
				const propertyId = requiredText(rawArgs, "propertyId");
				await core.removeProperty(propertyId);
				return jsonResult({ removed: propertyId });
			},
		},
		{
			name: "set_asset_property",
			description:
				"Write one table cell. Copy assetId and propertyId from tool results. " +
				"value matches the column type: text is a string, number is a number, boolean is true or false, date is YYYY-MM-DD.",
			parameters: objectSchema({
				assetId: { type: "string", description: "Asset id of the file." },
				propertyId: { type: "string", description: "propertyId of the column." },
				value: {
					anyOf: [{ type: "string" }, { type: "number" }, { type: "boolean" }],
					description: "Cell value for the column type.",
				},
			}, ["assetId", "propertyId", "value"]),
			execute: async (rawArgs) => {
				const saved = await core.setAssetProperty(
					requiredText(rawArgs, "assetId"),
					requiredText(rawArgs, "propertyId"),
					requiredValue(rawArgs),
				);
				return jsonResult(saved);
			},
		},
		{
			name: "clear_asset_property",
			description:
				"Clear one table cell. Copy assetId and propertyId from tool results. The column stays.",
			parameters: objectSchema({
				assetId: { type: "string", description: "Asset id of the file." },
				propertyId: { type: "string", description: "propertyId of the column." },
			}, ["assetId", "propertyId"]),
			execute: async (rawArgs) => {
				const assetId = requiredText(rawArgs, "assetId");
				const propertyId = requiredText(rawArgs, "propertyId");
				await core.removeAssetProperty(assetId, propertyId);
				return jsonResult({ assetId, propertyId, cleared: true });
			},
		},
	];
}

function objectSchema(properties: Record<string, unknown>, required: string[]) {
	return { type: "object", properties, required, additionalProperties: false };
}

function jsonResult(details: unknown): LoomToolResult {
	return { content: JSON.stringify(details), details };
}

function asRecord(value: unknown): Record<string, unknown> {
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		throw new TypeError("arguments must be an object");
	}
	return value as Record<string, unknown>;
}

function requiredText(value: unknown, name: string): string {
	const record = asRecord(value);
	if (typeof record[name] !== "string" || !record[name].trim()) {
		throw new TypeError(`${name} must be a non-empty string`);
	}
	return record[name].trim();
}

function requiredType(value: unknown): PropertyType {
	const type = requiredText(value, "type");
	if (type !== "text" && type !== "number" && type !== "boolean" && type !== "date") {
		throw new TypeError("type must be text, number, boolean, or date");
	}
	return type;
}

function requiredValue(value: unknown): PropertyValue {
	const record = asRecord(value);
	const cell = record.value;
	if (typeof cell === "string" || typeof cell === "boolean") return cell;
	if (typeof cell === "number" && Number.isFinite(cell)) return cell;
	throw new TypeError("value must be a string, number, or boolean");
}
