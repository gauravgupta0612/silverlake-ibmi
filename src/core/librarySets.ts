// Saved library list sets. Pure functions (no vscode import), unit tested.
import { isValidSystemName } from './util';

export interface LibrarySet { name: string; libraries: string[]; currentLibrary?: string }

export function parseLibrarySetInput(input: string): string[] {
  const libs = input.split(/[\s,;]+/).map(x => x.trim().toUpperCase()).filter(Boolean);
  const bad = libs.filter(l => !isValidSystemName(l));
  if (bad.length) { throw new Error(`Not a valid library name: ${bad.join(', ')}`); }
  if (libs.length > 250) { throw new Error('A library list holds at most 250 libraries.'); }
  return [...new Set(libs)];
}
