// Local development: work on source in a local (Git) folder, deploy it to the IFS, compile and build there, and open a
// PASE shell. Pure functions (no vscode import), unit tested.

export interface LocalFile { rel: string; size: number; mtimeMs: number }
export interface DeployState { [rel: string]: { size: number; mtimeMs: number } }
export interface DeployPlan { upload: string[]; unchanged: number; removed: string[] }

/** Files never deployed, whatever the user's own list says. */
export const ALWAYS_IGNORED = ['.git/', '.svn/', '.DS_Store', 'Thumbs.db'];
/** Default ignore list (the user's setting replaces it). */
export const DEFAULT_IGNORE = ['node_modules/', '.vscode/', '*.vsix', '*.log', '.env', '.env.*', '*.pem', '*.key'];

const toPosix = (p: string) => p.replace(/\\/g, '/').replace(/^\.\//, '');

/** Glob test on a workspace-relative path: `*` (no slash), `**` (anything), `?`, a trailing `/` means a folder. */
export function matchesIgnore(rel: string, patterns: string[]): boolean {
  const path = toPosix(rel);
  for (const raw of [...ALWAYS_IGNORED, ...patterns]) {
    const p = toPosix(raw.trim());
    if (!p || p.startsWith('#')) { continue; }
    const dir = p.endsWith('/');
    const body = dir ? p.slice(0, -1) : p;
    const re = new RegExp('^' + body.split('**').map(part => part.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '[^/]*').replace(/\?/g, '[^/]')).join('.*') + (dir ? '(/.*)?$' : '(/.*)?$'));
    const anchored = body.includes('/');
    if (re.test(path)) { return true; }
    // A pattern without a slash matches at any depth (like .gitignore).
    if (!anchored && path.split('/').some((_, i, parts) => re.test(parts.slice(i).join('/')))) { return true; }
  }
  return false;
}

/** What to upload: new or changed files (size or time), skipping ignored ones; files deployed before but gone now. */
export function planDeploy(files: LocalFile[], state: DeployState, ignore: string[], all = false): DeployPlan {
  const kept = files.filter(f => !matchesIgnore(f.rel, ignore));
  const upload: string[] = [];
  let unchanged = 0;
  for (const f of kept) {
    const before = state[toPosix(f.rel)];
    if (all || !before || before.size !== f.size || Math.abs(before.mtimeMs - f.mtimeMs) > 1) { upload.push(toPosix(f.rel)); } else { unchanged++; }
  }
  const now = new Set(kept.map(f => toPosix(f.rel)));
  const removed = Object.keys(state).filter(k => !now.has(k)).sort();
  return { upload: upload.sort(), unchanged, removed };
}

/** The IFS folder a workspace folder deploys to: `${home}`, `${user}` and `${folder}` replaced. Refuses unsafe paths. */
export function deployDirectory(template: string, vars: { home: string; user: string; folder: string }): string {
  const folder = vars.folder.replace(/[^A-Za-z0-9._-]/g, '_') || 'project';
  const t = (template || '${home}/builds/${folder}').trim();
  const dir = t.replace(/\$\{home\}/g, vars.home.replace(/\/+$/, '')).replace(/\$\{user\}/g, vars.user.toLowerCase()).replace(/\$\{folder\}/g, folder)
    .replace(/\/+/g, '/').replace(/\/$/, '');
  if (!dir.startsWith('/')) { throw new Error(`The deploy folder must be an absolute IFS path: ${dir}`); }
  if (/(^|\/)\.\.(\/|$)/.test(dir) || /['"`$\\\n]/.test(dir)) { throw new Error(`The deploy folder contains characters that are not allowed: ${dir}`); }
  if (/^\/(QSYS\.LIB|QOpenSys|QIBM|QDLS|QNTC|dev|etc|bin|usr|lib|tmp)?\/?$/i.test(dir)) { throw new Error(`Deploying straight into ${dir} is not allowed: use a folder of its own.`); }
  return dir;
}

/** IFS path of a workspace file. */
export function remotePathFor(dir: string, rel: string): string {
  const r = toPosix(rel);
  if (r.split('/').includes('..')) { throw new Error(`Invalid path ${rel}`); }
  return `${dir.replace(/\/+$/, '')}/${r}`;
}

/** Workspace-relative path of an IFS path inside the deploy folder (to put compile errors on the local file). */
export function localRelFor(dir: string, remote: string): string | undefined {
  const base = dir.replace(/\/+$/, '') + '/';
  return remote.startsWith(base) ? remote.slice(base.length) : undefined;
}

/** Folders that must exist before the files are uploaded, parents first. */
export function foldersToCreate(dir: string, rels: string[]): string[] {
  const out = new Set<string>();
  for (const r of rels) {
    const parts = toPosix(r).split('/').slice(0, -1);
    for (let i = 1; i <= parts.length; i++) { out.add(remotePathFor(dir, parts.slice(0, i).join('/'))); }
  }
  return [...out].sort((a, b) => a.split('/').length - b.split('/').length || a.localeCompare(b));
}

const shq = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;

/** Shell line that runs a build command in the deploy folder with the open-source tools on the PATH and the library list in the environment. */
export function buildShellCommand(command: string, dir: string, env: { curlib?: string; libl?: string[] }): string {
  if (!command.trim()) { throw new Error('No build command is set.'); }
  const parts = ['export PATH=/QOpenSys/pkgs/bin:$PATH', 'export LANG=EN_US.UTF-8'];
  if (env.curlib) { parts.push(`export CURLIB=${shq(env.curlib)}`); }
  if (env.libl?.length) { parts.push(`export LIBL=${shq(env.libl.join(' '))}`); }
  parts.push(`cd ${shq(dir)}`, command.trim());
  return parts.join(' && ');
}

/** First lines typed into a new PASE terminal. */
export function shellStartup(dir: string | undefined, openSourcePath: boolean): string {
  const lines: string[] = [];
  if (openSourcePath) { lines.push('export PATH=/QOpenSys/pkgs/bin:$PATH'); }
  if (dir) { lines.push(`cd ${shq(dir)}`); }
  return lines.length ? lines.join(' && ') + '\n' : '';
}

/** Message IDs (RNF, SQL, CPF…) and failed-target lines in build output, for the summary after a build. */
export function buildProblems(output: string): { messages: string[]; failed: boolean } {
  const ids = new Set<string>();
  for (const m of output.matchAll(/\b((?:RNF|RNS|SQL|CPF|CPD|CZM|CZS|MCH)[0-9A-F]{4})\b/g)) { ids.add(m[1]); }
  const failed = /\b(make|gmake)\S*: \*\*\*|\bError\b.*\bfailed\b|\bFAILED\b|exit code [1-9]|Build failed/i.test(output);
  return { messages: [...ids].slice(0, 30), failed };
}
