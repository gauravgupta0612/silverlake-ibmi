// Developer converters: packed / zoned / binary numbers to and from hex (what a DUMP or a hex view of a record shows),
// IBM i date formats (*ISO, *USA, *EUR, *CYMD, *JUL, *LONGJUL…), timestamps and epoch, and the SQL that converts text
// to and from EBCDIC hex on the system (exact for every CCSID). Pure (no vscode import), unit tested.

const HEX = /^[0-9A-F]*$/;
export function cleanHex(hex: string): string {
  const h = hex.replace(/^X'|'$/gi, '').replace(/[\s:-]/g, '').toUpperCase();
  if (!HEX.test(h) || h.length % 2) { throw new Error(`"${hex}" is not hexadecimal (an even number of 0-9 and A-F).`); }
  return h;
}

function digitsOf(value: string, digits: number, scale: number): { neg: boolean; s: string } {
  const v = value.trim().replace(',', '.');
  if (!/^[-+]?\d*(\.\d*)?$/.test(v) || !/\d/.test(v)) { throw new Error(`"${value}" is not a number.`); }
  const neg = v.startsWith('-');
  const [i, f = ''] = v.replace(/^[-+]/, '').split('.');
  if (f.replace(/0+$/, '').length > scale) { throw new Error(`${value} has more than ${scale} decimal position(s).`); }
  const int = i.replace(/^0+/, '');
  if (int.length > digits - scale) { throw new Error(`${value} does not fit in ${digits} digit(s) with ${scale} decimal(s).`); }
  return { neg: neg && /[1-9]/.test(i + f), s: (int + f.padEnd(scale, '0')).padStart(digits, '0') };
}

/** Packed decimal (P): two digits per byte, the sign in the last half byte (C positive, D negative). */
export function toPacked(value: string, digits: number, scale = 0): string {
  const d = digits % 2 ? digits : digits + 1; // an even digit count still uses a whole byte: the first half byte is 0
  const { neg, s } = digitsOf(value, digits, scale);
  return s.padStart(d, '0') + (neg ? 'D' : 'C');
}

export function fromPacked(hex: string, scale = 0): string {
  const h = cleanHex(hex);
  if (!h) { throw new Error('No bytes.'); }
  const body = h.slice(0, -1); const sign = h.slice(-1);
  if (!/^\d+$/.test(body || '0') || !/[A-F]/.test(sign)) { throw new Error(`${h} is not packed decimal (digits then a sign C, D or F).`); }
  return withScale(body, scale, sign === 'D' || sign === 'B');
}

/** Zoned decimal (S): one digit per byte (F0-F9), the sign in the zone of the last byte (C or F positive, D negative). */
export function toZoned(value: string, digits: number, scale = 0): string {
  const { neg, s } = digitsOf(value, digits, scale);
  return [...s].map((c, i) => (i === s.length - 1 ? (neg ? 'D' : 'F') : 'F') + c).join('');
}

export function fromZoned(hex: string, scale = 0): string {
  const h = cleanHex(hex);
  const bytes = h.match(/../g) ?? [];
  if (!bytes.length || bytes.some(b => !/^[0-9A-F][0-9]$/.test(b))) { throw new Error(`${h} is not zoned decimal (each byte F0 to F9).`); }
  const last = bytes[bytes.length - 1][0];
  return withScale(bytes.map(b => b[1]).join(''), scale, last === 'D' || last === 'B');
}

function withScale(digits: string, scale: number, neg: boolean): string {
  const d = digits.padStart(scale + 1, '0');
  const i = d.slice(0, d.length - scale).replace(/^0+(?=\d)/, ''); const f = scale ? d.slice(-scale) : '';
  const out = f ? `${i}.${f}` : i;
  return neg && /[1-9]/.test(out) ? `-${out}` : out;
}

/** Binary integer (B, I, U, INT): 2, 4 or 8 bytes, big endian, two's complement when signed. */
export function toBinary(value: string, bytes: 2 | 4 | 8, signed = true): string {
  if (!/^[-+]?\d+$/.test(value.trim())) { throw new Error(`"${value}" is not a whole number.`); }
  let n = BigInt(value.trim());
  const bits = BigInt(bytes * 8); const max = signed ? (1n << (bits - 1n)) - 1n : (1n << bits) - 1n; const min = signed ? -(1n << (bits - 1n)) : 0n;
  if (n > max || n < min) { throw new Error(`${value} does not fit in ${bytes} byte(s) ${signed ? 'signed' : 'unsigned'} (${min} to ${max}).`); }
  if (n < 0n) { n += 1n << bits; }
  return n.toString(16).toUpperCase().padStart(bytes * 2, '0');
}

