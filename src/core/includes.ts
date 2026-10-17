// /COPY and /INCLUDE expansion. Pure functions (no vscode import), unit tested.


/** Replaces the /COPY lines (by 0-based line number) with the included text between marker comments.
 *  null means "not found": the directive is kept with a warning comment. */
export function mergeIncludes(text: string, parts: Map<number, { target: string; text: string | null }>, fullyFree: boolean): string {
  const lines = text.split(/\r?\n/);
  const c = (s: string) => (fullyFree ? `// ${s}` : `      * ${s}`);
  const out: string[] = [];
  lines.forEach((l, i) => {
    const p = parts.get(i);
    if (!p) { out.push(l); return; }
    if (p.text === null) { out.push(l, c(`^^^ ${p.target} was not found`)); return; }
    let body = p.text.split(/\r?\n/);
    if (/^\s*\*\*FREE/i.test(body[0] ?? '')) { body = body.slice(1); }
    while (body.length && !body[body.length - 1].trim()) { body.pop(); }
    out.push(c(`>>>>> ${l.trim()}`), ...body, c(`<<<<< end of ${p.target}`));
  });
  return out.join('\n');
}
