import { memo, type ReactNode } from 'react'
import ReactMarkdown, { type Components } from 'react-markdown'
import { Link } from 'react-router-dom'
import remarkGfm from 'remark-gfm'

// Markdown renderer for project notes and pinned docs. Components are themed to
// the terminal palette (var(--color-*)) and tuned to be compact, so a note reads
// as structured text (headings, lists, tables, fenced code) instead of one
// collapsed paragraph. Block elements use tight vertical rhythm; the first and
// last child margins are trimmed so the container padding controls the outer
// spacing.
//
// Most of what it renders was written by a Claude session, so it is treated as
// hostile. This origin holds the app token and can open an elevated shell on
// thor: raw HTML is skipped, never parsed (no rehype-raw), a URL survives only
// as http, https, mailto or a same-origin path, and images become links, so a
// note cannot make the browser fetch anything on its own.

const SAME_ORIGIN_PATH = /^\/[A-Za-z0-9/_.?=&%#-]*$/

// Exported because the links and files tabs gate their own anchors on the same
// rule the renderer uses, so a URL blocked in a note is blocked everywhere.
// eslint-disable-next-line react-refresh/only-export-components
export function safeHref(url: string): string | null {
  const u = url.trim()
  if (u.startsWith('/')) {
    // '//host/x' matches the path pattern but is protocol-relative: the
    // browser resolves it to another origin.
    return !u.startsWith('//') && SAME_ORIGIN_PATH.test(u) ? u : null
  }
  try {
    const parsed = new URL(u)
    return parsed.protocol === 'http:' || parsed.protocol === 'https:' || parsed.protocol === 'mailto:'
      ? parsed.href
      : null
  } catch {
    return null
  }
}

const LINK = 'text-[var(--color-accent)] underline underline-offset-2 break-words hover:opacity-80'

function SafeLink({ href, children }: { href: string | undefined; children: ReactNode }) {
  const safe = href ? safeHref(href) : null
  if (!safe) return <span className="break-words text-[var(--color-text-dim)]">{children}</span>
  if (safe.startsWith('/')) return <Link to={safe} className={LINK}>{children}</Link>
  return <a href={safe} target="_blank" rel="noopener noreferrer" className={LINK}>{children}</a>
}

const components: Components = {
  p: ({ children }) => <p className="my-2 first:mt-0 last:mb-0 leading-relaxed break-words">{children}</p>,
  h1: ({ children }) => <h1 className="mb-2 mt-3 first:mt-0 text-base font-semibold text-[var(--color-text)]">{children}</h1>,
  h2: ({ children }) => <h2 className="mb-2 mt-3 first:mt-0 text-sm font-semibold uppercase tracking-[0.12em] text-[var(--color-text)]">{children}</h2>,
  h3: ({ children }) => <h3 className="mb-1 mt-3 first:mt-0 text-sm font-semibold text-[var(--color-text)]">{children}</h3>,
  ul: ({ children }) => <ul className="my-2 first:mt-0 last:mb-0 list-disc space-y-1 pl-5 marker:text-[var(--color-text-faint)]">{children}</ul>,
  ol: ({ children }) => <ol className="my-2 first:mt-0 last:mb-0 list-decimal space-y-1 pl-5 marker:text-[var(--color-text-faint)]">{children}</ol>,
  li: ({ children }) => <li className="leading-relaxed break-words [&>ul]:my-1 [&>ol]:my-1">{children}</li>,
  a: ({ children, href }) => <SafeLink href={href}>{children}</SafeLink>,
  img: ({ src, alt }) => <SafeLink href={typeof src === 'string' ? src : undefined}>{alt || 'image'}</SafeLink>,
  strong: ({ children }) => <strong className="font-semibold text-[var(--color-text)]">{children}</strong>,
  em: ({ children }) => <em className="italic">{children}</em>,
  blockquote: ({ children }) => (
    <blockquote className="my-2 border-l-2 border-[var(--color-border-strong)] pl-3 text-[var(--color-text-dim)]">{children}</blockquote>
  ),
  hr: () => <hr className="my-3 border-[var(--color-border)]" />,
  code: ({ className, children }) => {
    // react-markdown gives inline code no language class; fenced blocks carry a
    // `language-*` class and are wrapped by <pre> (handled below).
    const isBlock = /language-/.test(className ?? '') || String(children).includes('\n')
    if (isBlock) {
      return <code className={`${className ?? ''} block font-mono text-[12px] leading-relaxed`}>{children}</code>
    }
    return (
      <code className="rounded border border-[var(--color-border)] bg-[rgba(255,255,255,0.04)] px-1 py-0.5 font-mono text-[12px] text-[var(--color-accent)]">{children}</code>
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

const PLUGINS = [remarkGfm]
const urlTransform = (u: string) => safeHref(u) ?? ''

function MarkdownImpl({ children, className }: { children: string; className?: string }) {
  return (
    <div className={`text-sm text-[var(--color-text)]${className ? ` ${className}` : ''}`}>
      <ReactMarkdown remarkPlugins={PLUGINS} components={components} skipHtml urlTransform={urlTransform}>
        {children}
      </ReactMarkdown>
    </div>
  )
}

export const Markdown = memo(MarkdownImpl)
