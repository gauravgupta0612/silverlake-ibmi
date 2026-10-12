// Pure helpers for 2.0: printer file preview, test data, SQL INSERT export, duplicate finder,
// object / member copy commands and IFS search. No vscode import, unit tested.

import { isValidSystemName } from './util';
import { Column, sqlValue } from './dataTransfer';

const NAME = (v: string, what: string): string => {
  const u = v.trim().toUpperCase();
  if (!isValidSystemName(u)) { throw new Error(`"${v}" is not a valid ${what} name.`); }
  return u;
};

// ---------------------------------------------------------------- printer file (PRTF) preview

export interface PrtfItem { record: string; name: string; text: string; col: number; line: number; srcLine: number; field: boolean }

/** Lay out every record format of a PRTF once, in source order, as if printed one after the other. */
export function layoutPrtf(text: string, pageLines = 66, pageCols = 132): { lines: string[]; items: PrtfItem[]; records: string[] } {
  const src = text.split(/\r?\n/);
  type Entry = { kind: 'rec' | 'field' | 'const'; name: string; len: number; type: string; dec?: number; pos: string; kw: string; line: number; edit?: string };
  const entries: Entry[] = []; let cur: Entry | undefined;
  src.forEach((raw, i) => {
    const l = raw.padEnd(80);
    if (!/^.{5}A/i.test(l) || l[6] === '*') { return; }
    const nameType = l[16].toUpperCase(); const name = l.substring(18, 28).trim(); const kw = l.substring(44, 80);
    const posS = l.substring(41, 44).trim(); const lenS = l.substring(29, 34).trim();
    if (cur && !name && !posS && !lenS && nameType === ' ' && !/^\s*'/.test(kw)) { cur.kw += ' ' + kw.trim(); return; }
    if (cur && /[-+]\s*$/.test(cur.kw) && !name && !posS) { cur.kw = cur.kw.replace(/[-+]\s*$/, '') + kw.trim(); return; }
    if (nameType === 'R') { cur = { kind: 'rec', name, len: 0, type: '', pos: '', kw: kw.trim(), line: i }; entries.push(cur); return; }
    if (!entries.some(e => e.kind === 'rec')) { return; } // file-level keywords
    cur = { kind: name ? 'field' : 'const', name, len: Number(lenS) || 0, type: l[34].trim().toUpperCase() || 'A', dec: l.substring(35, 37).trim() ? Number(l.substring(35, 37)) : undefined, pos: posS, kw: kw.trim(), line: i };
    entries.push(cur);
  });
  const page: string[] = Array.from({ length: pageLines }, () => '');
  const items: PrtfItem[] = []; const records: string[] = [];
  let line = 0; let lastEnd = 0; let record = '';
  const num = (kw: string, k: string) => { const m = new RegExp(`\\b${k}\\s*\\(\\s*(\\d+)\\s*\\)`, 'i').exec(kw); return m ? Number(m[1]) : undefined; };
  const move = (kw: string, before: boolean) => {
    const skip = num(kw, before ? 'SKIPB' : 'SKIPA'); const space = num(kw, before ? 'SPACEB' : 'SPACEA');
    if (skip !== undefined) { line = skip; lastEnd = 0; } else if (space !== undefined) { line += space; lastEnd = 0; }
  };
  const write = (col: number, s: string) => {
    if (line < 1 || line > pageLines) { return; }
    const row = page[line - 1].padEnd(col - 1 + s.length);
    page[line - 1] = (row.slice(0, col - 1) + s + row.slice(col - 1 + s.length)).slice(0, pageCols);
  };
  for (const e of entries) {
    if (e.kind === 'rec') {
      if (record) { /* SPACEA/SKIPA of the previous record's last item already applied */ }
      record = e.name; records.push(e.name);
      if (!line) { line = 1; }
      move(e.kw, true);
      continue;
    }
    move(e.kw, true);
    if (!line) { line = 1; }
    let text = '';
    if (e.kind === 'const') {
      const m = /^'((?:[^']|'')*)'/.exec(e.kw); text = m ? m[1].replace(/''/g, "'") : /^DATE\b/i.test(e.kw) ? 'MM/DD/YY' : /^TIME\b/i.test(e.kw) ? 'HH:MM:SS' : /^PAGNBR\b/i.test(e.kw) ? '9999' : '';
    } else {
      text = e.dec !== undefined || /[SPY]/.test(e.type)
        ? `${'9'.repeat(Math.max(1, e.len - (e.dec ?? 0)))}${e.dec ? '.' + '9'.repeat(e.dec) : ''}`
        : 'X'.repeat(e.len);
    }
    const col = e.pos.startsWith('+') ? lastEnd + 1 + Number(e.pos.slice(1)) : Number(e.pos) || lastEnd + 2;
    write(col, text);
    items.push({ record, name: e.name, text, col, line, srcLine: e.line, field: e.kind === 'field' });
    lastEnd = col + text.length - 1;
    move(e.kw, false);
  }
  let last = page.length; while (last > 0 && !page[last - 1].trim()) { last--; }
  return { lines: page.slice(0, Math.max(last, 1)), items, records };
}