export function fromBinary(hex: string, signed = true): string {
  const h = cleanHex(hex);
  if (![2, 4, 8].includes(h.length / 2)) { throw new Error('A binary integer is 2, 4 or 8 bytes.'); }
  let n = BigInt('0x' + h);
  const bits = BigInt(h.length * 4);
  if (signed && n >= 1n << (bits - 1n)) { n -= 1n << bits; }
  return n.toString();
}

// ---------------------------------------------------------------- dates

export interface Ymd { y: number; m: number; d: number }
const pad = (n: number, w = 2) => String(n).padStart(w, '0');
const valid = (x: Ymd) => x.m >= 1 && x.m <= 12 && x.d >= 1 && x.d <= new Date(Date.UTC(x.y, x.m, 0)).getUTCDate() && x.y >= 1 && x.y <= 9999;
const dayOfYear = (x: Ymd) => Math.round((Date.UTC(x.y, x.m - 1, x.d) - Date.UTC(x.y, 0, 1)) / 86400000) + 1;
const fromDayOfYear = (y: number, n: number): Ymd => { const t = new Date(Date.UTC(y, 0, n)); return { y: t.getUTCFullYear(), m: t.getUTCMonth() + 1, d: t.getUTCDate() }; };
/** Two-digit years: 40-99 are 19xx, 00-39 are 20xx (the IBM i rule for *MDY, *DMY, *YMD, *JUL). */
const century = (yy: number) => (yy >= 40 ? 1900 + yy : 2000 + yy);

/** Reads a date in any IBM i format; `how` says which format it was read as. */
export function parseDate(text: string): { date: Ymd; how: string } {
  const t = text.trim();
  let m: RegExpMatchArray | null;
  const tries: [RegExp, string, (m: RegExpMatchArray) => Ymd][] = [
    [/^(\d{4})-(\d{2})-(\d{2})(?:[-T ].*)?$/, '*ISO', a => ({ y: +a[1], m: +a[2], d: +a[3] })],
    [/^(\d{2})\/(\d{2})\/(\d{4})$/, '*USA', a => ({ y: +a[3], m: +a[1], d: +a[2] })],
    [/^(\d{2})\.(\d{2})\.(\d{4})$/, '*EUR', a => ({ y: +a[3], m: +a[2], d: +a[1] })],
    [/^(\d{2})\/(\d{3})$/, '*JUL', a => fromDayOfYear(century(+a[1]), +a[2])],
    [/^(\d{2})\/(\d{2})\/(\d{2})$/, '*MDY', a => ({ y: century(+a[3]), m: +a[1], d: +a[2] })],
    [/^(\d{2})-(\d{2})-(\d{2})$/, '*YMD', a => ({ y: century(+a[1]), m: +a[2], d: +a[3] })],
    [/^([01])(\d{2})(\d{2})(\d{2})$/, '*CYMD', a => ({ y: 1900 + +a[1] * 100 + +a[2], m: +a[3], d: +a[4] })],
    [/^((?:1[89]|2\d)\d{2})(\d{3})$/, '*LONGJUL', a => fromDayOfYear(+a[1], +a[2])],
    [/^(\d{4})(\d{2})(\d{2})$/, '*ISO (numeric)', a => ({ y: +a[1], m: +a[2], d: +a[3] })],
    [/^(\d{2})(\d{2})(\d{2})$/, '*YMD (numeric)', a => ({ y: century(+a[1]), m: +a[2], d: +a[3] })],
  ];
  for (const [re, how, f] of tries) {
    if ((m = t.match(re))) { const date = f(m); if (valid(date)) { return { date, how }; } }
  }
  throw new Error(`"${text}" is not a date in a known format (2026-03-31, 03/31/2026, 31.03.2026, 1260331, 26/090, 2026090, 20260331…).`);
}

