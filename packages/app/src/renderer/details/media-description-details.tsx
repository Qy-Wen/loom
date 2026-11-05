import type { AudioWriteupStatus, ImageVlmStatus, VideoVlmStatus } from "@loom/core";
import { rawStatusLabel } from "../../shared/locale.ts";
import { useLocale } from "../locale.tsx";
import { CopyableError } from "../components/copyable-error.tsx";
import { useConfirmation } from "../components/confirm-dialog.tsx";
import { TooltipText } from "../components/tooltip-text.tsx";

type DescriptionStatus = ImageVlmStatus | VideoVlmStatus | AudioWriteupStatus;

interface MediaDescriptionDetailsProps {
	status: DescriptionStatus;
	busy: boolean;
	embedding: boolean;
	onDescribe: () => void;
}

/** The description has its own status, errors, and retry action. */
export function MediaDescriptionDetails({
	status,
	busy: requested,
	embedding,
	onDescribe,
}: MediaDescriptionDetailsProps): React.JSX.Element {
	const { t } = useLocale();
	const { confirm } = useConfirmation();
	const described = status.status === "ready" && !status.stale;
	const describing = requested || status.status === "describing";
	const busy = describing || embedding;
	const label = status.status === "ready" ? t.details.redescribe : t.details.describe;
	async function describe(): Promise<void> {
		if (described && !await confirm({
			title: t.details.redescribeConfirmTitle,
			description: t.details.redescribeConfirmBody,
			confirmLabel: t.details.redescribe,
		})) return;
		onDescribe();
	}
	return (
		<section aria-label={t.details.captionStatus}>
			<dl className="properties analysis-properties">
				<dt className="analysis-status-label">{t.details.caption}<br />{t.details.status}</dt>
				<dd className="analysis-status">
					<TooltipText text={formatStatus(t, status)} tooltip={status.modelId ? `${t.details.model}: ${status.modelId}` : undefined} />
					<button type="button" className="detail-action-button" disabled={busy} onClick={() => void describe()}>
						{describing ? t.details.describing : label}
					</button>
				</dd>
				{status.error && (
					<>
						<dt>{t.details.error}</dt>
						<dd className="copyable-error-cell"><CopyableError text={status.error} /></dd>
					</>
				)}
			</dl>
		</section>
	);
}

function formatStatus(
	t: ReturnType<typeof useLocale>["t"],
	status: DescriptionStatus,
): string {
	if (status.status === "idle") return t.details.notDescribed;
	const label = rawStatusLabel(t, status.status);
	return status.stale ? t.status.stale(label) : label;
}
