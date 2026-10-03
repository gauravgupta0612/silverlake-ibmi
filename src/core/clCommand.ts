// CL command definitions (from the QCDRCMDD API) and CL command text helpers. Pure, unit tested.

export interface ClParm {
  kwd: string;
  prompt: string;
  type: string;
  min: number;
  max: number;
  len?: string;
  dft?: string;
  position?: number;
  /** Special / single / allowed values offered as suggestions. */
  values: string[];
  /** Prompts of the parts of a qualified name or element list, e.g. ["Program", "Library"]. */
  parts: string[];
}

export interface ClCommandDef {
  name: string;
  library: string;
  prompt: string;
  parms: ClParm[];
}

const CP037 = "\u0000\u0001\u0002\u0003\u009c\t\u0086\u007f\u0097\u008d\u008e\u000b\f\r\u000e\u000f\u0010\u0011\u0012\u0013\u009d\u0085\b\u0087\u0018\u0019\u0092\u008f\u001c\u001d\u001e\u001f\u0080\u0081\u0082\u0083\u0084\n\u0017\u001b\u0088\u0089\u008a\u008b\u008c\u0005\u0006\u0007\u0090\u0091\u0016\u0093\u0094\u0095\u0096\u0004\u0098\u0099\u009a\u009b\u0014\u0015\u009e\u001a \u00a0\u00e2\u00e4\u00e0\u00e1\u00e3\u00e5\u00e7\u00f1\u00a2.<(+|&\u00e9\u00ea\u00eb\u00e8\u00ed\u00ee\u00ef\u00ec\u00df!$*);\u00ac-/\u00c2\u00c4\u00c0\u00c1\u00c3\u00c5\u00c7\u00d1\u00a6,%_>?\u00f8\u00c9\u00ca\u00cb\u00c8\u00cd\u00ce\u00cf\u00cc`:#@'=\"\u00d8abcdefghi\u00ab\u00bb\u00f0\u00fd\u00fe\u00b1\u00b0jklmnopqr\u00aa\u00ba\u00e6\u00b8\u00c6\u00a4\u00b5~stuvwxyz\u00a1\u00bf\u00d0\u00dd\u00de\u00ae^\u00a3\u00a5\u00b7\u00a9\u00a7\u00b6\u00bc\u00bd\u00be[]\u00af\u00a8\u00b4\u00d7{ABCDEFGHI\u00ad\u00f4\u00f6\u00f2\u00f3\u00f5}JKLMNOPQR\u00b9\u00fb\u00fc\u00f9\u00fa\u00ff\\\u00f7STUVWXYZ\u00b2\u00d4\u00d6\u00d2\u00d3\u00d50123456789\u00b3\u00db\u00dc\u00d9\u00da\u009f";

/** Decode bytes that may be EBCDIC (CCSID 37) or UTF-8. */
export function decodeIbmText(bytes: Uint8Array): string {
  const firstNonBlank = bytes.find(b => b !== 0x40 && b !== 0x20 && b !== 0x0a && b !== 0x0d && b !== 0x25 && b !== 0xef && b !== 0xbb && b !== 0xbf);
  if (firstNonBlank === 0x4c) { // '<' in EBCDIC
    let s = '';
    for (const b of bytes) { s += CP037[b]; }
    return s.replace(/\u0085/g, '\n');
  }
  return Buffer.from(bytes).toString('utf8').replace(/^\ufeff/, '');
}

function attrs(tag: string): Record<string, string> {
  const out: Record<string, string> = {};
  const re = /([A-Za-z_:][\w:.-]*)\s*=\s*"([^"]*)"/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(tag))) { out[m[1]] = unescapeXml(m[2]); }
  return out;
}

function unescapeXml(s: string): string {
  return s.replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
}

/** Parse the CDML0100 XML returned by QCDRCMDD. */
export function parseCommandXml(xml: string): ClCommandDef {
  const cmdTag = xml.match(/<Cmd\b[^>]*>/);
  if (!cmdTag) { throw new Error('Not a command definition (no <Cmd> element).'); }
  const c = attrs(cmdTag[0]);
  const parms: ClParm[] = [];
  const re = /<Parm\b([^>]*?)(\/>|>([\s\S]*?)<\/Parm>)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(xml))) {
    const a = attrs(m[1]);
    if (a.Constant !== undefined || !a.Kwd) { continue; }
    const body = m[3] ?? '';
    const values = [...new Set([...body.matchAll(/<Value\b[^>]*\bVal="([^"]*)"/g)].map(v => unescapeXml(v[1])))];
    const parts = [...body.matchAll(/<(?:Qual|Elem)\b([^>]*)>/g)].map(q => attrs(q[1]).Prompt || attrs(q[1]).Type || '').filter(Boolean);
    parms.push({
      kwd: a.Kwd,
      prompt: a.Prompt || a.Kwd,
      type: a.Type || '',
      min: Number(a.Min ?? 0),
      max: Number(a.Max ?? 1),
      len: a.Len,
      dft: a.Dft,
      position: a.PosNbr ? Number(a.PosNbr) : undefined,
      values,
      parts,
    });
  }
  return { name: c.CmdName ?? '', library: c.CmdLib ?? '', prompt: c.Prompt ?? '', parms };
}

export interface ParsedCommand {
  label?: string;
  command: string;
  /** Keyword values exactly as written (without the outer parentheses). */
  params: Record<string, string>;
  positional: string[];
}

/** Join continuation lines (+ or -) and remove comments. */
export function joinClLines(lines: string[]): string {
  // '+' keeps the blanks before it and skips the next line's leading blanks;
  // '-' drops nothing before it and keeps the next line's leading blanks.
  let out = '';
  let skipLeading = false;
  for (const raw of lines) {
    let l = raw.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/\s+$/, '');
    if (skipLeading) { l = l.replace(/^\s+/, ''); }
    if (l.endsWith('+')) { out += l.slice(0, -1); skipLeading = true; continue; }
    if (l.endsWith('-')) { out += l.slice(0, -1); skipLeading = false; continue; }
    out += l;
    break;
  }
  return out.trim();
}

