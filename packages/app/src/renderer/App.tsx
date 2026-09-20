import { useEffect, useState } from "react";
import { CopilotChat, CopilotKitProvider } from "@copilotkit/react-core/v2";
import type { AgentEndpoint } from "../shared/ipc.ts";

export function App(): React.JSX.Element {
	const [endpoint, setEndpoint] = useState<AgentEndpoint | null>(null);

	useEffect(() => {
		window.loom.getAgentEndpoint().then(setEndpoint).catch(console.error);
	}, []);

	if (!endpoint) {
		return <div className="loading">Connecting to Loom agent…</div>;
	}

	return (
		<CopilotKitProvider runtimeUrl={endpoint.runtimeUrl} agentId={endpoint.agentId}>
			<div className="app">
				<header className="topbar">
					<span className="brand">Loom</span>
				</header>
				<main className="chat">
					<CopilotChat />
				</main>
			</div>
		</CopilotKitProvider>
	);
}
