import { TooltipProvider } from "./components/tooltip.tsx";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App.tsx";
import { LocaleProvider } from "./locale.tsx";
import { ConfirmationProvider } from "./components/confirm-dialog.tsx";
import "@copilotkit/react-core/v2/styles.css";
import "./styles.css";
import "./design/vendor-copilotkit.css";
import { followColorScheme } from "./design/theme.ts";

followColorScheme();

const root = document.getElementById("root");
if (!root) throw new Error("#root not found");
createRoot(root).render(
	<StrictMode>
		<TooltipProvider>
			<LocaleProvider>
				<ConfirmationProvider>
					<App />
				</ConfirmationProvider>
			</LocaleProvider>
		</TooltipProvider>
	</StrictMode>,
);
