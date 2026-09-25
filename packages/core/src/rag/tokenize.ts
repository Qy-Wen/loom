import { getEncoding, type Tiktoken } from "js-tiktoken";

let encoder: Tiktoken | undefined;

function cl100k(): Tiktoken {
	encoder ??= getEncoding("cl100k_base");
	return encoder;
}

export function encodeTokens(text: string): number[] {
	return cl100k().encode(text);
}

export function decodeTokens(ids: number[]): string {
	return cl100k().decode(ids);
}

export function countTokens(text: string): number {
	if (!text) return 0;
	return encodeTokens(text).length;
}
