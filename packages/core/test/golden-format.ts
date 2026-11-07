import type { ClassDiagram, Message, SequenceDiagram } from '@seqcall/protocol';

/**
 * A diagram as stable text for the golden tests: what the editors draw (participants, calls with their labels,
 * frames, exit markers, I/O, issues), without file positions — editing a fixture moves lines, not the flow.
 */
export function sequenceText(d: SequenceDiagram): string {
  const name = new Map(d.participants.map((p) => [p.id, p.label]));
  const out: string[] = [];
  out.push(`participants: ${d.participants.map((p) => `${p.label}${p.stereotypes.length ? ` «${p.stereotypes.join(', ')}»` : ''}${p.layer ? ` [${p.layer}]` : ''}${p.objects?.length ? ` {${p.objects.map((o) => o.label).join(', ')}}` : ''}`).join(' | ')}`);
  const fragmentsAt = new Map<string, string[]>();
  for (const f of d.fragments ?? []) {
    const ops = f.operands.map((o) => `${o.guard ?? ''}${o.outcome ? ` → ${o.outcome}` : ''}${o.swallowed ? ' (swallowed)' : ''}`).join(' / ');
    const line = `${f.kind}${ops.trim() ? ` [${ops}]` : ''}${f.collapsed ? ` (minimized, ${f.hiddenCount ?? 0} hidden)` : ''}`;
    const first = f.operands[0]?.firstMessageId ?? f.ownerMessageId;
    fragmentsAt.set(first, [...(fragmentsAt.get(first) ?? []), line]);
  }
  // an exit marker before the call it precedes (else after its owner), naming the method it leaves
  const method = new Map(d.messages.map((m) => [m.id, m.methodName]));
  const exitsAfter = new Map<string, string[]>();
  for (const x of d.exits ?? []) {
    const at = x.beforeId ?? x.ownerMessageId;
    exitsAfter.set(at, [...(exitsAfter.get(at) ?? []), `↯ ${x.kind}${x.guard ? ` [${x.guard}]` : ''}${x.exception ? ` ${x.exception}` : ''} (leaves ${method.get(x.ownerMessageId) ?? x.ownerMessageId})`]);
  }
  for (const m of d.messages) {
    const pad = '  '.repeat(m.depth);
    for (const f of fragmentsAt.get(m.id) ?? []) out.push(`${pad}┌ ${f}`);
    for (const x of exitsAfter.get(m.id) ?? []) out.push(`${pad}${x}`);
    out.push(`${pad}${messageText(m, name)}`);
  }
  for (const f of d.findings ?? []) out.push(`⚠ ${f.kind}: ${f.title}`);
  if (d.issuesBelow) out.push(`⚠ below: ${JSON.stringify(d.issuesBelow)}`);
  if (d.expandNotice) out.push(`notice: ${d.expandNotice.reason}, ${d.expandNotice.folded} folded`);
  return out.join('\n');
}

function messageText(m: Message, name: Map<string, string>): string {
  const from = m.from === null ? '·' : (name.get(m.from) ?? m.from);
  const to = name.get(m.to) ?? m.to;
  const flags = [
    m.isAsync && 'async',
    m.isLibrary && 'lib',
    m.recursive && 'recursive',
    m.expandable && (m.expanded ? '⊖' : '⊕'),
    m.unresolved && `unresolved: ${m.unresolved}`,
    m.polymorphic && `impls: ${m.polymorphic.implementations.map((i) => i.name).join(', ')}${m.polymorphic.selectedKey ? ` → ${m.polymorphic.implementations.find((i) => i.key === m.polymorphic!.selectedKey)?.name ?? m.polymorphic.selectedKey}` : ''}`,
    m.sideEffects && `I/O: ${m.sideEffects.kinds.join(', ')}${m.sideEffects.below ? ' (below)' : ''}`,
    m.result && (m.result.kind === 'return' ? 'returned' : `${m.result.target} ${m.result.operator}`),
    m.viaParameter && `via ${m.viaParameter}`,
    m.alternative && `alt ${m.alternative.index + 1}/${m.alternative.count} (${m.alternative.why})`,
  ].filter(Boolean);
  return `${m.kind} ${from} → ${to}: ${m.methodName}(${m.args.join(', ')})${flags.length ? `  ${flags.join(' · ')}` : ''}`;
}

export function classText(d: ClassDiagram): string {
  const name = new Map(d.classes.map((c) => [c.key, c.name]));
  return [
    ...d.classes.map((c) => `class ${c.name}${c.stereotypes.length ? ` «${c.stereotypes.join(', ')}»` : ''}${c.layer ? ` [${c.layer}]` : ''}${c.sideEffects ? ` I/O: ${c.sideEffects.kinds.join(', ')}` : ''}: ${c.methods.map((m) => m.name).join(', ')}`),
    ...d.relations.map((r) => `${r.kind} ${name.get(r.from) ?? r.from} → ${name.get(r.to) ?? r.to}${r.label && !r.labelObvious ? ` "${r.label}"` : ''}${r.violation ? ` VIOLATION ${r.violation}` : ''}`),
  ].join('\n');
}
