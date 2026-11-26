import { isValidElement, type ComponentPropsWithoutRef, type ComponentType, type ReactNode } from "react";
import { Streamdown } from "streamdown";

export type MarkdownLinkProps = ComponentPropsWithoutRef<"a">;

export interface MarkdownProps {
	content: string;
	className?: string;
	linkComponent?: ComponentType<MarkdownLinkProps>;
}

function MarkdownCodeBlock({ children }: ComponentPropsWithoutRef<"pre">) {
	const code = isValidElement<{ children?: ReactNode }>(children) ? children.props.children : undefined;
	if (typeof code !== "string") return children;

	// Streamdown fills its code block asynchronously. Give it the full height from the first render.
	return <div className="agui-code-block">
		<div className="agui-code-fallback"><pre><code>{code}</code></pre></div>
		{children}
	</div>;
}

/** Render Markdown as it arrives. Applications can supply their own link component. */
export function Markdown({ content, className, linkComponent }: MarkdownProps) {
	return <Streamdown
		className={className ? `agui-markdown ${className}` : "agui-markdown"}
		components={{ pre: MarkdownCodeBlock, ...(linkComponent ? { a: linkComponent } : {}) }}
	>{content}</Streamdown>;
}
