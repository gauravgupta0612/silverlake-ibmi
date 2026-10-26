// Member cache: the text (and source dates) of members opened before, kept on this computer with the member's change
// time. When a member is opened again and its change time on the IBM i is the same, it opens from the cache — one
// small query instead of copying the whole member.
import * as crypto from 'crypto';
import * as vscode from 'vscode';
import type { SourceRecord } from '../core/sourceDates';
import { logError } from '../core/log';

interface Cached { changed: string; text?: string; records?: SourceRecord[]; at: number }

let dir: vscode.Uri | undefined;
const memory = new Map<string, Cached>();
let hits = 0; let misses = 0;

export function initMemberCache(context: vscode.ExtensionContext): void {
  dir = vscode.Uri.joinPath(context.globalStorageUri, 'member-cache');
}

export const cacheEnabled = () => vscode.workspace.getConfiguration('vanthrex.memberCache').get<boolean>('enabled', true);
const maxEntries = () => vscode.workspace.getConfiguration('vanthrex.memberCache').get<number>('maxMembers', 500);
const keyOf = (system: string, path: string) => crypto.createHash('sha1').update(`${system}|${path.toUpperCase()}`).digest('hex');

export async function cacheGet(system: string, path: string, changed: string | undefined): Promise<Cached | undefined> {
  if (!cacheEnabled() || !changed || !dir) { return undefined; }
  const k = keyOf(system, path);
  let c = memory.get(k);
  if (!c) {
    try { c = JSON.parse(new TextDecoder().decode(await vscode.workspace.fs.readFile(vscode.Uri.joinPath(dir, `${k}.json`)))) as Cached; memory.set(k, c); }
    catch { /* not cached */ }
  }
  if (c && c.changed === changed) { hits++; c.at = Date.now(); return c; }
  misses++;
  return undefined;
}

export async function cachePut(system: string, path: string, changed: string | undefined, content: { text?: string; records?: SourceRecord[] }): Promise<void> {
  if (!cacheEnabled() || !changed || !dir) { return; }
  const k = keyOf(system, path);
  const c: Cached = { changed, ...content, at: Date.now() };
  memory.set(k, c);
  try {
    await vscode.workspace.fs.createDirectory(dir);
    await vscode.workspace.fs.writeFile(vscode.Uri.joinPath(dir, `${k}.json`), new TextEncoder().encode(JSON.stringify(c)));
    if (memory.size > maxEntries()) { void trim(); }
  } catch (e) { logError(e); }
}

/** Keeps only the most recently used members on disk. */
async function trim(): Promise<void> {
  if (!dir) { return; }
  try {
    const files = (await vscode.workspace.fs.readDirectory(dir)).filter(([n]) => n.endsWith('.json'));
    if (files.length <= maxEntries()) { return; }
    const stats = await Promise.all(files.map(async ([n]) => ({ n, m: (await vscode.workspace.fs.stat(vscode.Uri.joinPath(dir!, n))).mtime })));
    stats.sort((a, b) => a.m - b.m);
    for (const s of stats.slice(0, stats.length - maxEntries())) {
      memory.delete(s.n.replace(/\.json$/, ''));
      await vscode.workspace.fs.delete(vscode.Uri.joinPath(dir, s.n)).then(undefined, () => undefined);
    }
  } catch (e) { logError(e); }
}

export async function cacheClear(): Promise<number> {
  memory.clear();
  if (!dir) { return 0; }
  let n = 0;
  try { n = (await vscode.workspace.fs.readDirectory(dir)).length; await vscode.workspace.fs.delete(dir, { recursive: true }); } catch { /* empty */ }
  return n;
}

export async function cacheStats(): Promise<{ members: number; bytes: number; hits: number; misses: number }> {
  let members = 0; let bytes = 0;
  if (dir) {
    try {
      const files = await vscode.workspace.fs.readDirectory(dir);
      members = files.length;
      for (const [n] of files) { bytes += (await vscode.workspace.fs.stat(vscode.Uri.joinPath(dir, n))).size; }
    } catch { /* empty */ }
  }
  return { members, bytes, hits, misses };
}