// ---------------------------------------------------------------- test data

/** Small deterministic random generator (so a preview and the insert give the same rows). */
export function seeded(seed: number): () => number {
  let x = seed >>> 0 || 1;
  return () => { x ^= x << 13; x >>>= 0; x ^= x >>> 17; x ^= x << 5; x >>>= 0; return x / 4294967296; };
}

const WORDS = ['ALPHA', 'BRAVO', 'DELTA', 'ECHO', 'NORTH', 'SOUTH', 'PARIS', 'LYON', 'BERLIN', 'MADRID', 'ROMA', 'OSLO', 'ACME', 'GLOBEX', 'INITECH', 'UMBRELLA'];

/** Generated rows for a table: keys continue after `startKey`, other values fit each column's type. */
export function testRows(cols: (Column & { pk?: boolean })[], count: number, startKey = 0, seed = 42): (string | null)[][] {
  const rnd = seeded(seed); const rows: (string | null)[][] = [];
  const pkNumeric = cols.filter(c => c.pk && /DEC|NUM|INT/i.test(c.type));
  for (let n = 1; n <= count; n++) {
    rows.push(cols.map(c => {
      const t = c.type.toUpperCase();
      if (c.pk && pkNumeric.includes(c)) { return String(startKey + n); }
      if (c.nullable && !c.pk && rnd() < 0.05) { return null; }
      if (/^(DECIMAL|NUMERIC)$/.test(t)) {
        const intDigits = Math.max(0, c.length - c.scale); const max = Math.min(10 ** Math.min(intDigits, 9) - 1, 99999);
        const v = rnd() * max; return c.scale ? v.toFixed(Math.min(c.scale, 2)) : String(Math.floor(v));
      }
      if (/INT/.test(t)) { return String(Math.floor(rnd() * (t === 'SMALLINT' ? 30000 : 100000))); }
      if (/FLOAT|DOUBLE|REAL|DECFLOAT/.test(t)) { return (rnd() * 1000).toFixed(3); }
      if (t === 'DATE') { const d = new Date(Date.UTC(2020, 0, 1) + Math.floor(rnd() * 2400) * 86400000); return d.toISOString().slice(0, 10); }
      if (/TIMESTAMP|TIMESTMP/.test(t)) { const d = new Date(Date.UTC(2020, 0, 1) + Math.floor(rnd() * 2400 * 86400) * 1000); return d.toISOString().replace('T', ' ').slice(0, 19); }
      if (t === 'TIME') { return `${String(Math.floor(rnd() * 24)).padStart(2, '0')}:${String(Math.floor(rnd() * 60)).padStart(2, '0')}:00`; }
      if (/CHAR|GRAPHIC|CLOB/.test(t)) {
        const base = c.pk ? `T${String(startKey + n).padStart(Math.min(6, Math.max(1, c.length - 1)), '0')}` : `${WORDS[Math.floor(rnd() * WORDS.length)]} ${n}`;
        return base.slice(0, Math.max(1, Math.min(c.length, 60)));
      }
      return null;
    }));
  }
  return rows;
}

// ---------------------------------------------------------------- SQL INSERT export

