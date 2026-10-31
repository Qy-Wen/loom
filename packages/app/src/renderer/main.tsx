import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App.tsx";
import { LocaleProvider } from "./locale.tsx";
import { ConfirmationProvider } from "./components/confirm-dialog.tsx";
import "@copilotkit/react-core/v2/styles.css";
import "./styles.css";

const root = document.getElementById("root");
if (!root) throw new Error("#root not found");
createRoot(root).render(
	<StrictMode>
		<LocaleProvider>
			<ConfirmationProvider>
				<App />
			</ConfirmationProvider>
		</LocaleProvider>
	</StrictMode>,
);
