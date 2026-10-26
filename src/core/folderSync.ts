// Compare a local folder with an IFS folder, and the PASE commands that pack and unpack archives on the IFS.
// Pure (no vscode import), unit tested.

export interface SideFile { rel: string; size: number; mtimeMs: number }
export type CompareStatus = 'onlyLocal' | 'onlyIfs' | 'localNewer' | 'ifsNewer' | 'different' | 'same';
export interface CompareRow { rel: string; status: CompareStatus; local?: SideFile; ifs?: SideFile }

/** Same size and times within 2 seconds = same; otherwise the newer side wins the label. */
export function compareFolders(local: SideFile[], ifs: SideFile[]): CompareRow[] {
  const l = new Map(local.map(f => [f.rel, f])); const r = new Map(ifs.map(f => [f.rel, f]));
  const rows: CompareRow[] = [];
  for (const rel of [...new Set([...l.keys(), ...r.keys()])].sort()) {
    const a = l.get(rel); const b = r.get(rel);
    let status: CompareStatus;
    if (a && !b) { status = 'onlyLocal'; } else if (!a && b) { status = 'onlyIfs'; }
    else if (a!.size === b!.size && Math.abs(a!.mtimeMs - b!.mtimeMs) <= 2000) { status = 'same'; }
    else if (Math.abs(a!.mtimeMs - b!.mtimeMs) <= 2000) { status = 'different'; }
    else { status = a!.mtimeMs > b!.mtimeMs ? 'localNewer' : 'ifsNewer'; }
    rows.push({ rel, status, local: a, ifs: b });
  }
  const order: CompareStatus[] = ['localNewer', 'ifsNewer', 'different', 'onlyLocal', 'onlyIfs', 'same'];
  return rows.sort((x, y) => order.indexOf(x.status) - order.indexOf(y.status) || x.rel.localeCompare(y.rel));
}

export type ArchiveKind = 'zip' | 'tar' | 'tgz' | 'gz';

export function archiveKind(name: string): ArchiveKind | undefined {
  const n = name.toLowerCase();
  if (/\.(zip|jar|war|ear)$/.test(n)) { return 'zip'; }
  if (/\.(tar\.gz|tgz)$/.test(n)) { return 'tgz'; }
  if (/\.tar$/.test(n)) { return 'tar'; }
  if (/\.gz$/.test(n)) { return 'gz'; }
  return undefined;
}

const shq = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;
const dirOf = (p: string) => p.replace(/\/[^/]*$/, '') || '/';
const baseOf = (p: string) => p.replace(/\/+$/, '').split('/').pop() ?? p;

export interface Tools { zip: boolean; unzip: boolean; jar: boolean }

/** Shell command to extract an archive into `dest` (created when missing). */
export function extractCommand(path: string, dest: string, tools: Tools): string {
  const kind = archiveKind(path);
  const mk = `mkdir -p ${shq(dest)} && cd ${shq(dest)} && `;
  switch (kind) {
    case 'zip':
      if (tools.unzip) { return mk + `unzip -o ${shq(path)}`; }
      if (tools.jar) { return mk + `jar xf ${shq(path)}`; }
      throw new Error('Neither unzip nor jar is available on the IBM i (install unzip with yum, or Java).');
    case 'tgz': return mk + `gzip -dc ${shq(path)} | tar -xf -`;
    case 'tar': return mk + `tar -xf ${shq(path)}`;
    case 'gz': return `gzip -dc ${shq(path)} > ${shq(dest.replace(/\/+$/, '') + '/' + baseOf(path).replace(/\.gz$/i, ''))}`;
    default: throw new Error(`${baseOf(path)} is not an archive Vanthrex can extract (.zip, .jar, .tar, .tar.gz, .tgz, .gz).`);
  }
}

/** Shell command to pack files or folders (all in the same folder) into an archive. */
export function compressCommand(paths: string[], archive: string, tools: Tools): string {
  if (!paths.length) { throw new Error('Nothing to compress.'); }
  const dir = dirOf(paths[0]);
  if (paths.some(p => dirOf(p) !== dir)) { throw new Error('Compress files of one folder at a time.'); }
  const names = paths.map(p => shq(baseOf(p))).join(' ');
  const kind = archiveKind(archive);
  const cd = `cd ${shq(dir)} && `;
  if (kind === 'zip') {
    if (tools.zip) { return cd + `zip -r -q ${shq(archive)} ${names}`; }
    if (tools.jar) { return cd + `jar cMf ${shq(archive)} ${names}`; }
    throw new Error('Neither zip nor jar is available on the IBM i (install zip with yum, or Java).');
  }
  if (kind === 'tgz') { return cd + `tar -cf - ${names} | gzip -c > ${shq(archive)}`; }
  if (kind === 'tar') { return cd + `tar -cf ${shq(archive)} ${names}`; }
  throw new Error('Choose a .zip, .tar or .tar.gz name.');
}
