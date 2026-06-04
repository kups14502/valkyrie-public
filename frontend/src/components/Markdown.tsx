import { memo } from 'react'
import ReactMarkdown, { type Components } from 'react-markdown'
import remarkGfm from 'remark-gfm'

// Markdown renderer for Code Deck chat bubbles. Components are themed to the
// terminal palette (var(--color-*)) and tuned to be compact so a reply reads as
// structured text — headings, lists, tables, and fenced code — instead of one
// collapsed paragraph. Block elements use tight vertical rhythm; the first/last
// child margins are trimmed so the bubble padding controls the outer spacing.
const components: Components = {
  p: ({ children }) => <p className="my-2 first:mt-0 last:mb-0 leading-relaxed break-words">{children}</p>,
  h1: ({ children }) => <h1 className="mb-2 mt-3 first:mt-0 text-base font-semibold text-[var(--color-text)]">{children}</h1>,
  h2: ({ children }) => <h2 className="mb-2 mt-3 first:mt-0 text-sm font-semibold uppercase tracking-[0.12em] text-[var(--color-text)]">{children}</h2>,
  h3: ({ children }) => <h3 className="mb-1 mt-3 first:mt-0 text-sm font-semibold text-[var(--color-text)]">{children}</h3>,
  ul: ({ children }) => <ul className="my-2 first:mt-0 last:mb-0 list-disc space-y-1 pl-5 marker:text-[var(--color-text-faint)]">{children}</ul>,
  ol: ({ children }) => <ol className="my-2 first:mt-0 last:mb-0 list-decimal space-y-1 pl-5 marker:text-[var(--color-text-faint)]">{children}</ol>,
  li: ({ children }) => <li className="leading-relaxed break-words [&>ul]:my-1 [&>ol]:my-1">{children}</li>,
  a: ({ children, href }) => (
    <a href={href} target="_blank" rel="noreferrer" className="text-[var(--color-accent)] underline underline-offset-2 break-words hover:opacity-80">{children}</a>
  ),
  strong: ({ children }) => <strong className="font-semibold text-[var(--color-text)]">{children}</strong>,
  em: ({ children }) => <em className="italic">{children}</em>,
  blockquote: ({ children }) => (
    <blockquote className="my-2 border-l-2 border-[var(--color-border-strong)] pl-3 text-[var(--color-text-dim)]">{children}</blockquote>
  ),
  hr: () => <hr className="my-3 border-[var(--color-border)]" />,
  code: ({ className, children, ...props }) => {
    // react-markdown gives inline code no language class; fenced blocks carry a
    // `language-*` class and are wrapped by <pre> (handled below).
    const isBlock = /language-/.test(className ?? '') || String(children).includes('\n')
    if (isBlock) {
      return (
        <code className={`${className ?? ''} block font-mono text-[12px] leading-relaxed`} {...props}>{children}</code>
      )
    }
    return (
      <code className="rounded border border-[var(--color-border)] bg-[rgba(255,255,255,0.04)] px-1 py-0.5 font-mono text-[12px] text-[var(--color-accent)]" {...props}>{children}</code>
    )
  },
  pre: ({ children }) => (
    <pre className="my-2 first:mt-0 last:mb-0 overflow-x-auto rounded border border-[var(--color-border)] bg-[rgba(0,0,0,0.35)] p-3">{children}</pre>
  ),
  table: ({ children }) => (
    <div className="my-2 overflow-x-auto">
      <table className="w-full border-collapse text-[12px]">{children}</table>
    </div>
  ),
  th: ({ children }) => <th className="border border-[var(--color-border)] px-2 py-1 text-left font-semibold">{children}</th>,
  td: ({ children }) => <td className="border border-[var(--color-border)] px-2 py-1 align-top">{children}</td>,
}

function MarkdownImpl({ children }: { children: string }) {
  return (
    <div className="text-sm text-[var(--color-text)]">
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={components}>{children}</ReactMarkdown>
    </div>
  )
}

export const Markdown = memo(MarkdownImpl)
