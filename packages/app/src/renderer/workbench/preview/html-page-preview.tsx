import { useEffect, useRef } from "react";
import { createHtmlPreviewGuest } from "./html-preview-guest.ts";

export function HtmlPagePreview({ src, title, readOnly, lazy = false, inert = false }: {
	src: string;
	title: string;
	readOnly: boolean;
	lazy?: boolean;
	inert?: boolean;
}): React.JSX.Element {
	const hostRef = useRef<HTMLDivElement>(null);
	useEffect(() => {
		const host = hostRef.current;
		if (!host || readOnly) return;
		const mount = () => host.append(createHtmlPreviewGuest(host.ownerDocument, src, title));
		if (!lazy) {
			mount();
			return () => host.replaceChildren();
		}
		let active = true;
		const observer = new IntersectionObserver(([entry]) => {
			if (!active || !entry?.isIntersecting) return;
			observer.disconnect();
			mount();
		});
		observer.observe(host);
		return () => {
			active = false;
			observer.disconnect();
			host.replaceChildren();
		};
	}, [src, title, readOnly, lazy]);
	return readOnly
		? <iframe className="html-page-preview" src={src} title={title} sandbox="" referrerPolicy="no-referrer" loading={lazy ? "lazy" : undefined} inert={inert} />
		: <div ref={hostRef} className="html-page-preview" inert={inert} />;
}
