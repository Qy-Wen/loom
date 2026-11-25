const { ipcRenderer } = require("electron");

// This sandboxed preload sends geometry only. The document has no access to Electron.
window.addEventListener("DOMContentLoaded", () => {
	const root = document.documentElement;
	const body = document.body;
	let frame = 0;
	let previousWidth = 0;
	let previousHeight = 0;
	let viewportWidth = window.innerWidth;
	let viewportHeight = window.innerHeight;
	let resizingPasses = 0;

	function measure() {
		frame = 0;
		const scroller = document.scrollingElement ?? root;
		const width = scroller.scrollWidth;
		const height = scroller.scrollHeight > scroller.clientHeight
			? scroller.scrollHeight
			: root.offsetHeight;
		const resized = viewportWidth !== window.innerWidth || viewportHeight !== window.innerHeight;
		viewportWidth = window.innerWidth;
		viewportHeight = window.innerHeight;
		const overflowing = width > scroller.clientWidth || height > scroller.clientHeight;
		resizingPasses = resized && overflowing ? resizingPasses + 1 : 0;
		if (width === previousWidth && height === previousHeight) return;
		previousWidth = width;
		previousHeight = height;
		// Layout tied to viewport units can keep expanding each time the guest grows.
		const unstable = resizingPasses >= 4;
		ipcRenderer.sendToHost("html-preview-size", { width, height, unstable });
		if (unstable) {
			resize.disconnect();
			mutations.disconnect();
			window.removeEventListener("resize", schedule);
			window.removeEventListener("load", schedule, true);
		}
	}

	function schedule() {
		if (!frame) frame = requestAnimationFrame(measure);
	}

	const resize = new ResizeObserver(schedule);
	resize.observe(root);
	if (body) resize.observe(body);
	const mutations = new MutationObserver(schedule);
	mutations.observe(root, { attributes: true, childList: true, characterData: true, subtree: true });
	window.addEventListener("resize", schedule);
	window.addEventListener("load", schedule, true);
	schedule();
}, { once: true });
