import { type CSSProperties, type ReactNode } from 'react';

// Lightweight renderer for an agent reasoning step's text: pretty-prints fenced
// ```json``` blocks in a code box and renders **bold**, `inline code`, and "- "
// bullets — so the logs panel reads cleanly instead of showing raw markdown +
// a wrapped JSON blob. Deliberately tiny (no markdown dependency).

const codeBox: CSSProperties = {
  margin: '6px 0',
  padding: '8px 10px',
  background: 'var(--bg-surface)',
  border: '1px solid var(--border)',
  borderRadius: 4,
  fontFamily: 'var(--font-mono), monospace',
  fontSize: '0.68rem',
  lineHeight: 1.5,
  color: 'var(--text-secondary)',
  whiteSpace: 'pre',
  overflowX: 'auto',
  maxHeight: 260,
  overflowY: 'auto',
};

const inlineCode: CSSProperties = {
  fontFamily: 'var(--font-mono), monospace',
  fontSize: '0.92em',
  background: 'var(--bg-surface)',
  border: '1px solid var(--border)',
  borderRadius: 3,
  padding: '0 4px',
};

/** Render **bold** and `inline code` within a line. */
function renderInline(text: string, key: string): ReactNode[] {
  return text.split(/(\*\*[^*]+\*\*|`[^`]+`)/g).map((part, i) => {
    if (!part) return null;
    if (part.startsWith('**') && part.endsWith('**')) {
      return (
        <strong key={`${key}-${i}`} style={{ color: 'var(--text-primary)', fontWeight: 600 }}>
          {part.slice(2, -2)}
        </strong>
      );
    }
    if (part.startsWith('`') && part.endsWith('`')) {
      return (
        <code key={`${key}-${i}`} style={inlineCode}>
          {part.slice(1, -1)}
        </code>
      );
    }
    return <span key={`${key}-${i}`}>{part}</span>;
  });
}

/** Render a prose segment: group "- " lines into a list, others into lines. */
function Prose({ text, k }: { text: string; k: string }) {
  const lines = text.split('\n');
  const blocks: ReactNode[] = [];
  let bullets: string[] = [];
  const flush = () => {
    if (!bullets.length) return;
    const at = blocks.length;
    blocks.push(
      <ul key={`${k}-ul${at}`} style={{ margin: '4px 0', paddingLeft: 16, display: 'flex', flexDirection: 'column', gap: 3 }}>
        {bullets.map((b, bi) => (
          <li key={bi} style={{ lineHeight: 1.5 }}>
            {renderInline(b, `${k}-li${at}-${bi}`)}
          </li>
        ))}
      </ul>,
    );
    bullets = [];
  };
  lines.forEach((ln, li) => {
    const t = ln.trim();
    if (/^[-*]\s+/.test(t)) {
      bullets.push(t.replace(/^[-*]\s+/, ''));
    } else {
      flush();
      if (t) {
        blocks.push(
          <p key={`${k}-p${li}`} style={{ margin: '2px 0', lineHeight: 1.5 }}>
            {renderInline(t, `${k}-p${li}`)}
          </p>,
        );
      }
    }
  });
  flush();
  return <>{blocks}</>;
}

function prettyIfJson(body: string): string {
  const t = body.trim();
  try {
    return JSON.stringify(JSON.parse(t), null, 2);
  } catch {
    return t;
  }
}

export default function TraceContent({ content }: { content: string }) {
  // Split on ```lang\n...``` fences (capturing lang + body).
  const parts = content.split(/```(\w*)\r?\n?([\s\S]*?)```/g);
  const out: ReactNode[] = [];
  for (let i = 0; i < parts.length; i++) {
    const mod = i % 3;
    if (mod === 0) {
      if (parts[i] && parts[i].trim()) out.push(<Prose key={`pr${i}`} text={parts[i]} k={`pr${i}`} />);
    } else if (mod === 2) {
      const lang = parts[i - 1];
      const body = parts[i] ?? '';
      const isJson = lang === 'json' || /^\s*[[{]/.test(body);
      out.push(
        <pre key={`code${i}`} style={codeBox}>
          {isJson ? prettyIfJson(body) : body.trim()}
        </pre>,
      );
    }
  }
  return <div style={{ color: 'var(--text-secondary)', fontSize: '0.75rem' }}>{out}</div>;
}
