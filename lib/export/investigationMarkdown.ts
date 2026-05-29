import type { Diagnosis, Recommendation } from '@/lib/mcp/types';
import type { TraceItem } from '@/components/investigation/ReasoningTrace';
import { impactRange } from '@/lib/insights/derive';

interface InvestigationData {
  items: TraceItem[];
  diagnosis: Diagnosis | null;
  recommendations: Recommendation[];
}

/** Render a full investigation (trace + diagnosis + recommendations) as
 *  Markdown for export. Shared by the step-2 and step-3 pages. */
export function investigationToMarkdown(id: string, { items, diagnosis, recommendations }: InvestigationData): string {
  const lines: string[] = [];
  lines.push(`# investigation: ${id}`, '');

  lines.push('## reasoning trace');
  if (items.length === 0) {
    lines.push('- (no trace)');
  } else {
    for (const it of items) {
      if (it.kind === 'step') lines.push(`- [${it.agent}/${it.stepKind}] ${it.content}`);
      else lines.push(`- tool: ${it.toolName} (${it.durationMs ?? 0}ms)`);
    }
  }
  lines.push('');

  lines.push('## diagnosis');
  if (diagnosis) {
    lines.push(diagnosis.conclusion);
    if (diagnosis.evidence.length > 0) {
      lines.push('', '**evidence**');
      for (const e of diagnosis.evidence) lines.push(`- ${e}`);
    }
    if (diagnosis.hypothesesConsidered.length > 0) {
      lines.push('', '**hypotheses considered**');
      for (const h of diagnosis.hypothesesConsidered) {
        lines.push(`- [${h.supported ? 'supported' : 'ruled out'}] ${h.hypothesis} — ${h.reasoning}`);
      }
    }
  } else {
    lines.push('(no diagnosis)');
  }
  lines.push('');

  lines.push('## recommendations');
  if (recommendations.length === 0) {
    lines.push('(no recommendations)');
  } else {
    for (const r of recommendations) {
      lines.push(`### ${r.title}  (${r.bloomreachFeature} · ${r.confidence})`);
      lines.push(r.rationale);
      if (r.steps.length > 0) {
        lines.push('steps:');
        r.steps.forEach((s, i) => lines.push(`${i + 1}. ${s}`));
      }
      lines.push(`impact: ${impactRange(r.estimatedImpact)}`, '');
    }
  }

  return lines.join('\n');
}

/** Trigger a client-side download of a markdown file. */
export function downloadMarkdown(filename: string, md: string): void {
  const blob = new Blob([md], { type: 'text/markdown' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}
