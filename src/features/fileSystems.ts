import * as vscode from 'vscode';
import { ConnectionManager } from '../core/manager';
import { errorMessage, logError } from '../core/log';
import { parseMemberPath, clString, memberPath } from '../core/util';

export const MEMBER_SCHEME = 'silverlake-member';
export const IFS_SCHEME = 'silverlake-ifs';

/** Fired after a member / stream file is read from or written to the IBM i (used by local history). */
export interface FsTransfer { uri: vscode.Uri; content: Uint8Array; kind: 'read' | 'write'; }
export const fsEvents = new vscode.EventEmitter<FsTransfer>();

export function memberUri(lib: string, file: string, member: string, type: string): vscode.Uri {
  const ext = (type || 'mbr').toLowerCase();
  return vscode.Uri.from({ scheme: MEMBER_SCHEME, path: `/${lib}/${file}/${member}.${ext}` });
}

export function ifsUri(path: string): vscode.Uri {
  return vscode.Uri.from({ scheme: IFS_SCHEME, path });
}

abstract class BaseFs implements vscode.FileSystemProvider {
  protected readonly emitter = new vscode.EventEmitter<vscode.FileChangeEvent[]>();
  readonly onDidChangeFile = this.emitter.event;

  constructor(protected readonly manager: ConnectionManager) {}

  protected conn() {
    const c = this.manager.connection;
    if (!c) { throw vscode.FileSystemError.Unavailable('Not connected to an IBM i system.'); }
    return c;
  }

  watch(): vscode.Disposable { return new vscode.Disposable(() => undefined); }

  abstract stat(uri: vscode.Uri): vscode.FileStat | Thenable<vscode.FileStat>;
  abstract readDirectory(uri: vscode.Uri): [string, vscode.FileType][] | Thenable<[string, vscode.FileType][]>;
  abstract createDirectory(uri: vscode.Uri): void | Thenable<void>;
  abstract readFile(uri: vscode.Uri): Uint8Array | Thenable<Uint8Array>;
  abstract writeFile(uri: vscode.Uri, content: Uint8Array, options: { create: boolean; overwrite: boolean }): void | Thenable<void>;
  abstract delete(uri: vscode.Uri, options: { recursive: boolean }): void | Thenable<void>;
  abstract rename(oldUri: vscode.Uri, newUri: vscode.Uri, options: { overwrite: boolean }): void | Thenable<void>;
}

/** Source members as editable documents: silverlake-member:/LIB/FILE/MEMBER.TYPE */
export class MemberFileSystem extends BaseFs {
  private readonly meta = new Map<string, { mtime: number; size: number }>();

  stat(uri: vscode.Uri): vscode.FileStat {
    this.conn();
    const m = this.meta.get(uri.path);
    return { type: vscode.FileType.File, ctime: 0, mtime: m?.mtime ?? Date.now(), size: m?.size ?? 0 };
  }

  readDirectory(): [string, vscode.FileType][] { return []; }

  createDirectory(): void { throw vscode.FileSystemError.NoPermissions('Use "New Source File…" in the Libraries view.'); }

  async readFile(uri: vscode.Uri): Promise<Uint8Array> {
    const { library, file, member } = parseMemberPath(uri.path);
    try {
      const text = await this.conn().readMember(library, file, member);
      const data = Buffer.from(text, 'utf8');
      this.meta.set(uri.path, { mtime: Date.now(), size: data.length });
      fsEvents.fire({ uri, content: data, kind: 'read' });
      return data;
    } catch (e) {
      logError(e);
      throw vscode.FileSystemError.FileNotFound(`${library}/${file}(${member}): ${errorMessage(e)}`);
    }
  }

  async writeFile(uri: vscode.Uri, content: Uint8Array): Promise<void> {
    const { library, file, member } = parseMemberPath(uri.path);
    await this.conn().writeMember(library, file, member, Buffer.from(content).toString('utf8'));
    this.meta.set(uri.path, { mtime: Date.now(), size: content.length });
    fsEvents.fire({ uri, content, kind: 'write' });
    this.emitter.fire([{ type: vscode.FileChangeType.Changed, uri }]);
  }

