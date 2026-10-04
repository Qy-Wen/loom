/** In-repo eval library. Copied into a temp directory at run time. */

export type EvalFile = {
	relativePath: string;
	text: string;
};

export const EVAL_STATUS = {
	name: "Status",
	hold: "Hold",
	published: "Published",
} as const;

export const EVAL_FILES: EvalFile[] = [
	{ relativePath: "notes/river.md", text: "A red bicycle leans against the dock by the river.\n" },
	{ relativePath: "notes/motorcycle.md", text: "The motorcycle sits in the garage with a dented tank.\n" },
	{ relativePath: "notes/canoe.md", text: "A canoe sits on the muddy bank next to a boathouse.\n" },
	{ relativePath: "notes/parking.md", text: "Staff cars fill the lot beside the water.\n" },
	{ relativePath: "recipes/soup.md", text: "Tomato soup recipe with basil.\n" },
	{ relativePath: "recipes/salad.md", text: "Sliced tomato salad with olive oil and salt.\n" },
	{ relativePath: "recipes/stew.md", text: "Beef stew simmered with carrots and potatoes.\n" },
	{ relativePath: "notes/grocery.md", text: "Buy onions, cream, and a loaf for dinner.\n" },
	{ relativePath: "briefs/brand.md", text: "Aurora campaign palette. Primary color is teal. Use this house brand voice for titles.\n" },
	{ relativePath: "briefs/competitor.md", text: "Rival studio uses crimson on every poster.\n" },
	{ relativePath: "notes/paint.md", text: "Leftover wall paint in the garage is a green-blue mix.\n" },
	{ relativePath: "briefs/poster.md", text: "Print sizes for the outdoor campaign boards.\n" },
	{ relativePath: "clips/hero.md", text: "Hero shot notes for the main clip: wide establishing shot at dusk.\n" },
	{ relativePath: "clips/closeup.md", text: "Close-up of hands at noon in the kitchen.\n" },
	{ relativePath: "clips/broll.md", text: "Night city traffic for cutaways.\n" },
	{ relativePath: "notes/callsheet.md", text: "Crew call at 16:00. Rain backup is the sound stage.\n" },
	{ relativePath: "notes/invoice.md", text: "Studio invoice for March lighting rental.\n" },
	{ relativePath: "notes/quote.md", text: "Lighting gear estimate, not billed yet.\n" },
	{ relativePath: "notes/receipt.md", text: "Coffee and parking stub from Tuesday.\n" },
	{ relativePath: "notes/contract.md", text: "Location agreement for the warehouse interior.\n" },
	{ relativePath: "notes/meeting.md", text: "Monday notes: lock picture by Friday.\n" },
	{ relativePath: "recipes/bread.md", text: "Sourdough starter feeding schedule.\n" },
	{ relativePath: "briefs/social.md", text: "Caption tone for the product teaser posts.\n" },
	{ relativePath: "clips/interview.md", text: "Sit-down with the director about pacing.\n" },
];

/** Status values keyed by relative path. Unlisted files have no Status. */
export const EVAL_STATUS_BY_PATH: Record<string, string> = {
	"notes/river.md": EVAL_STATUS.hold,
	"notes/motorcycle.md": EVAL_STATUS.hold,
	"notes/quote.md": EVAL_STATUS.hold,
	"recipes/soup.md": EVAL_STATUS.published,
	"briefs/brand.md": EVAL_STATUS.published,
	"clips/hero.md": EVAL_STATUS.published,
};