/** Split a CL command into label, command name, keyword parameters and positional values. */
export function parseClCommand(text: string): ParsedCommand {
  let s = text.trim();
  let label: string | undefined;
  const lm = s.match(/^([A-Za-z$#@][\w$#@]*)\s*:\s*/);
  if (lm) { label = lm[1]; s = s.substring(lm[0].length); }
  const cm = s.match(/^([A-Za-z$#@*][\w$#@]*(?:\/[A-Za-z$#@][\w$#@]*)?)/);
  if (!cm) { return { label, command: '', params: {}, positional: [] }; }
  const command = cm[1].toUpperCase();
  s = s.substring(cm[0].length);
  const params: Record<string, string> = {};
  const positional: string[] = [];
  let i = 0;
  while (i < s.length) {
    while (i < s.length && /\s/.test(s[i])) { i++; }
    if (i >= s.length) { break; }
    const km = s.substring(i).match(/^([A-Za-z][\w]*)\(/);
    if (km) {
      i += km[0].length;
      const start = i;
      let depth = 1, quote = false;
      while (i < s.length && depth > 0) {
        const ch = s[i];
        if (ch === "'") { quote = !quote; }
        else if (!quote && ch === '(') { depth++; }
        else if (!quote && ch === ')') { depth--; }
        i++;
      }
      params[km[1].toUpperCase()] = s.substring(start, i - 1).trim();
    } else {
      // A positional value ends at a blank outside quotes and parentheses, e.g. (&A *EQ 1).
      const start = i;
      let quote = false, depth = 0;
      while (i < s.length && (quote || depth > 0 || !/\s/.test(s[i]))) {
        const ch = s[i];
        if (ch === "'") { quote = !quote; }
        else if (!quote && ch === '(') { depth++; }
        else if (!quote && ch === ')') { depth = Math.max(0, depth - 1); }
        i++;
      }
      positional.push(s.substring(start, i));
    }
  }
  return { label, command, params, positional };
}

/** Values given by keyword, or by position using the command definition. */
export function currentValues(parsed: ParsedCommand, def: ClCommandDef): Record<string, string> {
  const values: Record<string, string> = { ...parsed.params };
  const byPos = def.parms.filter(p => p.position !== undefined).sort((a, b) => a.position! - b.position!);
  parsed.positional.forEach((v, i) => { const p = byPos[i]; if (p && values[p.kwd] === undefined) { values[p.kwd] = v; } });
  return values;
}

/** Build the command text. 'source' formats it for a CL member (columns 14 / 25, '+' continuations). */
export function formatClCommand(command: string, values: { kwd: string; value: string }[], style: 'line' | 'source', label?: string): string {
  const parts = values.filter(v => v.value.trim() !== '').map(v => `${v.kwd}(${v.value.trim()})`);
  if (style === 'line') { return [command, ...parts].join(' '); }
  const lead = (label ? `${label}:` : '').padEnd(13, ' ');
  const head = `${lead}${command.padEnd(10, ' ')} `;
  const indent = ' '.repeat(25);
  const limit = 68; // leaves room for " +" within column 71
  const lines: string[] = [];
  let current = head;
  const flush = () => { lines.push(current.replace(/\s+$/, '') + ' +'); current = indent; };
  for (const p of parts) {
    const sep = current === head || current === indent ? '' : ' ';
    if ((current + sep + p).length <= limit) { current += sep + p; continue; }
    if (current !== head && current !== indent) { flush(); }
    if ((current + p).length <= limit) { current += p; continue; }
    // A single value longer than a line (e.g. a long message): continue it with '+', which
    // keeps the text up to the '+' and skips the next line's leading blanks. Never start a
    // continued piece with a blank (it would be skipped).
    let rest = p;
    while ((current + rest).length > limit) {
      let cut = limit - current.length - 1;
      while (cut > 1 && rest[cut] === ' ') { cut--; }
      lines.push(current + rest.slice(0, cut) + '+');
      rest = rest.slice(cut);
      current = indent;
    }
    current += rest;
  }
  lines.push(current.replace(/\s+$/, ''));
  return lines.join('\n');
}

/** Hex of the Qlg_Path_Name_T structure QCDRCMDD needs to write its XML to an IFS file (UTF-8). */
export function qlgPathHex(path: string): string {
  const name = Buffer.from(path, 'utf8');
  const head = Buffer.alloc(32);
  head.writeInt32BE(1208, 0);       // CCSID of the path name and output
  head.writeInt32BE(0, 12);         // path type: character, single delimiter
  head.writeInt32BE(name.length, 16);
  head.write('/', 20, 'ascii');     // delimiter
  return Buffer.concat([head, name]).toString('hex').toUpperCase();
}
