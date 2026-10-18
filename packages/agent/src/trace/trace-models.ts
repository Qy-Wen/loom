import type { AssistantMessage, Message } from "@earendil-works/pi-ai";
import type { Models } from "@earendil-works/pi-ai/models";

export interface TraceRequestObserver {
	start(signal: AbortSignal | undefined, model: { id: string; provider: string; api: string }, messages: readonly Message[], operation: "request" | "poll"): {
		partial(message: AssistantMessage): void;
		end(message: AssistantMessage): void;
		error(error: unknown): void;
	} | undefined;
}

/** Instrument public calls without consuming streams ahead of durable or changing request options/results. */
export function traceModels(models: Models, observer: TraceRequestObserver): Models {
	const observe = <T>(operation: () => T): T | undefined => { try { return operation(); } catch { return undefined; } };
	return new Proxy(models, { get(target, property) {
		if (property === "streamSimple") return (...args: Parameters<Models["streamSimple"]>) => {
			const request = observe(() => observer.start(args[2]?.signal, args[0], args[1].messages, "request"));
			const stream = target.streamSimple(...args);
			if (!request) return stream;
			void stream.result().then((message) => { observe(() => request.end(message)); }, (error) => { observe(() => request.error(error)); });
			return new Proxy(stream, { get(target, key) {
				if (key === Symbol.asyncIterator) return async function* () {
					for await (const event of target) {
						if ("partial" in event) observe(() => request.partial(event.partial));
						yield event;
					}
				};
				const value = Reflect.get(target, key, target);
				return typeof value === "function" ? value.bind(target) : value;
			} });
		};
		if (property === "completeSimple") return async (...args: Parameters<Models["completeSimple"]>) => {
			const request = observe(() => observer.start(args[2]?.signal, args[0], args[1].messages, "request"));
			try { const message = await target.completeSimple(...args); observe(() => request?.end(message)); return message; }
			catch (error) { observe(() => request?.error(error)); throw error; }
		};
		if (property === "fetchDeferred") return async (...args: Parameters<Models["fetchDeferred"]>) => {
			const request = observe(() => observer.start(args[2]?.signal, args[0], [], "poll"));
			try { const message = await target.fetchDeferred(...args); observe(() => request?.end(message)); return message; }
			catch (error) { observe(() => request?.error(error)); throw error; }
		};
		const value = Reflect.get(target, property, target);
		return typeof value === "function" ? value.bind(target) : value;
	} });
}
