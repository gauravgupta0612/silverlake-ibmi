// Notes attached to source lines. Pure functions (no vscode import), unit tested.


export interface Note { id: string; line: number; snippet: string; text: string; by: string; at: string }

/** Where a note is now: the same line if its text is unchanged, else the nearest line with the same text. */
export function relocate(note: Note, lines: string[]): number | undefined {
  const s = note.snippet.trim();
  if (!s) { return note.line < lines.length ? note.line : undefined; }
  if (lines[note.line]?.trim() === s) { return note.line; }
  let best: number | undefined;
  lines.forEach((l, i) => { if (l.trim() === s && (best === undefined || Math.abs(i - note.line) < Math.abs(best - note.line))) { best = i; } });
  return best;
}

export function noteKey(system: string, lib: string, file: string, member: string): string {
  return `${system}|${lib}/${file}(${member})`.toUpperCase();
}
