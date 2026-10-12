import { useState } from "react";
import { createRoot } from "react-dom/client";
import { LocaleProvider } from "../../src/renderer/locale.tsx";
import { usePanelLayout } from "../../src/renderer/layout/use-panel-layout.ts";
import { useResizableLayout } from "../../src/renderer/layout/use-resizable-layout.ts";
import { PanelWorkspace, type PanelView } from "../../src/renderer/layout/work-panel.tsx";
import "../../src/renderer/base.css";
import "../../src/renderer/layout/shell.css";
import "../../src/renderer/layout/dock.css";

function PanelsFixture() {
	const [hidden, setHidden] = useState(false);
	const [notes, setNotes] = useState(false);
	const columns = useResizableLayout();
	const panels: PanelView[] = ["alpha", "beta", "gamma", "timeline", "inspector", ...(notes ? ["notes"] : [])].map((id) => ({ id, title: id, visible: id !== "inspector" || !hidden, render: () => <div>{id} content</div> }));
	const layout = usePanelLayout(columns.shellRef, panels);
	const modes = ["dock", "beside", "above", "bottom"] as const;
	const frame = layout.dockSplitFrame ?? layout.spliceFrame ?? layout.joinFrame;
	const frameKind = layout.dockSplitFrame ? "dock-split" : layout.spliceFrame ? "splice" : "join";
	return <div className="app">
		<div className="window-bar"><button onClick={() => setHidden(!hidden)}>Toggle inspector</button><button onClick={() => setNotes(!notes)}>Toggle notes registration</button></div>
		<div ref={columns.shellRef} className={`shell${layout.hasRegion("dock") ? "" : " side-hidden"}${modes.filter((mode) => mode !== "dock" && layout.hasRegion(mode)).map((mode) => ` has-${mode}`).join("")}${frame ? ` ${frameKind}-target` : ""}`} style={{ ...columns.shellStyle, "--bottom-height": `${layout.bottomHeight}px`, "--above-height": `${layout.aboveHeight}px`, ...(frame ? { [`--${frameKind}-x`]: `${frame.x}px`, [`--${frameKind}-y`]: `${frame.y}px`, [`--${frameKind}-w`]: `${frame.width}px`, [`--${frameKind}-h`]: `${frame.height}px` } : {}) } as React.CSSProperties}>
			<div className="library-sidebar">Library</div><div className="resize-handle library-resize" /><main className="workbench">Workbench</main>
			{layout.hasRegion("dock") && <div className="resize-handle side-resize" />}
			{layout.hasRegion("beside") && <div className="resize-handle beside-resize" />}
			{layout.hasRegion("above") && <div className="resize-handle row above-resize" onPointerDown={layout.beginAboveResize} />}
			{layout.hasRegion("bottom") && <div className="resize-handle row bottom-resize" onPointerDown={layout.beginBottomResize} />}
			<PanelWorkspace layout={layout} panels={panels} />
		</div>
	</div>;
}
createRoot(document.getElementById("root")!).render(<LocaleProvider><PanelsFixture /></LocaleProvider>);
