import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { AudioWriteupStatus, ImageVlmStatus, TextEmbedStatus, VideoVlmStatus } from "@loom/core";
import { rawStatusLabel } from "../../shared/locale.ts";
import { useLocale } from "../locale.tsx";
import { CopyableError } from "../components/copyable-error.tsx";

type DescriptionStatus = ImageVlmStatus | VideoVlmStatus | AudioWriteupStatus;

interface MediaDescriptionDetailsProps {
	status: DescriptionStatus;
	textEmbed: TextEmbedStatus | undefined;
	busy: boolean;
	embedding: boolean;
	onDescribe: () => void;
	onEmbed: () => void;
}

/** Describe and index an image, video, or audio file as one step with one status. */
export function MediaDescriptionDetails({
	status,
	textEmbed,
	busy: requested,
	embedding,
	onDescribe,
	onEmbed,
}: MediaDescriptionDetailsProps): React.JSX.Element {
	const { t } = useLocale();
	const [choosing, setChoosing] = useState(false);
	const described = status.status === "ready" && !status.stale;
	const indexing = described && textEmbed?.status === "embedding";
	const busy = requested || embedding || status.status === "describing" || indexing;
	// The model is always asked again. When a fresh description exists, the user picks first.
	const label = status.status === "ready" && status.stale ? t.details.redescribe : t.details.describe;
	const error = status.error ?? (described ? textEmbed?.error : undefined);
	const chunks = described && textEmbed && textEmbed.status === "ready"
		? t.details.chunks(textEmbed.childCount, textEmbed.parentCount)
		: undefined;
	const model = [status.modelId, described ? textEmbed?.modelId : undefined].filter(Boolean).join(" · ");
	return (
		<section>
			<div className="section-label enrichment-heading">
				<span>{t.details.caption}</span>
				<button type="button" className="text-button" disabled={busy} onClick={() => (described ? setChoosing(true) : onDescribe())}>
					{busy ? (indexing || embedding ? t.details.embedding : t.details.describing) : label}
				</button>
			</div>
			<dl className="properties">
				<dt>{t.details.status}</dt>
				<dd title={chunks}>{formatStatus(t, status, textEmbed, described)}</dd>
				{status.modelId && (
					<>
						<dt>{t.details.model}</dt>
						<dd title={model}>{status.modelId}</dd>
					</>
				)}
				{status.markdown && (
					<>
						<dt>{t.details.writeup}</dt>
						<dd className="vlm-markdown" title={status.markdown}>{status.markdown}</dd>
					</>
				)}
				{error && (
					<>
						<dt>{t.details.error}</dt>
						<dd className="copyable-error-cell"><CopyableError text={error} /></dd>
					</>
				)}
			</dl>
			{choosing && (
				<DescribeChoice
					onCancel={() => setChoosing(false)}
					onIndex={() => { setChoosing(false); onEmbed(); }}
					onRedescribe={() => { setChoosing(false); onDescribe(); }}
				/>
			)}
		</section>
	);
}

/** Already described: index the existing text, or describe again first. */
function DescribeChoice({ onCancel, onIndex, onRedescribe }: {
	onCancel: () => void;
	onIndex: () => void;
	onRedescribe: () => void;
}): React.JSX.Element {
	const { t } = useLocale();
	const dialogRef = useRef<HTMLDivElement>(null);
	useEffect(() => {
		const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
		dialogRef.current?.querySelector<HTMLElement>("button")?.focus();
		const onKey = (event: KeyboardEvent) => {
			if (event.key === "Escape") {
				event.preventDefault(); event.stopPropagation();
				onCancel();
				return;
			}
			if (event.key !== "Tab") return;
			const controls = dialogRef.current?.querySelectorAll<HTMLElement>("button");
			if (!controls?.length) return;
			const first = controls[0]!, last = controls[controls.length - 1]!;
			if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
			else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
		};
		window.addEventListener("keydown", onKey, true);
		return () => {
			window.removeEventListener("keydown", onKey, true);
			previous?.focus({ preventScroll: true });
		};
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, []);
	return createPortal(
		<div className="settings-login-overlay" onClick={(event) => { if (event.target === event.currentTarget) onCancel(); }}>
			<div ref={dialogRef} className="settings-login-card" role="dialog" aria-modal="true" aria-label={t.details.describeChoiceTitle}>
				<h3>{t.details.describeChoiceTitle}</h3>
				<p>{t.details.describeChoiceBody}</p>
				<div className="settings-actions settings-login-actions">
					<button type="button" onClick={onCancel}>{t.common.cancel}</button>
					<button type="button" onClick={onIndex}>{t.details.indexOnly}</button>
					<button className="primary-button" type="button" onClick={onRedescribe}>{t.details.redescribeAndIndex}</button>
				</div>
			</div>
		</div>,
		document.body,
	);
}

function formatStatus(
	t: ReturnType<typeof useLocale>["t"],
	status: DescriptionStatus,
	textEmbed: TextEmbedStatus | undefined,
	described: boolean,
): string {
	if (status.status === "idle") return t.details.notDescribed;
	const label = rawStatusLabel(t, status.status);
	if (status.stale) return t.status.stale(label);
	if (!described || !textEmbed?.supported) return label;
	if (textEmbed.status === "ready") return textEmbed.stale ? t.status.stale(label) : label;
	if (textEmbed.status === "idle") return t.details.notIndexed;
	return rawStatusLabel(t, textEmbed.status);
}
