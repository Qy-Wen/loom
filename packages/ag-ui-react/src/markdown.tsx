import type { ComponentPropsWithoutRef, ComponentType } from "react";
import { Streamdown } from "streamdown";

export type MarkdownLinkProps = ComponentPropsWithoutRef<"a">;

export interface MarkdownProps {
	content: string;
	className?: string;
	linkComponent?: ComponentType<MarkdownLinkProps>;
}

/** Render Markdown as it arrives. Applications can supply their own link component. */
export function Markdown({ content, className, linkComponent }: MarkdownProps) {
	return <Streamdown
		className={className ? `agui-markdown ${className}` : "agui-markdown"}
		components={linkComponent ? { a: linkComponent } : undefined}
	>{content}</Streamdown>;
}
