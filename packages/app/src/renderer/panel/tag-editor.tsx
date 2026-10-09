import { useState } from "react";
import type { AssetTag, Tag } from "@loom/core";
import { SuggestInput } from "./suggest-input.tsx";

interface TagEditorProps {
	assetId: string;
	tags: Tag[];
	assetTags: AssetTag[];
	onAdd: (name: string) => Promise<void>;
	onRemove: (tagId: string) => Promise<void>;
}

export function TagEditor({ assetId, tags, assetTags, onAdd, onRemove }: TagEditorProps): React.JSX.Element {
	const [name, setName] = useState("");
	const [open, setOpen] = useState(false);
	const byId = new Map(tags.map((tag) => [tag.tagId, tag]));
	const applied = assetTags.flatMap((row) => {
		if (row.assetId !== assetId) return [];
		const tag = byId.get(row.tagId);
		return tag ? [tag] : [];
	});

	async function submit(): Promise<void> {
		const next = name.trim();
		if (!next) return;
		await onAdd(next);
		setName("");
		setOpen(false);
	}

	return (
		<div className="tag-editor">
			<div className="section-label">Tags</div>
			{applied.length > 0 ? (
				<div className="tag-chips">
					{applied.map((tag) => (
						<span key={tag.tagId} className="tag-chip">
							<span className="tag-chip-name">{tag.name}</span>
							<button
								type="button"
								aria-label={`Remove ${tag.name}`}
								onClick={() => void onRemove(tag.tagId).catch(() => undefined)}
							>
								×
							</button>
						</span>
					))}
				</div>
			) : null}
			<form
				className="tag-add"
				onSubmit={(event) => {
					event.preventDefault();
					void submit().catch(() => undefined);
				}}
			>
				<SuggestInput
					value={name}
					open={open}
					suggestions={tags.map((tag) => tag.name)}
					placeholder="Add a tag"
					showLabel="Show tags"
					hideLabel="Hide tags"
					onChange={setName}
					onOpenChange={setOpen}
				/>
				<button type="submit" disabled={!name.trim()}>Add</button>
			</form>
		</div>
	);
}
