// Objects out of sync with their source, and change reports. Pure functions (no vscode import), unit tested.

export type SyncStatus = 'source newer' | 'source missing' | 'no source info' | 'in sync';

/** Compare the source date recorded in an object at compile time with the member's current date. */
export function syncStatus(o: { sourceFile?: string; sourceMember?: string; compiledFrom?: string; memberChanged?: string; memberExists: boolean }, toleranceSeconds = 2): SyncStatus {
  if (!o.sourceFile || !o.sourceMember) { return 'no source info'; }
  if (!o.memberExists) { return 'source missing'; }
  if (!o.compiledFrom || !o.memberChanged) { return 'no source info'; }
  const a = Date.parse(o.compiledFrom.replace(' ', 'T')); const b = Date.parse(o.memberChanged.replace(' ', 'T'));
  if (isNaN(a) || isNaN(b)) { return 'no source info'; }
  return b - a > toleranceSeconds * 1000 ? 'source newer' : 'in sync';
}

export interface ChangeItem { kind: 'object' | 'member'; name: string; type: string; where: string; changed: string; text?: string }

/** Markdown release notes from what changed in a library. */
export function changeReportMarkdown(library: string, sinceDays: number, items: ChangeItem[], today = new Date()): string {
  const day = today.toISOString().slice(0, 10);
  const out = [`# Changes in ${library} — last ${sinceDays} day(s)`, '', `*Generated ${day} by Vanthrex for IBM i.*`, ''];
  const members = items.filter(i => i.kind === 'member'); const objects = items.filter(i => i.kind === 'object');
  out.push(`## Source members (${members.length})`, '');
  if (members.length) { out.push('| Member | Type | Source file | Changed | Description |', '|---|---|---|---|---|', ...members.map(m => `| ${m.name} | ${m.type} | ${m.where} | ${m.changed} | ${(m.text ?? '').replace(/\|/g, '\\|')} |`)); } else { out.push('None.'); }
  out.push('', `## Objects (${objects.length})`, '');
  if (objects.length) { out.push('| Object | Type | Changed | Description |', '|---|---|---|---|', ...objects.map(o => `| ${o.name} | ${o.type} | ${o.changed} | ${(o.text ?? '').replace(/\|/g, '\\|')} |`)); } else { out.push('None.'); }
  return out.join('\n') + '\n';
}
