import { createContext, useContext, type ReactElement } from 'react';
import ReactMarkdown, { type Components } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import remarkBreaks from 'remark-breaks';
import rehypeHighlight from 'rehype-highlight';
import { CodeBlock } from './CodeBlock';

/**
 * Markdown rendered in the console's own type scale, not a prose stylesheet's.
 *
 * Two surfaces render author-written markdown — an agent's chat message and a
 * GitHub issue — and they must look like one application. The component map
 * lived inside `MessageItem` until the issue dialog needed it; a second copy
 * kept in agreement by hand is a defect the moment it exists, so it moved here
 * instead.
 */
/**
 * True inside a link. An image an author already wrapped in a link keeps that
 * link; wrapping it again would nest `<a>` in `<a>`, which HTML forbids.
 */
const INSIDE_LINK = createContext(false);

/**
 * Every image opens its full-size self. Scaled into the message column a
 * diagram's labels are unreadable, and whether it could be opened used to
 * depend on each agent remembering to wrap it in a link.
 */
function LinkedImage({ src, alt }: { src?: string; alt?: string }): ReactElement {
  const insideLink = useContext(INSIDE_LINK);
  const img = <img src={src} alt={alt ?? ''} />;
  if (insideLink || !src) return img;
  return (
    <a href={src} target="_blank" rel="noreferrer" className="cursor-zoom-in">
      {img}
    </a>
  );
}

export const MD_COMPONENTS: Components = {
  a: ({ href, children }) => (
    <a
      href={href}
      target="_blank"
      rel="noreferrer"
      className="underline decoration-text-tertiary/50 underline-offset-2 transition-colors hover:text-accent-bright hover:decoration-accent-bright"
    >
      <INSIDE_LINK.Provider value={true}>{children}</INSIDE_LINK.Provider>
    </a>
  ),
  img: ({ src, alt }) => <LinkedImage src={typeof src === 'string' ? src : undefined} alt={alt} />,
  code: ({ className, children }) => {
    const isBlock = className?.startsWith('language-');
    if (isBlock) {
      return <code className={className}>{children}</code>;
    }
    return (
      <code className="rounded bg-surface-inset px-1 py-[1px] text-body text-text-primary">
        {children}
      </code>
    );
  },
  h1: ({ children }) => (
    <h1 className="mt-2 mb-1.5 text-large font-medium text-text-primary">{children}</h1>
  ),
  h2: ({ children }) => (
    <h2 className="mt-2 mb-1 text-body font-medium text-text-primary">{children}</h2>
  ),
  h3: ({ children }) => (
    <h3 className="mt-1.5 mb-0.5 text-body font-medium text-text-secondary">{children}</h3>
  ),
  p: ({ children }) => <p className="my-1 leading-relaxed">{children}</p>,
  ul: ({ children }) => (
    <ul className="my-1 ml-5 list-disc space-y-0.5 marker:text-text-tertiary">{children}</ul>
  ),
  ol: ({ children }) => (
    <ol className="my-1 ml-5 list-decimal space-y-0.5 marker:text-text-tertiary">{children}</ol>
  ),
  li: ({ children }) => <li className="leading-relaxed">{children}</li>,
  pre: ({ children }) => <CodeBlock>{children}</CodeBlock>,
  blockquote: ({ children }) => (
    <blockquote className="my-1 border-l-2 border-border pl-2 text-text-secondary">
      {children}
    </blockquote>
  ),
};

/** Hoisted: a fresh array each render remounts the whole plugin pipeline. */
export const MD_REMARK_PLUGINS = [remarkGfm, remarkBreaks];
export const MD_REHYPE_PLUGINS = [rehypeHighlight];

/**
 * Rendered as markdown, never as HTML. `react-markdown` escapes raw HTML
 * unless `rehype-raw` is added, which is what makes it safe to render a body
 * written by whoever opened the issue.
 */
export function Markdown({ children }: { children: string }): ReactElement {
  return (
    <ReactMarkdown
      remarkPlugins={MD_REMARK_PLUGINS}
      rehypePlugins={MD_REHYPE_PLUGINS}
      components={MD_COMPONENTS}
    >
      {children}
    </ReactMarkdown>
  );
}
