// Mapping between IBM i source members and files in a Git repository (pure module, unit tested).
//
// Layout:  <repo>/<library>/<source file>/<member>.<type>   (all lower case), e.g. mylib/qrpglesrc/ordentry.rpgle
// State:   <repo>/.vanthrex/sync.json  — what was last exchanged with the IBM i, so only real changes move.

export interface MemberRef { lib: string; file: string; member: string; type: string; }

export interface SyncEntry extends MemberRef {
  /** LAST_SOURCE_UPDATE_TIMESTAMP on the IBM i at the last download / upload. */
  changed: string;
  /** Hash of the text at the last download / upload. */
  hash: string;
}

export interface SyncState {
  version: 1;
  host: string;
  system: string;
  libraries: string[];
  members: Record<string, SyncEntry>;
}

export const STATE_FILE = '.vanthrex/sync.json';
const NAME = /^[a-z$#@][a-z0-9$#@_.]{0,9}$/i;

export function repoPath(m: MemberRef): string {
  const type = (m.type || 'mbr').toLowerCase();
  return `${m.lib.toLowerCase()}/${m.file.toLowerCase()}/${m.member.toLowerCase()}.${type}`;
}

/** "mylib/qrpglesrc/ordentry.rpgle" -> member reference, or undefined for other files. */
export function parseRepoPath(rel: string): MemberRef | undefined {
  const parts = rel.replace(/\\/g, '/').replace(/^\.\//, '').split('/');
  if (parts.length !== 3) { return undefined; }
  const [lib, file, base] = parts;
  const dot = base.lastIndexOf('.');
  const member = dot > 0 ? base.substring(0, dot) : base;
  const type = dot > 0 ? base.substring(dot + 1) : 'mbr';
  if (!NAME.test(lib) || !NAME.test(file) || !NAME.test(member) || lib.startsWith('.')) { return undefined; }
  return { lib: lib.toUpperCase(), file: file.toUpperCase(), member: member.toUpperCase(), type: type.toUpperCase() };
}

/** Normalise text before hashing so CRLF / trailing blanks (which members never keep) don't count as changes. */
export function normaliseSource(text: string): string {
  const lines = text.replace(/\r\n/g, '\n').split('\n').map(l => l.replace(/\s+$/, ''));
  while (lines.length && lines[lines.length - 1] === '') { lines.pop(); }
  return lines.join('\n') + (lines.length ? '\n' : '');
}

/** Small, dependency-free FNV-1a hash (enough to detect changes, not for security). */
export function textHash(text: string): string {
  let h = 0x811c9dc5;
  const s = normaliseSource(text);
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, '0') + ':' + s.length.toString(36);
}

export interface UploadPlan { changed: string[]; added: string[]; conflicts: string[]; }

/**
 * Files to send to the IBM i: changed in the repo since the last sync (or new).
 * A conflict is a file changed in the repo whose member was also changed on the IBM i since then.
 */
export function planUpload(state: SyncState, local: Map<string, string>, remoteChanged: Map<string, string>): UploadPlan {
  const plan: UploadPlan = { changed: [], added: [], conflicts: [] };
  for (const [rel, hash] of local) {
    const known = state.members[rel];
    if (!known) { plan.added.push(rel); continue; }
    if (known.hash === hash) { continue; }
    const remote = remoteChanged.get(rel);
    if (remote && known.changed && remote !== known.changed) { plan.conflicts.push(rel); }
    else { plan.changed.push(rel); }
  }
  return { changed: plan.changed.sort(), added: plan.added.sort(), conflicts: plan.conflicts.sort() };
}

export interface DownloadPlan { changed: string[]; added: string[]; conflicts: string[]; removed: string[]; }

/** Members to bring into the repo: changed on the IBM i since the last sync (or new there). */
export function planDownload(state: SyncState, remote: Map<string, MemberRef & { changed: string }>, local: Map<string, string>): DownloadPlan {
  const plan: DownloadPlan = { changed: [], added: [], conflicts: [], removed: [] };
  for (const [rel, r] of remote) {
    const known = state.members[rel];
    if (!known) { (local.has(rel) ? plan.conflicts : plan.added).push(rel); continue; }
    if (r.changed === known.changed) { continue; }
    const localHash = local.get(rel);
    if (localHash !== undefined && localHash !== known.hash) { plan.conflicts.push(rel); }
    else { plan.changed.push(rel); }
  }
  for (const rel of Object.keys(state.members)) {
    if (!remote.has(rel)) { plan.removed.push(rel); }
  }
  for (const k of Object.keys(plan) as (keyof DownloadPlan)[]) { plan[k].sort(); }
  return plan;
}

export function emptyState(host: string, system: string): SyncState {
  return { version: 1, host, system, libraries: [], members: {} };
}

/** Parse `git log --format=%H%x09%an%x09%ad%x09%s` output. */
export function parseGitLog(out: string): { sha: string; author: string; date: string; subject: string }[] {
  return out.split('\n').filter(l => l.includes('\t')).map(l => {
    const [sha, author, date, ...rest] = l.split('\t');
    return { sha, author, date, subject: rest.join('\t') };
  });
}
