import { useLayoutEffect, useMemo, useRef, useState } from "react";
import {
	forceCollide,
	forceLink,
	forceManyBody,
	forceSimulation,
	forceX,
	forceY,
	type ForceLink,
	type Simulation,
	type SimulationLinkDatum,
	type SimulationNodeDatum,
} from "d3-force";
import { GRAPH_NODE_RADIUS, layoutForceGraph } from "./graph-layout.ts";

export interface SimNode extends SimulationNodeDatum {
	id: string;
	x: number;
	y: number;
}

interface SimLink extends SimulationLinkDatum<SimNode> {
	source: string | SimNode;
	target: string | SimNode;
}

const sessionPositions = new Map<string, { x: number; y: number }>();

export function useGraphSimulation(
	ids: string[],
	edges: { fromId: string; toId: string }[],
): {
	nodes: SimNode[];
	pin: (id: string, x: number, y: number) => void;
	unpin: (id: string) => void;
} {
	const simRef = useRef<Simulation<SimNode, SimLink> | null>(null);
	const nodesRef = useRef<SimNode[]>([]);
	const draggingRef = useRef(false);
	const inputRef = useRef({ ids, edges });
	inputRef.current = { ids, edges };
	const [, setTick] = useState(0);
	const idsKey = useMemo(() => [...ids].sort().join("\0"), [ids]);
	const linksKey = useMemo(
		() => edges.map((edge) => `${edge.fromId}\0${edge.toId}`).sort().join("|"),
		[edges],
	);

	useLayoutEffect(() => {
		const { ids, edges } = inputRef.current;
		const sim = ensureSimulation(simRef, () => setTick((value) => value + 1));
		const previous = new Map(nodesRef.current.map((node) => [node.id, node]));
		const known = ids.filter((id) => previous.has(id) || sessionPositions.has(id));
		const hasNewcomer = ids.some((id) => !previous.has(id) && !sessionPositions.has(id));
		const next = known.length === 0
			? seedFresh(ids, edges)
			: seedIncremental(ids, previous);
		nodesRef.current = next;
		sim.nodes(next);
		const linkForce = sim.force("link") as ForceLink<SimNode, SimLink>;
		linkForce.links(edges.map((edge) => ({ source: edge.fromId, target: edge.toId })));
		if (known.length === 0) settle(sim);
		else if (hasNewcomer) sim.alpha(0.22).alphaTarget(0).restart();
		else sim.alpha(0).stop();
		persist(next);
		setTick((value) => value + 1);
		return () => {
			persist(nodesRef.current);
			simRef.current?.stop();
			simRef.current = null;
		};
	}, [idsKey, linksKey]);

	return {
		nodes: nodesRef.current,
		pin: (id, x, y) => {
			const node = nodesRef.current.find((item) => item.id === id);
			const sim = simRef.current;
			if (!node || !sim) return;
			node.fx = x;
			node.fy = y;
			node.x = x;
			node.y = y;
			if (!draggingRef.current) {
				draggingRef.current = true;
				sim.alphaTarget(0.04).restart();
			}
		},
		unpin: (id) => {
			const node = nodesRef.current.find((item) => item.id === id);
			const sim = simRef.current;
			if (!node || !sim) return;
			draggingRef.current = false;
			node.fx = null;
			node.fy = null;
			sim.alphaTarget(0);
			persist(nodesRef.current);
		},
	};
}

function ensureSimulation(
	simRef: { current: Simulation<SimNode, SimLink> | null },
	onTick: () => void,
): Simulation<SimNode, SimLink> {
	if (simRef.current) return simRef.current;
	const sim = forceSimulation<SimNode, SimLink>([])
		.force("charge", forceManyBody().strength(-240))
		.force(
			"link",
			forceLink<SimNode, SimLink>([]).id((node) => node.id).distance(100).strength(0.35),
		)
		.force("collide", forceCollide<SimNode>().radius(GRAPH_NODE_RADIUS + 18).iterations(2))
		.force("x", forceX(0).strength(0.03))
		.force("y", forceY(0).strength(0.03))
		.alphaDecay(0.06)
		.velocityDecay(0.38)
		.on("tick", () => {
			persist(sim.nodes());
			onTick();
		});
	simRef.current = sim;
	return sim;
}

/** Run the forces to rest before the first paint. A short live run freezes the nodes in a clump, and reheating on drag then throws them apart. */
function settle(sim: Simulation<SimNode, SimLink>): void {
	const onTick = sim.on("tick");
	sim.on("tick", null);
	const decay = sim.alphaDecay();
	sim.stop();
	sim.alphaTarget(0).alphaDecay(0.0228).alpha(1);
	for (let i = 0; i < 320; i += 1) sim.tick();
	sim.alphaDecay(decay).alpha(0).stop();
	if (onTick) sim.on("tick", onTick);
}

function seedFresh(ids: string[], edges: { fromId: string; toId: string }[]): SimNode[] {
	return layoutForceGraph(ids, edges).map((node) => {
		sessionPositions.set(node.id, { x: node.x, y: node.y });
		return { id: node.id, x: node.x, y: node.y };
	});
}

function seedIncremental(ids: string[], previous: Map<string, SimNode>): SimNode[] {
	const kept = ids.flatMap((id) => {
		const live = previous.get(id);
		if (live) return [live];
		const saved = sessionPositions.get(id);
		if (saved) return [{ id, x: saved.x, y: saved.y }];
		return [];
	});
	const cx = kept.length ? kept.reduce((sum, node) => sum + node.x, 0) / kept.length : 0;
	const cy = kept.length ? kept.reduce((sum, node) => sum + node.y, 0) / kept.length : 0;
	return ids.map((id, index) => {
		const live = previous.get(id);
		if (live) return live;
		const saved = sessionPositions.get(id);
		if (saved) return { id, x: saved.x, y: saved.y };
		const angle = (2 * Math.PI * index) / Math.max(ids.length, 1);
		return { id, x: cx + Math.cos(angle) * 72, y: cy + Math.sin(angle) * 72 };
	});
}

function persist(nodes: SimNode[]): void {
	for (const node of nodes) {
		if (Number.isFinite(node.x) && Number.isFinite(node.y)) {
			sessionPositions.set(node.id, { x: node.x, y: node.y });
		}
	}
}
