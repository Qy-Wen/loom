import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { DevTraceApp } from "./dev-trace-app.tsx";
import { TraceLocaleProvider } from "./trace-locale.tsx";
import "./dev-trace.css";

const root = document.getElementById("root");
if (!root) throw new Error("#root not found");
createRoot(root).render(
	<StrictMode>
		<TraceLocaleProvider>
			<DevTraceApp />
		</TraceLocaleProvider>
	</StrictMode>,
);
