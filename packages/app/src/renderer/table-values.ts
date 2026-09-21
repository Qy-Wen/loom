import type { PropertyType, PropertyValue } from "@loom/core";

export function comparePropertyValues(left: PropertyValue, right: PropertyValue): number {
	if (typeof left === "number" && typeof right === "number") return left - right;
	if (typeof left === "boolean" && typeof right === "boolean") return Number(left) - Number(right);
	return String(left).localeCompare(String(right), undefined, { numeric: true, sensitivity: "base" });
}

export function displayPropertyValue(value: PropertyValue | undefined, type?: PropertyType): string {
	if (value === undefined) return "—";
	if (type === "boolean") return value ? "Yes" : "No";
	return String(value);
}
