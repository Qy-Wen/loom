export type ConfirmationTone = "normal" | "warning" | "danger";

export interface ConfirmationChoice {
	id: string;
	label: string;
	primary?: boolean;
}

export interface ChoiceOptions {
	title: string;
	description: string;
	tone?: ConfirmationTone;
	choices: readonly ConfirmationChoice[];
}

export interface ConfirmOptions extends Omit<ChoiceOptions, "choices"> {
	confirmLabel: string;
}

export interface ConfirmationRequest extends ChoiceOptions {
	id: number;
}

interface PendingConfirmation {
	request: ConfirmationRequest;
	owner: symbol;
	resolve: (choice: string | null) => void;
}

/** One window's requests. Owners cancel their requests when their view or context goes away. */
export class ConfirmationQueue {
	private pending: PendingConfirmation[] = [];
	private listeners = new Set<() => void>();
	private nextId = 0;

	getSnapshot = (): ConfirmationRequest | null => this.pending[0]?.request ?? null;

	subscribe = (listener: () => void): (() => void) => {
		this.listeners.add(listener);
		return () => { this.listeners.delete(listener); };
	};

	request(options: ChoiceOptions, owner: symbol): Promise<string | null> {
		// Repeated clicks from the same caller must not execute an action twice.
		if (this.pending.some((item) => item.owner === owner)) return Promise.resolve(null);
		return new Promise((resolve) => {
			this.pending.push({ request: { ...options, id: ++this.nextId }, owner, resolve });
			this.notify();
		});
	}

	settle(id: number, choice: string | null): void {
		const first = this.pending[0];
		if (!first || first.request.id !== id) return;
		if (choice !== null && !first.request.choices.some((item) => item.id === choice)) return;
		this.pending.shift();
		first.resolve(choice);
		this.notify();
	}

	cancel(owner: symbol): void {
		const cancelled = this.pending.filter((item) => item.owner === owner);
		if (!cancelled.length) return;
		this.pending = this.pending.filter((item) => item.owner !== owner);
		for (const item of cancelled) item.resolve(null);
		this.notify();
	}

	clear(): void {
		const pending = this.pending;
		this.pending = [];
		for (const item of pending) item.resolve(null);
		this.notify();
	}

	private notify(): void {
		for (const listener of this.listeners) listener();
	}
}
