// Pure helpers for the fourth 2.1 batch: RPG / DDS indicator usage, ping results, HTTP options,
// IFS CCSID commands and call stack formatting. No vscode import, unit tested.

// ---------------------------------------------------------------- indicator usage

export interface IndicatorUse { indicator: string; set: number[]; tested: number[] }

const IND = (n: string) => n.padStart(2, '0');

/** Where each numbered indicator (01–99, KA–KY, LR, H1–H9, U1–U8) is set and where it is tested. */
export function indicatorUsage(text: string): IndicatorUse[] {
  const map = new Map<string, IndicatorUse>();
  const at = (ind: string) => { const k = ind.toUpperCase(); if (!map.has(k)) { map.set(k, { indicator: k, set: [], tested: [] }); } return map.get(k)!; };
  const lines = text.split(/\r?\n/);
  const fullyFree = /^\s*\*\*FREE/i.test(lines[0] ?? '');
  lines.forEach((raw, i) => {
    if (/^\s*\/\//.test(raw) || (!fullyFree && raw[6] === '*')) { return; }
    const spec = !fullyFree && raw.length > 6 ? raw[5].toUpperCase() : '';
    if (spec === 'C' && !/^\s*$/.test(raw.substring(25, 35))) {
      // Fixed-form C spec: conditioning in 9–11, resulting indicators in 71–76.
      for (const m of raw.substring(8, 11).matchAll(/N?([0-9]{2}|LR|L[1-9]|H[1-9]|U[1-8]|K[A-Y])/gi)) { at(m[1]).tested.push(i); }
      for (const m of raw.substring(70, 76).matchAll(/([0-9]{2}|LR|H[1-9])/gi)) { if (m[1].trim()) { at(m[1]).set.push(i); } }
    }
    if (spec === 'A') {
      // DDS: conditioning indicators in 8–16, and CAnn/CFnn response indicators.
      for (const m of raw.substring(7, 16).matchAll(/N?([0-9]{2})/g)) { at(m[1]).tested.push(i); }
      for (const m of raw.substring(44).matchAll(/\bC[AF]\d{2}\s*\(\s*(\d{2})/gi)) { at(m[1]).set.push(i); }
      for (const m of raw.substring(44).matchAll(/\b(?:CHANGE|ROLLUP|ROLLDOWN|PAGEUP|PAGEDOWN|SFLEND|SFLDSP|SFLDSPCTL|SFLCLR)\s*\(\s*(\d{2})/gi)) { at(m[1]).set.push(i); }
    }
    // *INxx anywhere in code (free or fixed extended factor 2).
    const code = raw.replace(/'[^']*'/g, "''").replace(/\/\/.*$/, '');
    for (const m of code.matchAll(/\*IN\(?\s*(\d{2}|LR|H[1-9]|U[1-8]|K[A-Y])\s*\)?/gi)) {
      const after = code.slice((m.index ?? 0) + m[0].length);
      if (/^\s*=(?!=)/.test(after) && !/\b(IF|WHEN|DOW|DOU|AND|OR)\b[^;]*$/i.test(code.slice(0, m.index))) { at(m[1]).set.push(i); } else { at(m[1]).tested.push(i); }
    }
    if (spec !== 'C') { for (const m of code.matchAll(/\b(SETON|SETOFF)\b\s+(?:\*IN)?([0-9]{2}|LR)/gi)) { at(m[2]).set.push(i); } }
  });
  return [...map.values()].map(u => ({ ...u, set: [...new Set(u.set)], tested: [...new Set(u.tested)] }))
    .sort((a, b) => a.indicator.localeCompare(b.indicator, undefined, { numeric: true }));
}

/** Indicators that are set but never tested, or tested but never set (in this source). */
export function indicatorProblems(u: IndicatorUse[]): { indicator: string; problem: string }[] {
  const out: { indicator: string; problem: string }[] = [];
  for (const x of u) {
    if (x.indicator === 'LR' || /^K[A-Y]$/.test(x.indicator) || /^U[1-8]$/.test(x.indicator)) { continue; }
    if (x.set.length && !x.tested.length) { out.push({ indicator: x.indicator, problem: 'set but never tested' }); }
    if (!x.set.length && x.tested.length) { out.push({ indicator: x.indicator, problem: 'tested but never set here (set by a display file or another program?)' }); }
  }
  return out;
}

// ---------------------------------------------------------------- ping

export function pingCommand(host: string, packets = 3): string {
  const h = host.trim();
  if (!/^[A-Za-z0-9.:\-_]{1,255}$/.test(h)) { throw new Error('Enter a host name or IP address.'); }
  return `PING RMTSYS('${h}') NBRPKT(${Math.max(1, Math.min(20, packets))}) WAITTIME(2)`;
}

export function parsePing(output: string): { ok: boolean; sent?: number; received?: number; avgMs?: number; text: string } {
  const m = /(\d+)\s+of\s+(\d+)\s+(?:successful|réussi|erfolgreich)/i.exec(output);
  const avg = /(?:average|moyen|Durchschnitt)[^0-9]*([\d.,]+)/i.exec(output);
  const text = output.split('\n').map(l => l.trim()).filter(l => /TCP32|successful|average|Verifying|unknown|not/i.test(l)).slice(0, 6).join('\n');
  if (!m) { return { ok: false, text: text || output.trim().split('\n').slice(-3).join('\n') }; }
  return { ok: Number(m[1]) > 0, received: Number(m[1]), sent: Number(m[2]), avgMs: avg ? Number(avg[1].replace(',', '.')) : undefined, text };
}

// ---------------------------------------------------------------- HTTP from the IBM i

/** The JSON options string of QSYS2.HTTP_GET / HTTP_POST for some headers. */
export function httpOptions(headers: Record<string, string>, opts: { sslTolerate?: boolean; timeoutSeconds?: number } = {}): string {
  const o: Record<string, unknown> = {};
  if (Object.keys(headers).length) { o.header = Object.entries(headers).map(([k, v]) => `${k},${v}`).join(','); }
  if (opts.sslTolerate) { o.sslTolerate = 'true'; }
  if (opts.timeoutSeconds) { o.ioTimeout = opts.timeoutSeconds * 1000; }
  return JSON.stringify(o);
}

/** Parse "Name: value" lines into a header object. */
export function parseHeaders(input: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const l of input.split(/[\n;]+/)) {
    const m = /^\s*([A-Za-z0-9-]+)\s*:\s*(.+?)\s*$/.exec(l);
    if (m) { if (/,/.test(m[2])) { throw new Error(`Header ${m[1]}: commas are not allowed in a value here.`); } out[m[1]] = m[2]; }
  }
  return out;
}

export function prettyBody(body: string): { text: string; language: string } {
  const t = body.trim();
  if (/^[[{]/.test(t)) { try { return { text: JSON.stringify(JSON.parse(t), null, 2), language: 'json' }; } catch { /* not JSON */ } }
  if (/^</.test(t)) { return { text: t, language: /^<!doctype html|<html/i.test(t) ? 'html' : 'xml' }; }
  return { text: body, language: 'plaintext' };
}

export function httpStatus(headerJsonOrText: string): number | undefined {
  const m = /"HTTP_STATUS_CODE"\s*:\s*"?(\d{3})|HTTP\/\d(?:\.\d)?\s+(\d{3})/i.exec(headerJsonOrText);
  return m ? Number(m[1] ?? m[2]) : undefined;
}

// ---------------------------------------------------------------- IFS CCSID

export const COMMON_CCSIDS: Record<number, string> = { 1208: 'UTF-8', 819: 'ISO 8859-1 (Latin-1)', 1252: 'Windows Latin-1', 37: 'EBCDIC US', 297: 'EBCDIC France', 273: 'EBCDIC Germany', 284: 'EBCDIC Spain', 280: 'EBCDIC Italy', 500: 'EBCDIC International', 1200: 'UTF-16' };

export function tagCcsidCommand(path: string, ccsid: number, subtree: boolean): string {
  if (!path.startsWith('/')) { throw new Error('The path must start with /.'); }
  if (!Number.isInteger(ccsid) || ccsid < 1 || ccsid > 65535) { throw new Error('Enter a CCSID between 1 and 65535.'); }
  return `CHGATR OBJ('${path.replace(/'/g, "''")}') ATR(*CCSID) VALUE(${ccsid})${subtree ? ' SUBTREE(*ALL)' : ''}`;
}

export function convertCcsidCommand(path: string, ccsid: number): string {
  if (!path.startsWith('/')) { throw new Error('The path must start with /.'); }
  const p = path.replace(/'/g, "''");
  return `CPY OBJ('${p}') TOOBJ('${p}') TOCCSID(${ccsid}) DTAFMT(*TEXT) REPLACE(*YES)`;
}

// ---------------------------------------------------------------- call stack

export function stackLine(r: Record<string, unknown>): string {
  const v = (k: string) => String(r[k] ?? '').trim();
  const pgm = v('PROGRAM_LIBRARY_NAME') ? `${v('PROGRAM_LIBRARY_NAME')}/${v('PROGRAM_NAME')}` : v('PROGRAM_NAME');
  const proc = v('PROCEDURE_NAME') && v('PROCEDURE_NAME') !== v('PROGRAM_NAME') ? ` ${v('PROCEDURE_NAME')}` : '';
  const stmt = v('STATEMENT_IDENTIFIERS') ? ` (statement ${v('STATEMENT_IDENTIFIERS').split(/\s+/)[0]})` : '';
  return `${pgm || v('ENTRY_TYPE')}${v('MODULE_NAME') && v('MODULE_NAME') !== v('PROGRAM_NAME') ? `·${v('MODULE_NAME')}` : ''}${proc}${stmt}`;
}