  async delete(uri: vscode.Uri): Promise<void> {
    const { library, file, member } = parseMemberPath(uri.path);
    const r = await this.conn().runCL(`RMVM FILE(${library}/${file}) MBR(${member})`);
    if (!r.ok) { throw vscode.FileSystemError.NoPermissions(r.stderr || r.stdout); }
    this.emitter.fire([{ type: vscode.FileChangeType.Deleted, uri }]);
  }

  async rename(oldUri: vscode.Uri, newUri: vscode.Uri): Promise<void> {
    const a = parseMemberPath(oldUri.path);
    const b = parseMemberPath(newUri.path);
    if (a.library !== b.library || a.file !== b.file) {
      throw vscode.FileSystemError.NoPermissions('Members can only be renamed within the same source file.');
    }
    const r = await this.conn().runCL(`RNMM FILE(${a.library}/${a.file}) MBR(${a.member}) NEWMBR(${b.member})`);
    if (!r.ok) { throw vscode.FileSystemError.NoPermissions(r.stderr || r.stdout); }
  }

  /** Path on IBM i of the member behind a URI (used by compile). */
  static qsysPath(uri: vscode.Uri): string {
    const { library, file, member } = parseMemberPath(uri.path);
    return clString(memberPath(library, file, member));
  }
}

/** IFS stream files: silverlake-ifs:/home/me/src/hello.rpgle */
export class IfsFileSystem extends BaseFs {
  async stat(uri: vscode.Uri): Promise<vscode.FileStat> {
    try {
      const s = await this.conn().stat(uri.path);
      return {
        type: s.isDirectory() ? vscode.FileType.Directory : vscode.FileType.File,
        ctime: s.mtime * 1000,
        mtime: s.mtime * 1000,
        size: s.size,
      };
    } catch {
      throw vscode.FileSystemError.FileNotFound(uri);
    }
  }

  async readDirectory(uri: vscode.Uri): Promise<[string, vscode.FileType][]> {
    const list = await this.conn().readDirectory(uri.path);
    return list
      .filter(e => e.filename !== '.' && e.filename !== '..')
      .map(e => [e.filename, e.longname.startsWith('d') ? vscode.FileType.Directory : vscode.FileType.File]);
  }

  async createDirectory(uri: vscode.Uri): Promise<void> {
    await this.conn().mkdir(uri.path);
    this.emitter.fire([{ type: vscode.FileChangeType.Created, uri }]);
  }

  async readFile(uri: vscode.Uri): Promise<Uint8Array> {
    try {
      const data = await this.conn().readStreamFile(uri.path);
      fsEvents.fire({ uri, content: data, kind: 'read' });
      return data;
    } catch (e) {
      throw vscode.FileSystemError.FileNotFound(`${uri.path}: ${errorMessage(e)}`);
    }
  }

  async writeFile(uri: vscode.Uri, content: Uint8Array, options: { create: boolean; overwrite: boolean }): Promise<void> {
    const conn = this.conn();
    let exists = true;
    try { await conn.stat(uri.path); } catch { exists = false; }
    if (!exists && !options.create) { throw vscode.FileSystemError.FileNotFound(uri); }
    if (exists && !options.overwrite) { throw vscode.FileSystemError.FileExists(uri); }
    await conn.writeStreamFile(uri.path, content);
    fsEvents.fire({ uri, content, kind: 'write' });
    if (!exists) {
      // Tag new files as UTF-8 so compilers and editors on IBM i read them correctly.
      await conn.exec(`/QOpenSys/usr/bin/setccsid 1208 '${uri.path.replace(/'/g, `'\\''`)}'`);
    }
    this.emitter.fire([{ type: exists ? vscode.FileChangeType.Changed : vscode.FileChangeType.Created, uri }]);
  }

  async delete(uri: vscode.Uri, options: { recursive: boolean }): Promise<void> {
    await this.conn().removePath(uri.path, options.recursive);
    this.emitter.fire([{ type: vscode.FileChangeType.Deleted, uri }]);
  }

  async rename(oldUri: vscode.Uri, newUri: vscode.Uri): Promise<void> {
    await this.conn().renamePath(oldUri.path, newUri.path);
    this.emitter.fire([
      { type: vscode.FileChangeType.Deleted, uri: oldUri },
      { type: vscode.FileChangeType.Created, uri: newUri },
    ]);
  }
}
