import { createHttpEmbeddingProvider } from "../evals/http-embed.ts";
import { embeddingHttpContract } from "./fixtures/embedding-http-contract.ts";

embeddingHttpContract("evaluation Embedding HTTP contract", (slot) =>
	createHttpEmbeddingProvider({ ...slot, baseUrl: " https://api.example.com/v2/ " }),
	"https://api.example.com/v2/embeddings");
