import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createMcpContractServer } from "./mcp-contract-server.ts";

const mode = process.argv[2] === "repeated-cursor" ? "repeated-cursor" : "normal";
await createMcpContractServer(mode).connect(new StdioServerTransport());
