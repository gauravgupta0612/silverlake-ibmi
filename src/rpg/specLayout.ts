// Fixed-format column layouts for the F4 "prompter" (RPG IV specs and DDS). Pure, unit tested.

export interface SpecField {
  id: string;
  label: string;
  /** 1-based inclusive columns. */
  from: number;
  to: number;
  hint?: string;
  /** Right-align (numbers) instead of left-align. */
  right?: boolean;
  /** Allowed values shown as suggestions. */
  values?: string[];
}

export interface SpecLayout {
  spec: string;
  title: string;
  fields: SpecField[];
}

const COMMENT: SpecField = { id: 'comment', label: 'Comment', from: 81, to: 100 };

const EXTENDED_F2 = new Set(['EVAL', 'EVALR', 'EVAL-CORR', 'IF', 'ELSEIF', 'DOW', 'DOU', 'WHEN', 'CALLP', 'RETURN', 'FOR',
  'ON-ERROR', 'SORTA', 'XML-INTO', 'XML-SAX', 'DATA-INTO', 'DATA-GEN', 'FOR-EACH', 'SND-MSG']);

export const LAYOUTS: Record<string, SpecLayout> = {
  H: { spec: 'H', title: 'Control specification (H)', fields: [
    { id: 'keywords', label: 'Keywords', from: 7, to: 80, hint: 'e.g. DFTACTGRP(*NO) ACTGRP(*CALLER) OPTION(*SRCSTMT)' },
  ] },
  F: { spec: 'F', title: 'File description (F)', fields: [
    { id: 'name', label: 'File name', from: 7, to: 16 },
    { id: 'type', label: 'File type', from: 17, to: 17, values: ['I', 'O', 'U', 'C'], hint: 'I=input O=output U=update C=combined' },
    { id: 'designation', label: 'File designation', from: 18, to: 18, values: ['F', 'P', 'S', 'R', 'T', ''], hint: 'F=full procedural' },
    { id: 'eof', label: 'End of file', from: 19, to: 19, values: ['E', ''] },
    { id: 'addition', label: 'File addition', from: 20, to: 20, values: ['A', ''], hint: 'A = records can be added' },
    { id: 'sequence', label: 'Sequence', from: 21, to: 21, values: ['A', 'D', ''] },
    { id: 'format', label: 'File format', from: 22, to: 22, values: ['E', 'F'], hint: 'E=externally described F=program described' },
    { id: 'reclen', label: 'Record length', from: 23, to: 27, right: true },
    { id: 'limits', label: 'Limits processing', from: 28, to: 28, values: ['L', ''] },
    { id: 'keylen', label: 'Length of key', from: 29, to: 33, right: true },
    { id: 'rat', label: 'Record address type', from: 34, to: 34, values: ['K', 'A', 'P', 'G', 'D', 'T', 'Z', 'F', ''], hint: 'K = keyed' },
    { id: 'org', label: 'File organization', from: 35, to: 35, values: ['I', 'T', ''] },
    { id: 'device', label: 'Device', from: 36, to: 42, values: ['DISK', 'WORKSTN', 'PRINTER', 'SEQ', 'SPECIAL'] },
    { id: 'keywords', label: 'Keywords', from: 44, to: 80, hint: 'e.g. RENAME(A:B) PREFIX(X_) SFILE(SFL01:RRN)' },
    COMMENT,
  ] },
  D: { spec: 'D', title: 'Definition specification (D)', fields: [
    { id: 'name', label: 'Name', from: 7, to: 21 },
    { id: 'external', label: 'External description', from: 22, to: 22, values: ['E', ''] },
    { id: 'dstype', label: 'Type of data structure', from: 23, to: 23, values: ['S', 'U', ''], hint: 'S=program status U=data area' },
    { id: 'deftype', label: 'Definition type', from: 24, to: 25, values: ['S', 'C', 'DS', 'PR', 'PI', ''], hint: 'blank = subfield / parameter' },
    { id: 'from', label: 'From position', from: 26, to: 32, right: true },
    { id: 'to', label: 'To position / Length', from: 33, to: 39, right: true },
    { id: 'datatype', label: 'Data type', from: 40, to: 40, values: ['A', 'P', 'S', 'B', 'I', 'U', 'F', 'D', 'T', 'Z', 'N', '*', 'G', 'C', 'O', ''] },
    { id: 'decimals', label: 'Decimal positions', from: 41, to: 42, right: true },
    { id: 'keywords', label: 'Keywords', from: 44, to: 80, hint: 'e.g. INZ(0) DIM(10) LIKE(x) CONST VALUE' },
    COMMENT,
  ] },
  P: { spec: 'P', title: 'Procedure specification (P)', fields: [
    { id: 'name', label: 'Procedure name', from: 7, to: 21 },
    { id: 'be', label: 'Begin / End', from: 24, to: 24, values: ['B', 'E'] },
    { id: 'keywords', label: 'Keywords', from: 44, to: 80, hint: 'e.g. EXPORT' },
    COMMENT,
  ] },
  C: { spec: 'C', title: 'Calculation specification (C)', fields: [
    { id: 'level', label: 'Control level', from: 7, to: 8, hint: 'L0-L9, LR, SR, AN, OR' },
    { id: 'cond', label: 'Conditioning indicator', from: 9, to: 11, hint: 'e.g. N50' },
    { id: 'f1', label: 'Factor 1', from: 12, to: 25 },
    { id: 'opcode', label: 'Operation code (extender)', from: 26, to: 35, hint: 'e.g. CHAIN, READ, EVAL(H)' },
    { id: 'f2', label: 'Factor 2', from: 36, to: 49 },
    { id: 'result', label: 'Result field', from: 50, to: 63 },
    { id: 'len', label: 'Field length', from: 64, to: 68, right: true },
    { id: 'dec', label: 'Decimal positions', from: 69, to: 70, right: true },
    { id: 'hi', label: 'Resulting indicator HI', from: 71, to: 72, hint: 'CHAIN: not found' },
    { id: 'lo', label: 'Resulting indicator LO', from: 73, to: 74, hint: 'error' },
    { id: 'eq', label: 'Resulting indicator EQ', from: 75, to: 76, hint: 'READ: end of file' },
    COMMENT,
  ] },
  CX: { spec: 'C', title: 'Calculation specification (C, extended factor 2)', fields: [
    { id: 'level', label: 'Control level', from: 7, to: 8 },
    { id: 'cond', label: 'Conditioning indicator', from: 9, to: 11 },
    { id: 'f1', label: 'Factor 1', from: 12, to: 25 },
    { id: 'opcode', label: 'Operation code (extender)', from: 26, to: 35 },
    { id: 'xf2', label: 'Extended factor 2', from: 36, to: 80, hint: 'expression, e.g. TOTAL = TOTAL + AMOUNT' },
    COMMENT,
  ] },
  A: { spec: 'A', title: 'DDS specification (A)', fields: [
    { id: 'andor', label: 'And / Or', from: 7, to: 7, values: ['A', 'O', ''] },
    { id: 'cond', label: 'Conditioning indicators', from: 8, to: 16, hint: 'up to 3, e.g. N30 31' },
    { id: 'nametype', label: 'Name type', from: 17, to: 17, values: ['R', 'K', 'S', 'O', 'J', 'H', ''], hint: 'R=record K=key S=select O=omit' },
    { id: 'name', label: 'Name', from: 19, to: 28 },
    { id: 'ref', label: 'Reference', from: 29, to: 29, values: ['R', ''] },
    { id: 'len', label: 'Length', from: 30, to: 34, right: true },
    { id: 'datatype', label: 'Data type', from: 35, to: 35, values: ['A', 'P', 'S', 'B', 'F', 'H', 'L', 'T', 'Z', 'O', 'J', 'E', 'G', 'Y', 'X', 'D', 'M', 'N', 'W', 'I', ''] },
    { id: 'dec', label: 'Decimal positions', from: 36, to: 37, right: true },
    { id: 'usage', label: 'Usage', from: 38, to: 38, values: ['B', 'I', 'O', 'H', 'M', 'P', 'N', ''] },
    { id: 'line', label: 'Line', from: 39, to: 41, right: true },
    { id: 'pos', label: 'Position', from: 42, to: 44, right: true },
    { id: 'keywords', label: 'Functions / keywords', from: 45, to: 80, hint: "e.g. TEXT('Customer') COLHDG('Cust' 'No')" },
  ] },
};

