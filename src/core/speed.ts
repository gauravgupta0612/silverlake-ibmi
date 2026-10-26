// Speed helpers: reading many members in one round trip, a local source index searched as you type, IBM i
// references found in any text (members, objects, IFS paths, message IDs, jobs), a pool that runs work in parallel,
// and the advice of the connection speed test. Pure (no vscode import), unit tested.

const shq = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;
const NAME = /^[A-Z$#@][A-Z0-9$#@_.]{0,9}$/;
export const BULK_MARK = '@@VXMBR@@';

/** One QSH script that prints many members of a source file, each after a marker line. */
export function bulkReadScript(lib: string, file: string, members: string[]): string {
  const l = lib.toUpperCase(); const f = file.toUpperCase();
  if (!NAME.test(l) || !NAME.test(f)) { throw new Error(`Invalid source file ${lib}/${file}.`); }
  const ms = members.map(m => m.toUpperCase()).filter(m => NAME.test(m));
  return [`cd ${shq(`/QSYS.LIB/${l}.LIB/${f}.FILE`)} || exit 1`,
    `for m in ${ms.map(shq).join(' ')}; do`,
    `  echo "${BULK_MARK} $m"`,
    '  cat "$m.MBR" 2>/dev/null',
    '  echo',
    'done'].join('\n') + '\n';
}

/** Member name → text, from the output of bulkReadScript. Trailing blanks of each line are removed. */
export function parseBulk(stdout: string): Map<string, string> {
  const out = new Map<string, string>();
  let name: string | undefined; let lines: string[] = [];
  const flush = () => {
    if (name === undefined) { return; }
    while (lines.length && lines[lines.length - 1] === '') { lines.pop(); }
    out.set(name, lines.join('\n'));
  };
  for (const raw of stdout.split(/\r?\n/)) {
    if (raw.startsWith(BULK_MARK + ' ')) { flush(); name = raw.slice(BULK_MARK.length + 1).trim(); lines = []; continue; }
    if (name !== undefined) { lines.push(raw.replace(/\s+$/, '')); }
  }
  flush();
  return out;
}

// ---------------------------------------------------------------- source index

export interface IndexEntry { type: string; changed: string; text: string }
export interface MemberRow { file: string; member: string; type: string; changed: string }

/** Which members must be read again (new or changed since indexed) and which left the library. */
export function staleMembers(index: Record<string, Pick<IndexEntry, 'changed'>>, rows: MemberRow[]): { refresh: MemberRow[]; removed: string[] } {
  const seen = new Set<string>();
  const refresh: MemberRow[] = [];
  for (const r of rows) {
    const k = `${r.file}/${r.member}`;
    seen.add(k);
    if (!index[k] || index[k].changed !== r.changed) { refresh.push(r); }
  }
  return { refresh, removed: Object.keys(index).filter(k => !seen.has(k)) };
}

export interface Hit { key: string; line: number; column: number; length: number; text: string }

/** Every match of the query in the indexed sources: plain text (case-insensitive unless asked) or a regular expression. */
export function searchIndex(docs: Iterable<[string, string]>, query: string, opts: { regex?: boolean; caseSensitive?: boolean; wholeWord?: boolean; max?: number } = {}): { hits: Hit[]; truncated: boolean } {
  const max = opts.max ?? 500;
  if (!query) { return { hits: [], truncated: false }; }
  let re: RegExp;
  const flags = opts.caseSensitive ? 'g' : 'gi';
  try {
    const body = opts.regex ? query : query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    re = new RegExp(opts.wholeWord ? `(?<![\\w$#@])(?:${body})(?![\\w$#@])` : body, flags);
  } catch (e) { throw new Error(`Invalid regular expression: ${(e as Error).message}`); }
  const hits: Hit[] = [];
  for (const [key, text] of docs) {
    // A quick test on the whole text first: most members do not match at all.
    re.lastIndex = 0;
    if (!re.test(text)) { continue; }
    const lines = text.split('\n');
    for (let i = 0; i < lines.length; i++) {
      re.lastIndex = 0;
      const m = re.exec(lines[i]);
      if (m && m[0].length) {
        hits.push({ key, line: i, column: m.index, length: m[0].length, text: lines[i] });
        if (hits.length >= max) { return { hits, truncated: true }; }
      }
    }
  }
  return { hits, truncated: false };
}

/** Where a procedure is defined in the indexed sources (dcl-proc NAME, or a fixed-format P spec with B). */
export function procedureDefinitions(docs: Iterable<[string, string]>, name: string): { key: string; line: number }[] {
  const n = name.toUpperCase().replace(/[$#@]/g, '\\$&');
  const free = new RegExp(`^\\s*dcl-proc\\s+${n}(\\s|;|$)`, 'im');
  const out: { key: string; line: number }[] = [];
  for (const [key, text] of docs) {
    if (!text.toUpperCase().includes(name.toUpperCase())) { continue; }
    const lines = text.split('\n');
    lines.forEach((l, i) => {
      if (free.test(l) || (/^.{5}[Pp]/.test(l) && l.slice(6, 21).trim().toUpperCase() === name.toUpperCase() && l.slice(23, 24).toUpperCase() === 'B')) { out.push({ key, line: i }); }
    });
  }
  return out;
}

// ---------------------------------------------------------------- references in any text

export type RefKind = 'member' | 'object' | 'ifs' | 'message' | 'job';
export interface Ref { kind: RefKind; start: number; end: number; args: Record<string, string> }

const OBJ_KW = 'PGM|SRVPGM|FILE|OBJ|MODULE|CMD|DTAARA|DTAQ|MSGF|JOBD|OUTQ|JOBQ|SBSD|BNDDIR|TOFILE|FROMFILE|OUTFILE|SRCFILE|USRSPC|USRIDX|JRN';
const N = '[A-Z$#@][A-Z0-9$#@_.]{0,9}';

/** IBM i references in a line: LIB/FILE(MBR), PGM(LIB/OBJ), /home/… paths, CPF1234 message IDs, 123456/USER/JOB jobs. */
export function refsIn(line: string): Ref[] {
  const out: Ref[] = [];
  const taken = (s: number, e: number) => out.some(r => s < r.end && e > r.start);
  const add = (r: Ref) => { if (!taken(r.start, r.end)) { out.push(r); } };
  let m: RegExpExecArray | null;
  const member = new RegExp(`(?<![A-Z0-9$#@_./])(${N})\\/(${N})\\((${N})\\)`, 'gi');
  while ((m = member.exec(line))) {
    add({ kind: 'member', start: m.index, end: m.index + m[0].length, args: { library: m[1].toUpperCase(), file: m[2].toUpperCase(), member: m[3].toUpperCase() } });
  }
  const obj = new RegExp(`\\b(?:${OBJ_KW})\\((${N})\\/(${N})\\)`, 'gi');
  while ((m = obj.exec(line))) {
    const s = m.index + m[0].indexOf('(') + 1;
    const kw = m[0].slice(0, m[0].indexOf('(')).toUpperCase();
    const type = { PGM: '*PGM', SRVPGM: '*SRVPGM', MODULE: '*MODULE', CMD: '*CMD', DTAARA: '*DTAARA', DTAQ: '*DTAQ', MSGF: '*MSGF', JOBD: '*JOBD', OUTQ: '*OUTQ', JOBQ: '*JOBQ', SBSD: '*SBSD', BNDDIR: '*BNDDIR', USRSPC: '*USRSPC', USRIDX: '*USRIDX', JRN: '*JRN' }[kw] ?? '*FILE';
    add({ kind: 'object', start: s, end: m.index + m[0].length - 1, args: { library: m[1].toUpperCase(), name: m[2].toUpperCase(), type: kw === 'OBJ' ? '' : type } });
  }
  const typed = new RegExp(`(?<![A-Z0-9$#@_./])(${N})\\/(${N})\\s+(\\*(?:PGM|SRVPGM|FILE|MODULE|CMD|DTAARA|DTAQ|MSGF|JOBD|OUTQ|JOBQ|SBSD|BNDDIR|USRPRF|LIB))\\b`, 'gi');
  while ((m = typed.exec(line))) {
    if (/^\d+$/.test(m[1])) { continue; }
    add({ kind: 'object', start: m.index, end: m.index + m[1].length + 1 + m[2].length, args: { library: m[1].toUpperCase(), name: m[2].toUpperCase(), type: m[3].toUpperCase() } });
  }
  const job = /\b(\d{6})\/([A-Z$#@][A-Z0-9$#@_]{0,9})\/([A-Z$#@][A-Z0-9$#@_]{0,9})\b/gi;
  while ((m = job.exec(line))) { add({ kind: 'job', start: m.index, end: m.index + m[0].length, args: { job: m[0].toUpperCase() } }); }
  const ifs = /(?<![\w./$#@)])(\/(?:home|QOpenSys|QIBM|tmp|www|usr|etc|var|opt|QDLS|QNTC)\/[A-Za-z0-9._\-/$#@~+]*[A-Za-z0-9_\-$#@~+])/g;
  while ((m = ifs.exec(line))) { add({ kind: 'ifs', start: m.index, end: m.index + m[1].length, args: { path: m[1] } }); }
  const msg = /\b((?:CPF|CPD|CPI|CPA|CPC|MCH|RNF|RNQ|RNX|CEE|TCP|SQL|CPX|CZM|CZS)[0-9A-F]{4})\b/g;
  while ((m = msg.exec(line))) { add({ kind: 'message', start: m.index, end: m.index + m[0].length, args: { id: m[1] } }); }
  return out.sort((a, b) => a.start - b.start);
}

// ---------------------------------------------------------------- work in parallel

/** Runs fn on every item, at most `limit` at a time, keeping the order of the results. */
export async function runPool<T, R>(items: T[], limit: number, fn: (item: T, index: number) => Promise<R>, stop?: () => boolean): Promise<(R | undefined)[]> {
  const results: (R | undefined)[] = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length && !stop?.()) {
      const i = next++;
      results[i] = await fn(items[i], i);
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, worker));
  return results;
}

/** Splits a list into batches of `size`. */
export function batches<T>(items: T[], size: number): T[][] {
  return Array.from({ length: Math.ceil(items.length / size) }, (_, i) => items.slice(i * size, i * size + size));
}

// ---------------------------------------------------------------- speed test

export interface SpeedMeasures { sshMs: number[]; qshMs: number[]; sqlMs: number[]; downloadMBps?: number; uploadMBps?: number; sqlEngine: string; memberCache: boolean; indexedLibraries: number }

const median = (a: number[]) => { if (!a.length) { return 0; } const s = [...a].sort((x, y) => x - y); return s[Math.floor(s.length / 2)]; };

export function speedSummary(m: SpeedMeasures): { rows: [string, string, string][]; advice: string[]; grade: 'fast' | 'good' | 'slow' } {
  const ssh = median(m.sshMs), qsh = median(m.qshMs), sql = median(m.sqlMs);
  const rate = (v: number, good: number, ok: number) => (v <= good ? 'fast' : v <= ok ? 'good' : 'slow');
  const rows: [string, string, string][] = [
    ['SSH round trip', `${ssh} ms`, rate(ssh, 40, 120)],
    ['QSH / CL command start', `${qsh} ms`, rate(qsh, 300, 900)],
    ['SQL statement', `${sql} ms`, rate(sql, 30, 150)],
  ];
  if (m.downloadMBps !== undefined) { rows.push(['Download', `${m.downloadMBps.toFixed(1)} MB/s`, m.downloadMBps >= 5 ? 'fast' : m.downloadMBps >= 1 ? 'good' : 'slow']); }
  if (m.uploadMBps !== undefined) { rows.push(['Upload', `${m.uploadMBps.toFixed(1)} MB/s`, m.uploadMBps >= 5 ? 'fast' : m.uploadMBps >= 1 ? 'good' : 'slow']); }
  const advice: string[] = [];
  if (!/mapepire/i.test(m.sqlEngine)) { advice.push('SQL does not use Mapepire: set the SQL engine to Automatic and make sure Java is installed — every SQL statement and every member open will be several times faster.'); }
  if (!m.memberCache) { advice.push('Turn on the member cache (vanthrex.memberCache.enabled): members you open again open instantly when they did not change.'); }
  if (!m.indexedLibraries) { advice.push('Index your main source libraries (Index Source Libraries for Instant Search): searching then takes milliseconds instead of a scan on the IBM i.'); }
  if (ssh > 120) { advice.push('The network round trip is long: prefer commands that work in one step (batch compile in parallel, bulk index) and keep the warm-up on connect turned on.'); }
  if (qsh > 900) { advice.push('Starting a QSH job is slow on this system: check the QSH prestart jobs and the system load; SQL (Mapepire) avoids this cost.'); }
  if (m.downloadMBps !== undefined && m.downloadMBps < 1) { advice.push('Transfers are slow: large members and spooled files will take time; the member cache avoids reading them again.'); }
  const slow = rows.filter(r => r[2] === 'slow').length;
  return { rows, advice, grade: slow ? 'slow' : rows.every(r => r[2] === 'fast') ? 'fast' : 'good' };
}