/** A script of INSERT statements for rows already read from a table. */
export function insertScript(library: string, table: string, cols: Column[], rows: Record<string, unknown>[]): string {
  const names = cols.map(c => `"${c.name.replace(/"/g, '""')}"`).join(', ');
  const out = [`-- ${rows.length} row(s) of ${library}/${table}, exported by Vanthrex for IBM i`];
  for (const r of rows) {
    out.push(`INSERT INTO ${library}/${table} (${names}) VALUES (${cols.map(c => {
      const v = r[c.name];
      if (v === null || v === undefined) { return 'NULL'; }
      try { return sqlValue(typeof v === 'string' ? v.trimEnd() || ' ' : String(v), { ...c, nullable: true, length: Math.max(c.length, String(v).length) }); } catch { return `'${String(v).replace(/'/g, "''")}'`; }
    }).join(', ')});`);
  }
  return out.join('\n') + '\n';
}

// ---------------------------------------------------------------- duplicates

export function duplicatesSql(library: string, table: string, keys: string[], limit = 500): string {
  if (!keys.length) { throw new Error('Pick at least one column.'); }
  const k = keys.map(c => `"${c.replace(/"/g, '""')}"`).join(', ');
  return `SELECT ${k}, COUNT(*) AS "COPIES" FROM ${NAME(library, 'library')}/${NAME(table, 'table')} GROUP BY ${k} HAVING COUNT(*) > 1 ORDER BY COUNT(*) DESC FETCH FIRST ${limit} ROWS ONLY`;
}

// ---------------------------------------------------------------- copy / move / rename

export function crtdupobjCommand(fromLib: string, name: string, type: string, toLib: string, newName?: string, data = false): string {
  const t = type.toUpperCase();
  return `CRTDUPOBJ OBJ(${NAME(name, 'object')}) FROMLIB(${NAME(fromLib, 'library')}) OBJTYPE(${t}) TOLIB(${NAME(toLib, 'library')})` +
    `${newName && newName.toUpperCase() !== name.toUpperCase() ? ` NEWOBJ(${NAME(newName, 'object')})` : ''}${t === '*FILE' ? ` DATA(${data ? '*YES' : '*NO'})` : ''}`;
}

export function moveCommand(lib: string, name: string, type: string, toLib: string): string {
  return `MOVOBJ OBJ(${NAME(lib, 'library')}/${NAME(name, 'object')}) OBJTYPE(${type.toUpperCase()}) TOLIB(${NAME(toLib, 'library')})`;
}

export function renameCommand(lib: string, name: string, type: string, newName: string): string {
  return `RNMOBJ OBJ(${NAME(lib, 'library')}/${NAME(name, 'object')}) OBJTYPE(${type.toUpperCase()}) NEWOBJ(${NAME(newName, 'object')})`;
}

/** CPYSRCF keeps sequence numbers and dates; MBROPT(*ADD) refuses to overwrite. */
export function cpysrcfCommand(fromLib: string, fromFile: string, member: string, toLib: string, toFile: string, replace: boolean, newName?: string): string {
  return `CPYSRCF FROMFILE(${NAME(fromLib, 'library')}/${NAME(fromFile, 'file')}) TOFILE(${NAME(toLib, 'library')}/${NAME(toFile, 'file')}) FROMMBR(${NAME(member, 'member')})` +
    ` TOMBR(${newName ? NAME(newName, 'member') : '*FROMMBR'}) MBROPT(${replace ? '*REPLACE' : '*ADD'})`;
}

// ---------------------------------------------------------------- IFS search

const shq = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;

/** find + grep over an IFS folder (PASE grep has no -r --include, so find picks the files). */
export function ifsGrepCommand(folder: string, text: string, opts: { regex?: boolean; matchCase?: boolean; include?: string; max?: number } = {}): string {
  if (!text) { throw new Error('Enter the text to find.'); }
  if (!folder.startsWith('/')) { throw new Error('The folder must be an absolute IFS path.'); }
  const flags = `-n${opts.regex ? 'E' : 'F'}${opts.matchCase ? '' : 'i'}`;
  const name = opts.include?.trim() ? ` -name ${shq(opts.include.trim())}` : '';
  return `/QOpenSys/usr/bin/find ${shq(folder)} -type f${name} -exec /QOpenSys/usr/bin/grep ${flags} -e ${shq(text)} /dev/null {} + 2>/dev/null | /QOpenSys/usr/bin/head -n ${Math.max(1, opts.max ?? 1000)}`;
}

export function parseGrep(out: string): { file: string; line: number; text: string }[] {
  return out.split('\n').map(l => /^(.+?):(\d+):(.*)$/.exec(l)).filter((m): m is RegExpExecArray => !!m).map(m => ({ file: m[1], line: Number(m[2]), text: m[3] }));
}
