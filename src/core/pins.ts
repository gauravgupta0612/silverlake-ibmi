// Pinned members, files, libraries, objects and IFS paths. Pure functions (no vscode import), unit tested.


export type PinKind = 'member' | 'srcfile' | 'library' | 'object' | 'ifs';

export interface Pin { kind: PinKind; library?: string; file?: string; name?: string; type?: string; path?: string; text?: string }

export function pinKey(p: Pin): string {
  return p.kind === 'ifs' ? `ifs:${p.path}` : `${p.kind}:${p.library ?? ''}/${p.file ?? ''}/${p.name ?? ''}/${p.type ?? ''}`.toUpperCase();
}

export function pinLabel(p: Pin): string {
  switch (p.kind) {
    case 'member': return `${p.name}.${(p.type ?? '').toLowerCase()}`;
    case 'srcfile': return `${p.library}/${p.file}`;
    case 'library': return p.library ?? '';
    case 'object': return `${p.library}/${p.name}`;
    case 'ifs': return (p.path ?? '').split('/').filter(Boolean).pop() ?? p.path ?? '/';
  }
}

export function pinDescription(p: Pin): string {
  switch (p.kind) {
    case 'member': return `${p.library}/${p.file}${p.text ? ` · ${p.text}` : ''}`;
    case 'object': return `${p.type ?? ''}${p.text ? ` · ${p.text}` : ''}`;
    case 'ifs': return p.path ?? '';
    default: return p.text ?? '';
  }
}

export function togglePin(list: Pin[], p: Pin): { list: Pin[]; pinned: boolean } {
  const k = pinKey(p);
  if (list.some(x => pinKey(x) === k)) { return { list: list.filter(x => pinKey(x) !== k), pinned: false }; }
  return { list: [...list, p], pinned: true };
}

export function movePin(list: Pin[], key: string, delta: number): Pin[] {
  const i = list.findIndex(x => pinKey(x) === key);
  const j = i + delta;
  if (i < 0 || j < 0 || j >= list.length) { return list; }
  const out = [...list];
  [out[i], out[j]] = [out[j], out[i]];
  return out;
}
