// Search and replace across the members of a source file. Pure functions (no vscode import), unit tested.

export interface ReplaceOptions { regex: boolean; matchCase: boolean; wholeWord: boolean }

export function buildPattern(find: string, o: ReplaceOptions): RegExp {
  if (!find) { throw new Error('Enter the text to find.'); }
  let src = o.regex ? find : find.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  if (o.wholeWord) { src = `(?<![\\w$#@])${src}(?![\\w$#@])`; }
  try { return new RegExp(src, o.matchCase ? 'g' : 'gi'); } catch (e) { throw new Error(`Invalid regular expression: ${(e as Error).message}`); }
}

/** Replace in each line; returns the new lines and which lines changed. Lines never grow beyond maxLength. */
export function replaceLines(lines: string[], re: RegExp, replacement: string, maxLength = 0): { lines: string[]; changed: number[]; tooLong: number[] } {
  const changed: number[] = []; const tooLong: number[] = [];
  const out = lines.map((l, i) => {
    re.lastIndex = 0;
    if (!re.test(l)) { return l; }
    re.lastIndex = 0;
    const n = l.replace(re, replacement);
    if (maxLength && n.trimEnd().length > maxLength && n.trimEnd().length > l.trimEnd().length) { tooLong.push(i); return l; }
    if (n !== l) { changed.push(i); }
    return n;
  });
  return { lines: out, changed, tooLong };
}
