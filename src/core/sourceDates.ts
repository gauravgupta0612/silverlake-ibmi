// SEU-style source sequence numbers and change dates (SRCSEQ / SRCDAT). Pure module, unit tested.

export interface SourceRecord {
  /** Sequence number, e.g. 12.00 (stored as DECIMAL(6,2)). */
  seq: number;
  /** Change date as YYMMDD (DECIMAL(6,0)); 0 when unknown. */
  date: number;
  text: string;
}

/**
 * Map every line of `b` to the line of `a` it is unchanged from (or -1 when it is new or edited).
 * Common prefix/suffix are matched first; the middle uses an LCS table when small enough and a
 * fast in-order matching otherwise, so huge members stay quick.
 */
export function diffLines(a: string[], b: string[]): number[] {
  const map = new Array<number>(b.length).fill(-1);
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) { map[start] = start; start++; }
  let endA = a.length - 1;
  let endB = b.length - 1;
  while (endA >= start && endB >= start && a[endA] === b[endB]) { map[endB] = endA; endA--; endB--; }
  const n = endA - start + 1;
  const m = endB - start + 1;
  if (n <= 0 || m <= 0) { return map; }

  if (n * m <= 4_000_000) {
    // Classic LCS with a compact table of lengths.
    const w = m + 1;
    const table = new Uint32Array((n + 1) * w);
    for (let i = n - 1; i >= 0; i--) {
      for (let j = m - 1; j >= 0; j--) {
        table[i * w + j] = a[start + i] === b[start + j]
          ? table[(i + 1) * w + j + 1] + 1
          : Math.max(table[(i + 1) * w + j], table[i * w + j + 1]);
      }
    }
    let i = 0, j = 0;
    while (i < n && j < m) {
      if (a[start + i] === b[start + j]) { map[start + j] = start + i; i++; j++; }
      else if (table[(i + 1) * w + j] >= table[i * w + j + 1]) { i++; }
      else { j++; }
    }
    return map;
  }

  // Large change: anchor on lines that are unique in both versions (patience diff),
  // then diff the gaps between anchors.
  patience(a, b, start, endA + 1, start, endB + 1, map);
  return map;
}

function patience(a: string[], b: string[], a0: number, a1: number, b0: number, b1: number, map: number[]): void {
  if (a0 >= a1 || b0 >= b1) { return; }
  if ((a1 - a0) * (b1 - b0) <= 4_000_000) {
    const sub = diffLines(a.slice(a0, a1), b.slice(b0, b1));
    sub.forEach((v, j) => { if (v >= 0) { map[b0 + j] = a0 + v; } });
    return;
  }
  const countA = new Map<string, number>();
  const posA = new Map<string, number>();
  for (let i = a0; i < a1; i++) { countA.set(a[i], (countA.get(a[i]) ?? 0) + 1); posA.set(a[i], i); }
  const countB = new Map<string, number>();
  for (let j = b0; j < b1; j++) { countB.set(b[j], (countB.get(b[j]) ?? 0) + 1); }
  // Unique pairs in b order, then the longest increasing subsequence of their a positions.
  const pairs: [number, number][] = [];
  for (let j = b0; j < b1; j++) {
    if (countB.get(b[j]) === 1 && countA.get(b[j]) === 1) { pairs.push([posA.get(b[j])!, j]); }
  }
  if (!pairs.length) { return; } // nothing reliable to anchor on: leave the region unmatched
  const tails: number[] = [];
  const prev = new Array<number>(pairs.length).fill(-1);
  for (let k = 0; k < pairs.length; k++) {
    let lo = 0, hi = tails.length;
    while (lo < hi) { const mid = (lo + hi) >> 1; if (pairs[tails[mid]][0] < pairs[k][0]) { lo = mid + 1; } else { hi = mid; } }
    if (lo > 0) { prev[k] = tails[lo - 1]; }
    tails[lo] = k;
  }
  const anchors: [number, number][] = [];
  for (let k = tails[tails.length - 1]; k >= 0; k = prev[k]) { anchors.unshift(pairs[k]); }
  let pa = a0, pb = b0;
  for (const [ia, jb] of anchors) {
    patience(a, b, pa, ia, pb, jb, map);
    map[jb] = ia;
    pa = ia + 1; pb = jb + 1;
  }
  patience(a, b, pa, a1, pb, b1, map);
}