/** Which layout applies to a line (or undefined when the line isn't fixed format). */
export function layoutFor(line: string, language: 'rpgle' | 'dds'): SpecLayout | undefined {
  const spec = (line[5] ?? '').toUpperCase();
  if (language === 'dds') { return spec === 'A' || spec === ' ' ? LAYOUTS.A : undefined; }
  if (spec === 'C') {
    const op = line.substring(25, 35).trim().toUpperCase().replace(/\(.*$/, '');
    return EXTENDED_F2.has(op) ? LAYOUTS.CX : LAYOUTS.C;
  }
  return LAYOUTS[spec];
}

export function splitSpec(line: string, layout: SpecLayout): Record<string, string> {
  const values: Record<string, string> = {};
  for (const f of layout.fields) { values[f.id] = line.substring(f.from - 1, f.to).trim(); }
  return values;
}

/**
 * Put values back into their columns. Sequence (1-5) and anything not covered by a field
 * is kept from the original line. Throws when a value is too long for its columns.
 */
export function buildSpec(values: Record<string, string>, layout: SpecLayout, original = ''): string {
  const width = Math.max(original.length, ...layout.fields.filter(f => (values[f.id] ?? '').trim()).map(f => f.to), 6);
  const chars = original.padEnd(width, ' ').split('');
  chars[5] = layout.spec === 'A' ? 'A' : layout.spec;
  for (const f of layout.fields) {
    const size = f.to - f.from + 1;
    const v = (values[f.id] ?? '').replace(/\s+$/, '').replace(/^\s+/, '');
    if (v.length > size) { throw new Error(`${f.label} holds at most ${size} character${size > 1 ? 's' : ''} (columns ${f.from}-${f.to}).`); }
    const cell = f.right ? v.padStart(size, ' ') : v.padEnd(size, ' ');
    for (let i = 0; i < size; i++) { chars[f.from - 1 + i] = cell[i]; }
  }
  return chars.join('').replace(/\s+$/, '');
}
