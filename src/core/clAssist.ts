// CL editing help from command definitions: which command and parameter the cursor is in, the keywords to offer and
// the hover text of a command. Pure (no vscode import), unit tested.

import { ClCommandDef } from './clCommand';

export interface ClCursor { command: string; keyword?: string; used: string[]; atCommand: boolean }

/** Where the cursor is in a CL statement: `text` is the statement from its start up to the cursor. */
export function clCursor(text: string): ClCursor | undefined {
  const t = text.replace(/^\s*([A-Za-z$#@][\w$#@]{0,9})\s*:\s*/, '');
  const m = t.match(/^\s*((?:[A-Za-z$#@][\w$#@]*\/)?[A-Za-z$#@][\w$#@]*)/);
  if (!m) { return undefined; }
  const command = m[1].toUpperCase();
  const rest = t.substring(m[0].length);
  if (!rest.length) { return { command, used: [], atCommand: true }; }
  // Innermost open keyword parenthesis, ignoring strings.
  const stack: string[] = []; let inString = false; const used: string[] = [];
  for (let i = 0; i < rest.length; i++) {
    const c = rest[i];
    if (c === "'") { inString = !inString; continue; }
    if (inString) { continue; }
    if (c === '(') {
      const kw = rest.substring(0, i).match(/([A-Za-z][\w]*)\s*$/);
      const k = kw && stack.length === 0 ? kw[1].toUpperCase() : '';
      if (k) { used.push(k); }
      stack.push(k);
    } else if (c === ')') { stack.pop(); }
  }
  const keyword = stack.length ? stack[0] || undefined : undefined;
  return { command, keyword: inString ? undefined : keyword, used, atCommand: false };
}

/** Command definition as Markdown for a hover. */
export function commandMarkdown(def: ClCommandDef, limit = 40): string {
  const head = `**${def.library ? def.library + '/' : ''}${def.name}** — ${def.prompt || ''}`.trim();
  const rows = def.parms.slice(0, limit).map(p => {
    const req = p.min > 0 ? ' **(required)**' : '';
    const vals = p.values.length ? p.values.slice(0, 8).join(' ') + (p.values.length > 8 ? ' …' : '') : '';
    const cell = (s: string) => s.replace(/\|/g, '\\|');
    return `| ${p.kwd} | ${cell(p.prompt)}${req} | ${cell(p.dft ?? '')} | ${cell(vals)} |`;
  });
  return `${head}\n\n| Keyword | Parameter | Default | Values |\n|---|---|---|---|\n${rows.join('\n')}` + (def.parms.length > limit ? `\n\n…and ${def.parms.length - limit} more` : '');
}

/** Keywords not used yet, in the command's order, with the required ones first. */
export function keywordsToOffer(def: ClCommandDef, used: string[]): ClCommandDef['parms'] {
  const u = new Set(used.map(x => x.toUpperCase()));
  return def.parms.filter(p => !u.has(p.kwd.toUpperCase())).sort((a, b) => (b.min > 0 ? 1 : 0) - (a.min > 0 ? 1 : 0));
}

/** Values to offer inside KWD( … ). */
export function valuesToOffer(def: ClCommandDef, keyword: string): string[] {
  const p = def.parms.find(x => x.kwd.toUpperCase() === keyword.toUpperCase());
  if (!p) { return []; }
  const out = [...p.values];
  if (p.dft && !out.includes(p.dft)) { out.unshift(p.dft); }
  return out;
}