/** The date in every IBM i format, with the numeric forms used in old RPG files. */
export function dateFormats(x: Ymd): [string, string][] {
  if (!valid(x)) { throw new Error('Not a valid date.'); }
  const yy = pad(x.y % 100); const doy = pad(dayOfYear(x), 3);
  const out: [string, string][] = [
    ['*ISO', `${pad(x.y, 4)}-${pad(x.m)}-${pad(x.d)}`], ['*USA', `${pad(x.m)}/${pad(x.d)}/${pad(x.y, 4)}`], ['*EUR', `${pad(x.d)}.${pad(x.m)}.${pad(x.y, 4)}`],
    ['*JIS', `${pad(x.y, 4)}-${pad(x.m)}-${pad(x.d)}`], ['*LONGJUL', `${pad(x.y, 4)}${doy}`],
  ];
  if (x.y >= 1940 && x.y <= 2039) { out.push(['*MDY', `${pad(x.m)}/${pad(x.d)}/${yy}`], ['*DMY', `${pad(x.d)}/${pad(x.m)}/${yy}`], ['*YMD', `${yy}/${pad(x.m)}/${pad(x.d)}`], ['*JUL', `${yy}/${doy}`]); }
  if (x.y >= 1900 && x.y <= 2899) { const c = Math.floor((x.y - 1900) / 100); out.push(['*CYMD', `${c}${yy}${pad(x.m)}${pad(x.d)}`], ['*CMDY', `${c}${pad(x.m)}${pad(x.d)}${yy}`], ['*CDMY', `${c}${pad(x.d)}${pad(x.m)}${yy}`]); }
  out.push(['8-digit numeric (YYYYMMDD)', `${pad(x.y, 4)}${pad(x.m)}${pad(x.d)}`], ['Day of week', ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'][new Date(Date.UTC(x.y, x.m - 1, x.d)).getUTCDay()]],
    ['Day of year', String(dayOfYear(x))], ['RPG', `%date(${pad(x.y, 4)}${pad(x.m)}${pad(x.d)}: *iso0)`], ['SQL', `DATE('${pad(x.y, 4)}-${pad(x.m)}-${pad(x.d)}')`]);
  return out;
}

/** A timestamp in IBM i, ISO, epoch seconds or epoch milliseconds, shown in all of them (UTC). */
export function timestampFormats(text: string): [string, string][] {
  const t = text.trim();
  let ms: number; let micro = '000000';
  const ibm = t.match(/^(\d{4})-(\d{2})-(\d{2})[-T ](\d{2})[.:](\d{2})[.:](\d{2})(?:[.,](\d{1,12}))?Z?$/);
  if (ibm) {
    micro = (ibm[7] ?? '').padEnd(6, '0').slice(0, 6);
    ms = Date.UTC(+ibm[1], +ibm[2] - 1, +ibm[3], +ibm[4], +ibm[5], +ibm[6], Math.floor(+micro / 1000));
  } else if (/^\d{9,11}$/.test(t)) { ms = +t * 1000; }
  else if (/^\d{12,14}$/.test(t)) { ms = +t; micro = pad(ms % 1000, 3) + '000'; }
  else { throw new Error(`"${text}" is not a timestamp (2026-03-31-14.05.00.000000, 2026-03-31T14:05:00Z, or epoch seconds / milliseconds).`); }
  const d = new Date(ms);
  if (isNaN(d.getTime())) { throw new Error('Not a valid timestamp.'); }
  const p = (n: number) => pad(n);
  const ymd = `${pad(d.getUTCFullYear(), 4)}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())}`;
  return [
    ['IBM i (SQL / RPG *ISO)', `${ymd}-${p(d.getUTCHours())}.${p(d.getUTCMinutes())}.${p(d.getUTCSeconds())}.${micro}`],
    ['ISO 8601 (UTC)', `${ymd}T${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())}.${micro.slice(0, 3)}Z`],
    ['Epoch seconds', String(Math.floor(ms / 1000))], ['Epoch milliseconds', String(ms)],
    ['SQL', `TIMESTAMP('${ymd}-${p(d.getUTCHours())}.${p(d.getUTCMinutes())}.${p(d.getUTCSeconds())}.${micro}')`],
  ];
}

// ---------------------------------------------------------------- EBCDIC (done by the system: exact for every CCSID)

export function checkCcsid(ccsid: string | number): number {
  const n = Number(ccsid);
  if (!Number.isInteger(n) || n < 1 || n > 65534) { throw new Error(`"${ccsid}" is not a CCSID.`); }
  return n;
}

export function textToHexSql(text: string, ccsid: number): string {
  if (!text) { throw new Error('Type a text.'); }
  if (text.length > 1000) { throw new Error('At most 1000 characters.'); }
  return `SELECT HEX(CAST('${text.replace(/'/g, "''")}' AS VARCHAR(4000) CCSID ${checkCcsid(ccsid)})) AS H FROM SYSIBM.SYSDUMMY1`;
}

export function hexToTextSql(hex: string, ccsid: number): string {
  const h = cleanHex(hex);
  if (!h) { throw new Error('Type the hexadecimal bytes.'); }
  if (h.length > 4000) { throw new Error('At most 2000 bytes.'); }
  return `SELECT CAST(CAST(X'${h}' AS VARCHAR(2000) FOR BIT DATA) AS VARCHAR(2000) CCSID ${checkCcsid(ccsid)}) AS T FROM SYSIBM.SYSDUMMY1`;
}

/** Hex shown as a dump: offset, bytes in groups of 4. */
export function hexDump(hex: string, perLine = 16): string {
  const bytes = cleanHex(hex).match(/../g) ?? [];
  const out: string[] = [];
  for (let i = 0; i < bytes.length; i += perLine) {
    out.push(`${i.toString(16).toUpperCase().padStart(4, '0')}  ${bytes.slice(i, i + perLine).map((b, j) => (j && j % 4 === 0 ? ' ' : '') + b).join('')}`);
  }
  return out.join('\n');
}
