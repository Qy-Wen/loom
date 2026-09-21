export type PropertyType = "text" | "number" | "boolean" | "date";

/** A library-wide custom field definition. Values are attached separately by asset UUID. */
export interface PropertyDefinition {
	propertyId: string;
	name: string;
	type: PropertyType;
	createdAt: number;
}

/** Dates use the portable calendar form YYYY-MM-DD; time zones are intentionally excluded. */
export type PropertyValue = string | number | boolean;

export interface AssetPropertyValue {
	assetId: string;
	propertyId: string;
	value: PropertyValue;
}

export interface PropertySnapshot {
	properties: PropertyDefinition[];
	values: AssetPropertyValue[];
}

export function assertPropertyDefinition(property: PropertyDefinition): void {
	if (!property.name.trim()) throw new Error("Property name cannot be empty");
	if (!["text", "number", "boolean", "date"].includes(property.type)) {
		throw new TypeError("Invalid property type");
	}
}

export function assertPropertyValue(type: PropertyType, value: PropertyValue): void {
	if (type === "text" && typeof value === "string") return;
	if (type === "number" && typeof value === "number" && Number.isFinite(value)) return;
	if (type === "boolean" && typeof value === "boolean") return;
	if (type === "date" && typeof value === "string" && isCalendarDate(value)) return;
	throw new TypeError(`Invalid ${type} property value`);
}

function isCalendarDate(value: string): boolean {
	const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
	if (!match) return false;
	const year = Number(match[1]);
	const month = Number(match[2]);
	const day = Number(match[3]);
	const date = new Date(Date.UTC(year, month - 1, day));
	return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}
