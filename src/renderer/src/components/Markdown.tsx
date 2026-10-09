// Markdown shown as readable text. The parser hands back plain data and this
// turns it into elements, so text is always text: no HTML from a file is ever
// interpreted, and a link is shown, never followed (the window would navigate).
import { Fragment, type ReactNode } from 'react';
import { parseMarkdown, type Block, type Inline } from '@shared/markdown';

export function Markdown({ source }: { source: string }) {
  return <div className="prose">{parseMarkdown(source).map((b, i) => <BlockView key={i} block={b} />)}</div>;
}

function BlockView({ block }: { block: Block }) {
  switch (block.t) {
    case 'heading': {
      // The page and the skill's own name hold h1 and h2; the file's headings sit below them.
      const Tag = `h${Math.min(6, block.level + 2)}` as 'h3';
      return <Tag className={`prose-h${block.level}`}>{spans(block.v)}</Tag>;
    }
    case 'paragraph': return <p>{spans(block.v)}</p>;
    case 'code': return <pre className="prose-code" data-lang={block.lang || undefined}><code>{block.v}</code></pre>;
    case 'quote': return <blockquote>{block.v.map((b, i) => <BlockView key={i} block={b} />)}</blockquote>;
    case 'rule': return <hr />;
    case 'table':
      return (
        <div className="prose-table">
          <table>
            <thead><tr>{block.head.map((c, i) => <th key={i}>{spans(c)}</th>)}</tr></thead>
            <tbody>{block.rows.map((r, i) => <tr key={i}>{r.map((c, j) => <td key={j}>{spans(c)}</td>)}</tr>)}</tbody>
          </table>
        </div>
      );
    case 'list': {
      const Tag = block.ordered ? 'ol' : 'ul';
      return (
        <Tag start={block.ordered && block.start !== 1 ? block.start : undefined}>
          {block.items.map((item, i) => (
            <li key={i} className={item.depth ? `depth-${item.depth}` : undefined}>
              {item.task !== null ? <span className={`prose-task${item.task ? ' done' : ''}`} aria-label={item.task ? 'Done' : 'Not done'} role="img" /> : null}
              {spans(item.v)}
            </li>
          ))}
        </Tag>
      );
    }
  }
}

function spans(list: Inline[]): ReactNode {
  return list.map((s, i) => {
    switch (s.t) {
      case 'text': return <Fragment key={i}>{s.v}</Fragment>;
      case 'code': return <code key={i}>{s.v}</code>;
      case 'strong': return <strong key={i}>{spans(s.v)}</strong>;
      case 'em': return <em key={i}>{spans(s.v)}</em>;
      case 'link': return <span key={i} className="prose-link" title={s.href}>{spans(s.v)}</span>;
    }
  });
}
