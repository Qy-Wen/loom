import { createContext, useContext, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { useLocale } from "../locale.tsx";
import { ConfirmationQueue, type ChoiceOptions, type ConfirmOptions, type ConfirmationRequest } from "./confirmation.ts";

const ConfirmationContext = createContext<ConfirmationQueue | null>(null);

/** One host per renderer window, above settings, floating panels, and menus. */
export function ConfirmationProvider({ children }: { children: ReactNode }): React.JSX.Element {
	const [queue] = useState(() => new ConfirmationQueue());
	const request = useSyncExternalStore(queue.subscribe, queue.getSnapshot);
	useEffect(() => () => queue.clear(), [queue]);
	return (
		<ConfirmationContext.Provider value={queue}>
			{children}
			{request && <ConfirmationDialog key={request.id} request={request} onResult={(choice) => queue.settle(request.id, choice)} />}
		</ConfirmationContext.Provider>
	);
}

/** `scope` cancels pending questions when a library, session, or other caller context changes. */
export function useConfirmation(scope?: unknown): {
	confirm: (options: ConfirmOptions) => Promise<boolean>;
	choose: (options: ChoiceOptions) => Promise<string | null>;
} {
	const queue = useContext(ConfirmationContext);
	if (!queue) throw new Error("ConfirmationProvider is missing");
	const owner = useRef(Symbol("confirmation owner"));
	useEffect(() => () => queue.cancel(owner.current), [queue, scope]);
	return useMemo(() => ({
		confirm: async ({ confirmLabel, ...options }: ConfirmOptions) => (
			await queue.request({ ...options, choices: [{ id: "confirm", label: confirmLabel, primary: true }] }, owner.current)
		) === "confirm",
		choose: (options: ChoiceOptions) => queue.request(options, owner.current),
	}), [queue]);
}

function ConfirmationDialog({ request, onResult }: {
	request: ConfirmationRequest;
	onResult: (choice: string | null) => void;
}): React.JSX.Element {
	const { t } = useLocale();
	const dialogRef = useRef<HTMLDialogElement>(null);
	const cancelRef = useRef<HTMLButtonElement>(null);
	const resultRef = useRef(onResult);
	resultRef.current = onResult;
	const titleId = useId();
	const descriptionId = useId();
	const tone = request.tone ?? "normal";

	useLayoutEffect(() => {
		const dialog = dialogRef.current!;
		const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
		// The browser's top layer makes every background element (including other portals) inert.
		dialog.showModal();
		cancelRef.current?.focus({ preventScroll: true });
		const onKey = (event: KeyboardEvent) => {
			// Stop window/page shortcuts as well as React handlers behind the dialog.
			event.stopImmediatePropagation();
			if (event.key === "Escape") {
				event.preventDefault();
				resultRef.current(null);
			} else if (event.key === "Tab") {
				const buttons = dialog.querySelectorAll<HTMLButtonElement>("button");
				const first = buttons[0]!, last = buttons[buttons.length - 1]!;
				if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
				else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
			} else if ((event.ctrlKey || event.metaKey) && !["c", "a"].includes(event.key.toLowerCase())) {
				event.preventDefault();
			}
		};
		window.addEventListener("keydown", onKey, true);
		return () => {
			window.removeEventListener("keydown", onKey, true);
			dialog.close();
			if (previous?.isConnected) previous.focus({ preventScroll: true });
		};
	}, []);

	return createPortal(
		<dialog
			ref={dialogRef}
			className="confirmation-dialog"
			data-tone={tone}
			aria-modal="true"
			aria-labelledby={titleId}
			aria-describedby={descriptionId}
			onCancel={(event) => { event.preventDefault(); onResult(null); }}
			onPointerDown={(event) => {
				if (event.target !== event.currentTarget) return;
				const rect = event.currentTarget.getBoundingClientRect();
				if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) {
					event.preventDefault();
					event.stopPropagation();
					onResult(null);
				}
			}}
		>
			<div className="confirmation-content">
				{tone !== "normal" && (
					<span className="confirmation-icon" aria-hidden="true">
						<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
							{tone === "danger" ? (
								<path d="M4 6h16M9 6V3h6v3M6 6l1 15h10l1-15M10 10v7M14 10v7" />
							) : (
								<>
									<path d="m12 3 10 18H2L12 3ZM12 9v5" />
									<circle cx="12" cy="17" r=".8" fill="currentColor" stroke="none" />
								</>
							)}
						</svg>
					</span>
				)}
				<div className="confirmation-copy">
					<h2 id={titleId}>{request.title}</h2>
					<p id={descriptionId} className="confirmation-description">{request.description}</p>
				</div>
			</div>
			<div className="confirmation-actions">
				<button ref={cancelRef} type="button" onClick={() => onResult(null)}>{t.common.cancel}</button>
				{request.choices.map((choice) => (
					<button key={choice.id} type="button" className={choice.primary ? "confirmation-primary" : undefined} onClick={() => onResult(choice.id)}>
						{choice.label}
					</button>
				))}
			</div>
		</dialog>,
		document.body,
	);
}