/**
 * Build the records to save: unchanged lines keep their sequence number and date, changed or
 * inserted lines get `today`. Inserted lines are numbered between their neighbours (step 0.01
 * or larger); when there is no room the whole member is renumbered 1.00, 2.00, … like SEU.
 */
export function mergeRecords(original: SourceRecord[], lines: string[], today: number): SourceRecord[] {
  const map = diffLines(original.map(r => r.text), lines);
  const out: SourceRecord[] = lines.map((text, i) => {
    const o = map[i] >= 0 ? original[map[i]] : undefined;
    return { seq: o ? o.seq : NaN, date: o ? o.date : today, text };
  });

  // Keep only strictly increasing kept sequence numbers; anything else gets a new number.
  let prev = 0;
  for (const r of out) {
    if (!Number.isNaN(r.seq)) {
      if (r.seq > prev) { prev = r.seq; } else { r.seq = NaN; }
    }
  }
  // Number the gaps.
  for (let i = 0; i < out.length;) {
    if (!Number.isNaN(out[i].seq)) { i++; continue; }
    let j = i;
    while (j < out.length && Number.isNaN(out[j].seq)) { j++; }
    const low = i > 0 ? out[i - 1].seq : 0;
    const high = j < out.length ? out[j].seq : Number.POSITIVE_INFINITY;
    const count = j - i;
    let step = high === Number.POSITIVE_INFINITY ? 1 : Math.floor(((high - low) / (count + 1)) * 100) / 100;
    if (step > 1) { step = 1; }
    if (step < 0.01) { return renumber(out); }
    for (let k = 0; k < count; k++) { out[i + k].seq = round2(low + step * (k + 1)); }
    i = j;
  }
  if (out.length && out[out.length - 1].seq > 9999.99) { return renumber(out); }
  return out;
}

function renumber(records: SourceRecord[]): SourceRecord[] {
  const step = records.length > 9999 ? Math.max(0.01, Math.floor((9999 / records.length) * 100) / 100) : 1;
  return records.map((r, i) => ({ ...r, seq: round2((i + 1) * step) }));
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/** YYMMDD → Date (centuries: 40-99 → 19xx, 00-39 → 20xx, like IBM i). */
export function srcDateToDate(yymmdd: number): Date | undefined {
  if (!yymmdd) { return undefined; }
  const yy = Math.floor(yymmdd / 10000);
  const mm = Math.floor((yymmdd % 10000) / 100);
  const dd = yymmdd % 100;
  if (mm < 1 || mm > 12 || dd < 1 || dd > 31) { return undefined; }
  return new Date(Date.UTC(yy >= 40 ? 1900 + yy : 2000 + yy, mm - 1, dd));
}

export function dateToSrcDate(d: Date): number {
  return (d.getFullYear() % 100) * 10000 + (d.getMonth() + 1) * 100 + d.getDate();
}

/** "26/01/03"-style SEU display, or ISO "2026-01-03". */
export function formatSrcDate(yymmdd: number, style: 'seu' | 'iso' = 'iso'): string {
  if (!yymmdd) { return style === 'seu' ? '      ' : '          '; }
  const d = srcDateToDate(yymmdd);
  if (!d) { return String(yymmdd).padStart(6, '0'); }
  if (style === 'seu') { return String(yymmdd).padStart(6, '0'); }
  return d.toISOString().slice(0, 10);
}

export function formatSeq(seq: number): string {
  return seq.toFixed(2).padStart(7, '0');
}

/** Lines longer than the source record allows, as 1-based line numbers. */
export function tooLongLines(lines: string[], maxLength: number): number[] {
  const out: number[] = [];
  lines.forEach((l, i) => { if (l.replace(/\s+$/, '').length > maxLength) { out.push(i + 1); } });
  return out;
}
