// Data and system checks: a profile of a table's columns, rows whose parent is missing, columns close to the largest
// value they can hold, objects nobody used for a long time, program attributes that matter for security, objects hidden
// by another of the same name earlier in the library list, the job schedule for the next days, and statistics of
// repeated SQL runs. Pure (no vscode import), unit tested.

type Row = Record<string, unknown>;
const s = (r: Row, ...keys: string[]) => { for (const k of keys) { const v = r[k]; if (v !== undefined && v !== null && String(v).trim() !== '') { return String(v).trim(); } } return ''; };
const n = (r: Row, ...keys: string[]) => Number(s(r, ...keys)) || 0;
const IDENT = /^[A-Z$#@_][A-Z0-9$#@_]{0,127}$/;

/** A column or table name for generated SQL: plain when it can be, quoted otherwise. */
export function ident(name: string): string {
  const t = name.trim();
  if (IDENT.test(t)) { return t; }
  if (/^"[^"]+"$/.test(t)) { return t; }
  return `"${t.replace(/"/g, '""')}"`;
}

export function qualified(schema: string, table: string): string { return `${ident(schema)}.${ident(table)}`; }

// ---------------------------------------------------------------- profile

export interface ProfileColumn { name: string; type: string; length: number; scale: number; nullable: boolean }
export interface ColumnProfile { name: string; type: string; total: number; nulls: number; distinct: number; min: string; max: string; flags: string[] }

const NO_MINMAX = /LOB|XML|BINARY|GRAPHIC|DATALINK|ROWID|BLOB|CLOB/i;

/** One SELECT per group of 25 columns: count, nulls, distinct values, smallest and largest. */
export function profileSql(table: string, cols: ProfileColumn[], sample?: number): string[] {
  const out: string[] = [];
  const from = sample ? `(SELECT * FROM ${table} FETCH FIRST ${Math.floor(sample)} ROWS ONLY) X` : `${table} X`;
  for (let i = 0; i < cols.length; i += 25) {
    const part = cols.slice(i, i + 25);
    const exprs = ['COUNT(*) AS T', ...part.flatMap((c, j) => {
      const k = i + j; const id = `X.${ident(c.name)}`;
      if (/LOB|XML|DATALINK/i.test(c.type)) { return [`COUNT(${id}) AS N${k}`]; }
      const base = [`COUNT(${id}) AS N${k}`, `COUNT(DISTINCT ${id}) AS D${k}`];
      return NO_MINMAX.test(c.type) ? base : [...base, `VARCHAR(MIN(${id})) AS L${k}`, `VARCHAR(MAX(${id})) AS H${k}`];
    })];
    out.push(`SELECT ${exprs.join(', ')} FROM ${from}`);
  }
  return out;
}

export function readProfile(rows: Row[], cols: ProfileColumn[]): ColumnProfile[] {
  const all: Row = Object.assign({}, ...rows);
  const total = n(all, 'T');
  return cols.map((c, k) => {
    const nonNull = n(all, `N${k}`); const distinct = n(all, `D${k}`);
    const p: ColumnProfile = { name: c.name, type: c.type, total, nulls: total - nonNull, distinct, min: s(all, `L${k}`), max: s(all, `H${k}`), flags: [] };
    if (total && !nonNull) { p.flags.push('always null'); }
    else if (total && distinct === 1) { p.flags.push(`single value${p.min === '' ? ' (blank)' : ''}`); }
    if (total > 1 && distinct === total) { p.flags.push('unique (key candidate)'); }
    if (total && p.nulls / total >= 0.9 && nonNull) { p.flags.push('mostly null'); }
    if (/CHAR/i.test(c.type) && total && p.min === '' && distinct > 1) { p.flags.push('has blanks'); }
    if (/DATE|TIMESTAMP/i.test(c.type) && /^0001-01-01|^9999-12-31/.test(p.min + p.max)) { p.flags.push('dummy dates (0001-01-01 / 9999-12-31)'); }
    return p;
  });
}

export function topValuesSql(table: string, column: string, max = 15): string {
  return `SELECT VARCHAR(${ident(column)}) AS V, COUNT(*) AS C FROM ${table} GROUP BY ${ident(column)} ORDER BY 2 DESC FETCH FIRST ${Math.max(1, Math.min(100, max))} ROWS ONLY`;
}

// ---------------------------------------------------------------- orphan rows

export interface ForeignKey { name: string; child: string; childCols: string[]; parent: string; parentCols: string[] }

export function foreignKeysSql(schema: string, table: string): string {
  const q = (x: string) => `'${x.replace(/'/g, "''")}'`;
  return 'SELECT R.CONSTRAINT_NAME AS FK, K.TABLE_SCHEMA AS CS, K.TABLE_NAME AS CT, K.COLUMN_NAME AS CC, P.TABLE_SCHEMA AS PS, P.TABLE_NAME AS PT, P.COLUMN_NAME AS PC, K.ORDINAL_POSITION AS O ' +
    'FROM QSYS2.SYSREFCST R JOIN QSYS2.SYSKEYCST K ON K.CONSTRAINT_SCHEMA = R.CONSTRAINT_SCHEMA AND K.CONSTRAINT_NAME = R.CONSTRAINT_NAME ' +
    'JOIN QSYS2.SYSKEYCST P ON P.CONSTRAINT_SCHEMA = R.UNIQUE_CONSTRAINT_SCHEMA AND P.CONSTRAINT_NAME = R.UNIQUE_CONSTRAINT_NAME AND P.ORDINAL_POSITION = K.ORDINAL_POSITION ' +
    `WHERE K.TABLE_SCHEMA = ${q(schema)} AND K.TABLE_NAME = ${q(table)} ORDER BY 1, 8`;
}

export function foreignKeys(rows: Row[]): ForeignKey[] {
  const m = new Map<string, ForeignKey>();
  for (const r of rows) {
    const k = s(r, 'FK');
    const fk = m.get(k) ?? { name: k, child: qualified(s(r, 'CS'), s(r, 'CT')), childCols: [], parent: qualified(s(r, 'PS'), s(r, 'PT')), parentCols: [] };
    fk.childCols.push(s(r, 'CC')); fk.parentCols.push(s(r, 'PC'));
    m.set(k, fk);
  }
  return [...m.values()];
}

/** Child rows whose key has no parent row (NULL keys are not orphans), grouped by key value. */
export function orphanSql(fk: Pick<ForeignKey, 'child' | 'childCols' | 'parent' | 'parentCols'>, max = 200): { count: string; rows: string } {
  if (!fk.childCols.length || fk.childCols.length !== fk.parentCols.length) { throw new Error('The child and parent need the same number of columns.'); }
  const cc = fk.childCols.map(c => `C.${ident(c)}`);
  const cond = `NOT EXISTS (SELECT 1 FROM ${fk.parent} P WHERE ${fk.childCols.map((c, i) => `P.${ident(fk.parentCols[i])} = C.${ident(c)}`).join(' AND ')})` +
    ` AND ${cc.map(c => `${c} IS NOT NULL`).join(' AND ')}`;
  return {
    count: `SELECT COUNT(*) AS N FROM ${fk.child} C WHERE ${cond}`,
    rows: `SELECT ${cc.join(', ')}, COUNT(*) AS ROWS_ FROM ${fk.child} C WHERE ${cond} GROUP BY ${cc.join(', ')} ORDER BY ROWS_ DESC FETCH FIRST ${max} ROWS ONLY`,
  };
}

// ---------------------------------------------------------------- capacity

/** The largest absolute value a numeric column can hold, or the length of a character column. */
export function typeLimit(c: ProfileColumn): number | undefined {
  const t = c.type.toUpperCase();
  if (t === 'SMALLINT') { return 32767; }
  if (t === 'INTEGER' || t === 'INT') { return 2147483647; }
  if (t === 'BIGINT') { return 9223372036854775807; }
  if (/DECIMAL|NUMERIC/.test(t)) { return 10 ** (c.length - c.scale) - 10 ** -c.scale; }
  if (/^(VAR)?CHAR/.test(t) || t === 'CHARACTER' || t === 'CHARACTER VARYING') { return c.length; }
  return undefined;
}

export function capacitySql(table: string, cols: ProfileColumn[]): string | undefined {
  const use = cols.filter(c => typeLimit(c) !== undefined);
  if (!use.length) { return undefined; }
  return `SELECT ${use.map((c, i) => (/CHAR/i.test(c.type) ? `MAX(LENGTH(RTRIM(${ident(c.name)}))) AS M${i}` : `MAX(ABS(${ident(c.name)})) AS M${i}`)).join(', ')} FROM ${table}`;
}

export interface Capacity { name: string; type: string; limit: number; max: number; pct: number; level: 'full' | 'high' | 'ok' }

export function capacity(row: Row, cols: ProfileColumn[], warnAt = 0.8): Capacity[] {
  const use = cols.filter(c => typeLimit(c) !== undefined);
  return use.map((c, i) => {
    const limit = typeLimit(c)!; const max = Number(s(row, `M${i}`)) || 0;
    const pct = limit ? max / limit : 0;
    return { name: c.name, type: /DECIMAL|NUMERIC/i.test(c.type) ? `${c.type}(${c.length}, ${c.scale})` : /CHAR/i.test(c.type) ? `${c.type}(${c.length})` : c.type, limit, max, pct,
      level: pct >= 0.999 ? 'full' as const : pct >= warnAt ? 'high' as const : 'ok' as const };
  }).sort((a, b) => b.pct - a.pct);
}

// ---------------------------------------------------------------- unused objects

export interface UnusedObject { name: string; type: string; attribute: string; size: number; created: string; lastUsed: string; daysUsed: number; text: string }

export function unusedObjectsSql(lib: string): string {
  return `SELECT OBJNAME AS N, OBJTYPE AS T, COALESCE(OBJATTRIBUTE, '') AS A, OBJSIZE AS S, VARCHAR(OBJCREATED) AS C, VARCHAR(LAST_USED_TIMESTAMP) AS U, ` +
    `COALESCE(DAYS_USED_COUNT, 0) AS D, COALESCE(OBJTEXT, '') AS X FROM TABLE(QSYS2.OBJECT_STATISTICS('${lib.replace(/'/g, "''")}', '*ALL')) O`;
}

/** Objects not used (or never used) for `days` days, created before that, biggest first. Types whose use is not counted are left out. */
export function unusedObjects(rows: Row[], now: Date, days = 365): UnusedObject[] {
  const limit = new Date(now.getTime() - days * 86400000).toISOString().slice(0, 10);
  const day = (x: string) => x.replace('T', ' ').slice(0, 10);
  return rows.map(r => ({ name: s(r, 'N'), type: s(r, 'T'), attribute: s(r, 'A'), size: n(r, 'S'), created: day(s(r, 'C')), lastUsed: day(s(r, 'U')), daysUsed: n(r, 'D'), text: s(r, 'X') }))
    .filter(o => !/^\*(JRNRCV|JRN|LIB|MSGQ|OUTQ|USRPRF|DTAQ|SBSD|JOBQ|CLS|AUTL)$/.test(o.type) && o.created && o.created < limit && (!o.lastUsed || o.lastUsed < limit))
    .sort((a, b) => b.size - a.size);
}

// ---------------------------------------------------------------- program attributes

export interface ProgramFinding { library: string; program: string; type: string; level: 'high' | 'medium' | 'info'; finding: string; fix: string }

/** Security-relevant attributes from QSYS2.PROGRAM_INFO: adopted authority (and whose), callers' adopted authority, old target release, dynamic SQL as the owner. */
export function programFindings(rows: Row[], powerful: Set<string>, currentRelease = ''): ProgramFinding[] {
  const out: ProgramFinding[] = [];
  const rel = (x: string) => { const m = /V(\d+)R(\d+)/.exec(x); return m ? +m[1] * 10 + +m[2] : 0; };
  for (const r of rows) {
    const library = s(r, 'PROGRAM_LIBRARY'); const program = s(r, 'PROGRAM_NAME'); const type = s(r, 'OBJECT_TYPE');
    const owner = s(r, 'PROGRAM_OWNER'); const adopt = s(r, 'USER_PROFILE') === '*OWNER';
    const base = { library, program, type };
    if (adopt && (owner === 'QSECOFR' || powerful.has(owner))) {
      out.push({ ...base, level: 'high', finding: `Runs with the authority of ${owner}${owner === 'QSECOFR' ? '' : ' (*ALLOBJ)'} for whoever calls it.`, fix: `Change the owner to a profile with only the authority needed (CHGOBJOWN), or USRPRF(*USER) if adoption is not needed.` });
    } else if (adopt) {
      out.push({ ...base, level: 'medium', finding: `Adopts the authority of its owner ${owner}.`, fix: 'Check that callers should get that authority; restrict who can call it (*PUBLIC *EXCLUDE).' });
    }
    if (adopt && s(r, 'SQL_DYNAMIC_USER_PROFILE') === '*OWNER') {
      out.push({ ...base, level: 'medium', finding: 'Dynamic SQL runs with the owner\'s authority (DYNUSRPRF *OWNER): SQL built from input could reach any data the owner can.', fix: 'Use DYNUSRPRF(*USER) or parameter markers only.' });
    }
    if (s(r, 'USE_ADOPTED_AUTHORITY') === '*YES' && !adopt && /^Q/.test(library) === false) {
      out.push({ ...base, level: 'info', finding: 'Uses the authority adopted by the programs that call it.', fix: 'Fine when intended; USEADPAUT(*NO) stops the adopted authority here.' });
    }
    const tgt = s(r, 'TARGET_RELEASE');
    if (currentRelease && tgt && rel(currentRelease) - rel(tgt) >= 3) {
      out.push({ ...base, level: 'info', finding: `Compiled for ${tgt} (system is ${currentRelease}).`, fix: 'Recompile to use the current optimizer and features.' });
    }
  }
  const order = { high: 0, medium: 1, info: 2 };
  return out.sort((a, b) => order[a.level] - order[b.level] || a.program.localeCompare(b.program));
}

// ---------------------------------------------------------------- shadowed objects in the library list

export interface Shadowed { name: string; type: string; used: string; hidden: string[] }

/** Objects with the same name and type in more than one library of the library list: the first one is used, the others are hidden. */
export function shadowedObjects(rows: Row[], order: string[]): Shadowed[] {
  const pos = new Map(order.map((l, i) => [l.toUpperCase(), i]));
  const m = new Map<string, string[]>();
  for (const r of rows) {
    const lib = s(r, 'L', 'OBJLIB'); const k = `${s(r, 'N', 'OBJNAME')}|${s(r, 'T', 'OBJTYPE')}`;
    if (!pos.has(lib.toUpperCase())) { continue; }
    m.set(k, [...(m.get(k) ?? []), lib]);
  }
  return [...m.entries()].filter(([, libs]) => new Set(libs).size > 1)
    .map(([k, libs]) => { const sorted = [...new Set(libs)].sort((a, b) => pos.get(a.toUpperCase())! - pos.get(b.toUpperCase())!); const [name, type] = k.split('|'); return { name, type, used: sorted[0], hidden: sorted.slice(1) }; })
    .sort((a, b) => a.type.localeCompare(b.type) || a.name.localeCompare(b.name));
}

// ---------------------------------------------------------------- job schedule calendar

export interface Run { day: string; weekday: string; time: string; entry: string; command: string; user: string; frequency: string }
const WD = ['*SUN', '*MON', '*TUE', '*WED', '*THU', '*FRI', '*SAT'];
const ymd = (d: Date) => d.toISOString().slice(0, 10);

/** When each scheduled entry (QSYS2.SCHEDULED_JOB_INFO) runs in the next `days` days. Held and saved entries are left out. */
export function scheduleRuns(rows: Row[], from: Date, days = 7): Run[] {
  const out: Run[] = [];
  const start = new Date(Date.UTC(from.getUTCFullYear(), from.getUTCMonth(), from.getUTCDate()));
  for (const r of rows) {
    if (s(r, 'STATUS') && s(r, 'STATUS') !== 'SCHEDULED') { continue; }
    const freq = s(r, 'FREQUENCY'); const dateV = s(r, 'SCHEDULED_DATE_VALUE', 'SCHEDULED_DATE'); const wdays = s(r, 'SCHEDULED_DAYS').toUpperCase();
    const next = s(r, 'NEXT_SUBMISSION_DATE').slice(0, 10); const rel = s(r, 'RELATIVE_DAYS_OF_MONTH').toUpperCase();
    const fixed = /^\d{4}-\d{2}-\d{2}/.test(dateV) ? dateV.slice(0, 10) : '';
    for (let i = 0; i < days; i++) {
      const d = new Date(start.getTime() + i * 86400000); const day = ymd(d); const wd = WD[d.getUTCDay()];
      if (next && day < next) { continue; }
      let runs = false;
      if (freq === '*ONCE') { runs = day === (next || fixed); }
      else if (freq === '*WEEKLY') { runs = wdays && wdays !== '*NONE' ? wdays.includes('*ALL') || wdays.includes(wd) : fixed ? WD[new Date(fixed + 'T00:00:00Z').getUTCDay()] === wd : day === next; }
      else if (freq === '*MONTHLY') {
        const last = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate();
        if (dateV === '*MONTHEND') { runs = d.getUTCDate() === last; }
        else if (dateV === '*MONTHSTR') { runs = d.getUTCDate() === 1; }
        else if (rel && rel !== '*NONE' && wdays.includes(wd)) {
          const nth = Math.ceil(d.getUTCDate() / 7); const isLast = d.getUTCDate() + 7 > last;
          runs = rel.split(/\s+/).some(x => (x === '*LAST' || x === '5' ? isLast : Number(x) === nth));
        } else if (fixed) { runs = Number(fixed.slice(8, 10)) === d.getUTCDate() || (Number(fixed.slice(8, 10)) > last && d.getUTCDate() === last); }
        else { runs = day === next; }
      } else { runs = day === next; }
      if (runs) { out.push({ day, weekday: wd.slice(1), time: s(r, 'SCHEDULED_TIME').slice(0, 5).replace('.', ':'), entry: s(r, 'SCHEDULED_JOB_ENTRY_NAME', 'SCHEDULED_JOB_NAME'), command: s(r, 'COMMAND_STRING'), user: s(r, 'USER_PROFILE_FOR_SUBMITTED_JOB'), frequency: freq }); }
    }
  }
  return out.sort((a, b) => a.day.localeCompare(b.day) || a.time.localeCompare(b.time) || a.entry.localeCompare(b.entry));
}

// ---------------------------------------------------------------- SQL benchmark

export interface Timing { runs: number; min: number; max: number; avg: number; median: number; p90: number; first: number; warm: number }

/** Statistics of repeated runs (milliseconds). The first run is shown apart: it includes the open and the plan. */
export function timings(ms: number[]): Timing {
  if (!ms.length) { throw new Error('No run.'); }
  const sorted = [...ms].sort((a, b) => a - b);
  const at = (p: number) => sorted[Math.min(sorted.length - 1, Math.ceil(p * sorted.length) - 1)];
  const warm = ms.length > 1 ? ms.slice(1) : ms;
  return { runs: ms.length, min: sorted[0], max: sorted[sorted.length - 1], avg: ms.reduce((t, x) => t + x, 0) / ms.length, median: at(0.5), p90: at(0.9), first: ms[0],
    warm: warm.reduce((t, x) => t + x, 0) / warm.length };
}
