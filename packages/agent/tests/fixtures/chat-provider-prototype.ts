import type { Api, Model, Provider, SimpleStreamOptions } from "@earendil-works/pi-ai";
import { isModelType } from "@earendil-works/pi-ai/models";

/** P0 only: prove composition without replacing native auth, refresh, or dispatch. */
export function overlayChatProvider(provider: Provider, override: {
	baseUrl?: string;
	headers?: Record<string, string>;
	contextWindow?: number;
}): Provider {
	const overlay = <T extends Model<Api>>(model: T): T => ({
		...model,
		...(override.baseUrl === undefined ? {} : { baseUrl: override.baseUrl }),
		...(override.contextWindow === undefined ? {} : { contextWindow: override.contextWindow }),
		// Provider.headers is metadata in pi-ai 1.1.0, not an automatic request-header overlay.
		...(override.headers === undefined ? {} : { headers: { ...model.headers, ...override.headers } }),
	});
	return new Proxy(provider, { get(target, key) {
		if (key === "getModels") return () => target.getModels().map(overlay);
		if (key === "getAllModels") return () => (target.getAllModels?.() ?? target.getModels()).map((model) => isModelType(model, "chat") ? overlay(model) : model);
		const value = Reflect.get(target, key, target);
		return typeof value === "function" ? value.bind(target) : value;
	} });
}

/** P0 only: defaults can reach streams, but this alone does NOT pin recovered requests. */
export function withGenerationDefaults(provider: Provider, defaults: Pick<SimpleStreamOptions, "maxTokens" | "temperature">): Provider {
	return new Proxy(provider, { get(target, key) {
		if (key === "streamSimple") return (...[model, context, options]: Parameters<Provider["streamSimple"]>) => target.streamSimple(model, context, {
			...defaults, ...options,
			maxTokens: options?.maxTokens ?? defaults.maxTokens,
			temperature: options?.temperature ?? defaults.temperature,
		});
		const value = Reflect.get(target, key, target);
		return typeof value === "function" ? value.bind(target) : value;
	} });
}
