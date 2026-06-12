import { Fragment, type ReactNode } from 'react';

// Minimal, dependency-free markdown renderer for research bodies. Supports
// headings, bold/italic/code inline, bullet/numbered lists, blockquotes,
// fenced code blocks, horizontal rules and paragraphs. Not a full spec — just
// enough to render LLM-authored research cleanly in the terminal theme.

function renderInline(text: string, keyBase: string): ReactNode[] {
  const out: ReactNode[] = [];
  // Tokenize on `code`, **bold**, *italic*/_italic_ in priority order.
  const re = /(`[^`]+`)|(\*\*[^*]+\*\*)|(\*[^*]+\*)|(_[^_]+_)/g;
  let last = 0;
  let m: RegExpExecArray | null;
  let i = 0;
  while ((m = re.exec(text)) !== null) {
    if (m.index > last) out.push(<Fragment key={`${keyBase}-t${i++}`}>{text.slice(last, m.index)}</Fragment>);
    const tok = m[0];
    if (tok.startsWith('`')) {
      out.push(
        <code key={`${keyBase}-c${i++}`} className="font-mono text-xs text-amber bg-amber/10 border border-amber/20 rounded px-1 py-0.5">
          {tok.slice(1, -1)}
        </code>,
      );
    } else if (tok.startsWith('**')) {
      out.push(<strong key={`${keyBase}-b${i++}`} className="text-text font-semibold">{tok.slice(2, -2)}</strong>);
    } else {
      out.push(<em key={`${keyBase}-i${i++}`} className="text-text-dim italic">{tok.slice(1, -1)}</em>);
    }
    last = m.index + tok.length;
  }
  if (last < text.length) out.push(<Fragment key={`${keyBase}-t${i++}`}>{text.slice(last)}</Fragment>);
  return out;
}

export function Markdown({ source }: { source: string }) {
  const lines = (source || '').replace(/\r\n/g, '\n').split('\n');
  const blocks: ReactNode[] = [];
  let i = 0;
  let key = 0;

  // pending list buffer
  let listItems: { ordered: boolean; text: string }[] = [];
  const flushList = () => {
    if (listItems.length === 0) return;
    const ordered = listItems[0].ordered;
    const items = listItems;
    listItems = [];
    const Tag = ordered ? 'ol' : 'ul';
    blocks.push(
      <Tag
        key={`l${key++}`}
        className={`pl-5 my-2 flex flex-col gap-1 ${ordered ? 'list-decimal' : 'list-disc'} marker:text-muted`}
      >
        {items.map((it, j) => (
          <li key={j} className="text-sm text-text-dim leading-relaxed">
            {renderInline(it.text, `li${key}-${j}`)}
          </li>
        ))}
      </Tag>,
    );
  };

  while (i < lines.length) {
    const line = lines[i];

    // fenced code block
    if (line.trim().startsWith('```')) {
      flushList();
      const buf: string[] = [];
      i++;
      while (i < lines.length && !lines[i].trim().startsWith('```')) {
        buf.push(lines[i]);
        i++;
      }
      i++; // skip closing fence
      blocks.push(
        <pre key={`p${key++}`} className="my-2 p-2.5 rounded bg-bg-2 border border-border overflow-auto">
          <code className="font-mono text-xs text-text-dim whitespace-pre">{buf.join('\n')}</code>
        </pre>,
      );
      continue;
    }

    // headings
    const h = /^(#{1,6})\s+(.*)$/.exec(line);
    if (h) {
      flushList();
      const level = h[1].length;
      const sizes = ['text-base', 'text-base', 'text-sm', 'text-sm', 'text-xs', 'text-xs'];
      blocks.push(
        <div key={`h${key++}`} className={`${sizes[level - 1]} font-semibold text-text mt-3 mb-1 uppercase tracking-wide`}>
          {renderInline(h[2], `h${key}`)}
        </div>,
      );
      i++;
      continue;
    }

    // horizontal rule
    if (/^\s*(-{3,}|\*{3,}|_{3,})\s*$/.test(line)) {
      flushList();
      blocks.push(<hr key={`hr${key++}`} className="my-3 border-border" />);
      i++;
      continue;
    }

    // blockquote
    const bq = /^\s*>\s?(.*)$/.exec(line);
    if (bq) {
      flushList();
      blocks.push(
        <blockquote key={`q${key++}`} className="my-2 border-l-2 border-amber/50 pl-3 text-sm text-text-dim italic">
          {renderInline(bq[1], `q${key}`)}
        </blockquote>,
      );
      i++;
      continue;
    }

    // list items
    const ul = /^\s*[-*+]\s+(.*)$/.exec(line);
    const ol = /^\s*\d+[.)]\s+(.*)$/.exec(line);
    if (ul) {
      listItems.push({ ordered: false, text: ul[1] });
      i++;
      continue;
    }
    if (ol) {
      listItems.push({ ordered: true, text: ol[1] });
      i++;
      continue;
    }

    // blank line
    if (line.trim() === '') {
      flushList();
      i++;
      continue;
    }

    // paragraph (accumulate consecutive non-blank, non-special lines)
    flushList();
    const para: string[] = [line];
    i++;
    while (
      i < lines.length &&
      lines[i].trim() !== '' &&
      !/^(#{1,6})\s+/.test(lines[i]) &&
      !/^\s*[-*+]\s+/.test(lines[i]) &&
      !/^\s*\d+[.)]\s+/.test(lines[i]) &&
      !/^\s*>\s?/.test(lines[i]) &&
      !lines[i].trim().startsWith('```')
    ) {
      para.push(lines[i]);
      i++;
    }
    blocks.push(
      <p key={`pp${key++}`} className="text-sm text-text-dim leading-relaxed my-1.5">
        {renderInline(para.join(' '), `pp${key}`)}
      </p>,
    );
  }
  flushList();

  return <div className="flex flex-col">{blocks}</div>;
}
