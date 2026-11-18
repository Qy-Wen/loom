import type { Tool } from "@modelcontextprotocol/sdk/types.js";

const READ_ONLY = new Set([
	"get_library", "read_asset", "search_assets", "deep_search_assets", "inspect_asset", "run_ffprobe", "list_tags", "list_properties", "get_settings", "list_canvases", "read_canvas",
]);
const ADDITIVE = new Set(["create_folder", "add_tag", "create_relation", "create_property", "grade_image", "create_canvas"]);
const LOCAL = new Set([
	"get_library", "read_asset", "search_assets", "inspect_asset", "list_tags", "list_properties",
	"rename_asset", "move_assets", "create_folder", "rename_folder", "move_folder", "grade_image",
	"add_tag", "remove_tag", "set_favorite", "create_relation", "remove_relation", "create_property", "update_property",
	"remove_property", "set_asset_property", "clear_asset_property",
	"list_canvases", "read_canvas", "create_canvas", "edit_canvas",
]);

/** Describe effects to the external host; these hints never authorize execution. Unknown tools stay conservative. */
export function toolAnnotations(name: string): NonNullable<Tool["annotations"]> {
	const readOnlyHint = READ_ONLY.has(name);
	return {
		readOnlyHint,
		destructiveHint: !readOnlyHint && !ADDITIVE.has(name),
		openWorldHint: !LOCAL.has(name),
	};
}
