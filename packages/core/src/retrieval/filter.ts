import type { PropertyDefinition } from "../model/property.ts";
import type { AssetPropertyFilter, AssetPropertyView } from "../model/retrieval.ts";

/** Apply AND-combined custom-property filters to one asset's resolved values. */
export function matchesPropertyFilters(
	properties: AssetPropertyView[],
	filters: AssetPropertyFilter[],
	definitionByName: Map<string, PropertyDefinition>,
): boolean {
	const valuesById = new Map(properties.map((property) => [property.propertyId, property.value]));
	for (const filter of filters) {
		const definition = definitionByName.get(filter.name.trim().toLowerCase());
		if (!definition) return false;
		const actual = valuesById.get(definition.propertyId);
		if (actual === undefined || !matchesValue(actual, filter.value, filter.operator)) return false;
	}
	return true;
}

function matchesValue(
	actual: string | number | boolean,
	expected: string | number | boolean,
	operator: AssetPropertyFilter["operator"],
): boolean {
	if (operator === "eq") return actual === expected;
	if (operator === "contains") {
		return typeof actual === "string" && typeof expected === "string" &&
			actual.toLowerCase().includes(expected.toLowerCase());
	}
	if (typeof actual === "number" && typeof expected === "number") {
		return operator === "gte" ? actual >= expected : actual <= expected;
	}
	if (typeof actual === "string" && typeof expected === "string") {
		const comparison = actual.localeCompare(expected);
		return operator === "gte" ? comparison >= 0 : comparison <= 0;
	}
	return false;
}
