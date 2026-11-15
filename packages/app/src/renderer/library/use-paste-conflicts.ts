import { useEffect, useRef } from "react";
import { useConfirmation } from "../components/confirm-dialog.tsx";
import { useLocale } from "../locale.tsx";

export function usePasteConflicts(rootPath: string | null): void {
	const { t } = useLocale();
	const { choose, cancel } = useConfirmation(rootPath);
	const active = useRef<number | null>(null);
	useEffect(() => window.loom.onPasteConflict(async ({ id, conflict }) => {
		if (!conflict) {
			if (active.current === id) cancel();
			return;
		}
		active.current = id;
		let applyAll = false;
		const name = conflict.destinationPath.split(/[\\/]/).pop()!;
		const description = conflict.sourceIsDirectory !== conflict.destinationIsDirectory
			? t.library.pasteTypeConflictDetail : t.library.pasteConflictDetail;
		const choice = await choose({
			title: t.library.pasteConflict(name),
			description: description(conflict.destinationPath),
			tone: "warning",
			checkbox: { label: t.library.pasteApplyAll, onChange: (checked) => { applyAll = checked; } },
			choices: [
				{ id: "replace", label: t.library.pasteReplace },
				{ id: "keep-both", label: t.library.pasteKeepBoth, primary: true },
			],
		});
		if (active.current === id) active.current = null;
		await window.loom.resolvePasteConflict(id, choice === "replace" || choice === "keep-both" ? choice : "cancel", applyAll);
	}), [choose, cancel, t]);
}
