// Compare the structure of two tables and write the ALTER script. Pure functions (no vscode import), unit tested.
import { isValidSystemName } from './util';

const NAME = (v: string, what: string): string => {
  const u = v.trim().toUpperCase();
  if (!isValidSystemName(u)) { throw new Error(`"${v}" is not a valid ${what} name.`); }
  return u;
};

export interface ColDef { name: string; type: string; length: number; scale: number; nullable: boolean; dflt?: string; text?: string }

export interface StructDiff { column: string; status: 'only in A' | 'only in B' | 'different'; a?: string; b?: string }

const desc = (c: ColDef) => `${c.type}${/CHAR|DECIMAL|NUMERIC|GRAPHIC|BINARY/i.test(c.type) ? `(${c.length}${/DECIMAL|NUMERIC/i.test(c.type) ? `,${c.scale}` : ''})` : ''}${c.nullable ? '' : ' NOT NULL'}${c.dflt ? ` DEFAULT ${c.dflt}` : ''}`;

export function compareStructure(a: ColDef[], b: ColDef[]): StructDiff[] {
  const mb = new Map(b.map(c => [c.name.toUpperCase(), c]));
  const out: StructDiff[] = [];
  for (const c of a) {
    const o = mb.get(c.name.toUpperCase());
    if (!o) { out.push({ column: c.name, status: 'only in A', a: desc(c) }); continue; }
    mb.delete(c.name.toUpperCase());
    if (desc(c) !== desc(o)) { out.push({ column: c.name, status: 'different', a: desc(c), b: desc(o) }); }
  }
  for (const o of mb.values()) { out.push({ column: o.name, status: 'only in B', b: desc(o) }); }
  return out;
}

/** ALTER TABLE statements that would make B look like A (columns only; review before running). */
export function alterScript(libB: string, table: string, a: ColDef[], diffs: StructDiff[]): string {
  const t = `${NAME(libB, 'library')}/${NAME(table, 'table')}`;
  const byName = new Map(a.map(c => [c.name.toUpperCase(), c]));
  const out = [`-- Make ${t} match the other copy. Review before running: dropping columns loses data.`];
  for (const d of diffs) {
    const c = byName.get(d.column.toUpperCase());
    const col = `"${d.column.replace(/"/g, '""')}"`;
    if (d.status === 'only in A' && c) { out.push(`ALTER TABLE ${t} ADD COLUMN ${col} ${desc(c)};`); }
    if (d.status === 'different' && c) {
      const typ = desc({ ...c, nullable: true, dflt: undefined });
      out.push(`ALTER TABLE ${t} ALTER COLUMN ${col} SET DATA TYPE ${typ};`);
      out.push(`ALTER TABLE ${t} ALTER COLUMN ${col} ${c.nullable ? 'DROP NOT NULL' : 'SET NOT NULL'};`);
      if (c.dflt) { out.push(`ALTER TABLE ${t} ALTER COLUMN ${col} SET DEFAULT ${c.dflt};`); }
    }
    if (d.status === 'only in B') { out.push(`-- ALTER TABLE ${t} DROP COLUMN ${col};   -- only in this copy: remove the comment to drop it`); }
  }
  return out.join('\n') + '\n';
}
