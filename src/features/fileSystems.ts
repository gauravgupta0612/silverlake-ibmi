import * as vscode from 'vscode';
import { ConnectionManager } from '../core/manager';
import { errorMessage, log, logError } from '../core/log';
import { parseMemberPath, clString, memberPath } from '../core/util';
import { SourceRecord, mergeRecords, tooLongLines } from '../core/sourceDates';
import type { MemberLock } from '../core/connection';

export const MEMBER_SCHEME = 'vanthrex-member';
export const IFS_SCHEME = 'vanthrex-ifs';

/** Fired after a member / stream file is read from or written to the IBM i (used by local history). */
export interface FsTransfer { uri: vscode.Uri; content: Uint8Array; kind: 'read' | 'write'; }
export const fsEvents = new vscode.EventEmitter<FsTransfer>();

/** SEU sequence numbers and dates of each opened member, as last read from / written to the IBM i. */
export const sourceRecords = new Map<string, SourceRecord[]>();
export const sourceRecordsChanged = new vscode.EventEmitter<vscode.Uri>();

/** Other jobs holding a lock on each opened member (refreshed on open and before save). */
export const memberLocks = new Map<string, MemberLock[]>();
export const memberLocksChanged = new vscode.EventEmitter<{ uri: vscode.Uri; onOpen: boolean }>();

export function describeLock(l: MemberLock): string {
  return `${l.userText ? `${l.userText} (${l.user})` : l.user} in job ${l.job}`;
}

class SaveCancelled extends Error {}

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

/** Source members as editable documents: vanthrex-member:/LIB/FILE/MEMBER.TYPE */
export class MemberFileSystem extends BaseFs {
  private readonly meta = new Map<string, { mtime: number; size: number }>();

  stat(uri: vscode.Uri): vscode.FileStat {
    this.conn();
    const m = this.meta.get(uri.path);
    return { type: vscode.FileType.File, ctime: 0, mtime: m?.mtime ?? Date.now(), size: m?.size ?? 0 };
  }

  readDirectory(): [string, vscode.FileType][] { return []; }

  createDirectory(): void { throw vscode.FileSystemError.NoPermissions('Use "New Source File…" in the Libraries view.'); }

  /** Change timestamp of each member when it was opened, to detect changes made by others. */
  private readonly openedAt = new Map<string, string | undefined>();

  async readFile(uri: vscode.Uri): Promise<Uint8Array> {
    const { library, file, member } = parseMemberPath(uri.path);
    const conn = this.conn();
    const checking = vscode.workspace.getConfiguration('vanthrex').get<boolean>('conflictCheck', true);
    try {
      // Take the change time *before* reading, so a change made while we read is still detected on save.
      const state = checking ? await conn.memberState(library, file, member).catch(() => undefined) : undefined;
      let text: string;
      let records: SourceRecord[] | undefined;
      if (await conn.canKeepSourceDates()) {
        try {
          records = await conn.readMemberRecords(library, file, member);
        } catch (e) {
          // Never block opening the source: fall back to a plain copy (dates are then not shown).
          logError(e);
          log(`Reading ${library}/${file}(${member}) with source dates failed — opening it without dates.`);
        }
      }
      if (records) {
        sourceRecords.set(uri.toString(), records);
        sourceRecordsChanged.fire(uri);
        text = records.map(r => r.text).join('\n');
        if (records.length) { text += '\n'; }
      } else {
        sourceRecords.delete(uri.toString());
        text = await conn.readMember(library, file, member);
      }
      const data = Buffer.from(text, 'utf8');
      this.meta.set(uri.path, { mtime: Date.now(), size: data.length });
      fsEvents.fire({ uri, content: data, kind: 'read' });
      if (state) {
        this.openedAt.set(uri.toString(), state.changed);
        memberLocks.set(uri.toString(), state.locks);
        memberLocksChanged.fire({ uri, onOpen: true });
      }
      return data;
    } catch (e) {
      logError(e);
      throw vscode.FileSystemError.FileNotFound(`${library}/${file}(${member}): ${errorMessage(e)}`);
    }
  }

  /** Ask before overwriting a member that changed on the IBM i or is locked by another job. */
  private async checkBeforeSave(uri: vscode.Uri, library: string, file: string, member: string): Promise<void> {
    if (!vscode.workspace.getConfiguration('vanthrex').get<boolean>('conflictCheck', true)) { return; }
    const state = await this.conn().memberState(library, file, member);
    const opened = this.openedAt.get(uri.toString());
    if (opened && state.changed && state.changed !== opened) {
      const choice = await vscode.window.showWarningMessage(
        `${library}/${file}(${member}) was changed on the IBM i after you opened it (at ${state.changed.replace(/\.\d+$/, '')}).`,
        { modal: true, detail: 'Saving now would overwrite those changes.' }, 'Compare First', 'Overwrite');
      if (choice === 'Compare First') {
        vscode.commands.executeCommand('vanthrex.compareWithServer', uri);
        throw new SaveCancelled('Save cancelled — compare the versions, then save again.');
      }
      if (choice !== 'Overwrite') { throw new SaveCancelled('Save cancelled.'); }
    }
    memberLocks.set(uri.toString(), state.locks);
    memberLocksChanged.fire({ uri, onOpen: false });
    if (state.locks.length) {
      const choice = await vscode.window.showWarningMessage(
        `🔒 ${library}/${file}(${member}) is locked by ${state.locks.map(describeLock).join(', ')}.`,
        { modal: true, detail: 'They may be editing it (for example in SEU). If you save now, the save can fail or one of you can lose changes.' },
        'Ask Them to Release It', 'Save Anyway');
      if (choice === 'Ask Them to Release It') {
        vscode.commands.executeCommand('vanthrex.lockAskRelease', uri, state.locks[0]);
        throw new SaveCancelled('Save postponed — waiting for the lock to be released.');
      }
      if (choice !== 'Save Anyway') { throw new SaveCancelled('Save cancelled.'); }
    }
  }

  async writeFile(uri: vscode.Uri, content: Uint8Array): Promise<void> {
    const { library, file, member } = parseMemberPath(uri.path);
    const conn = this.conn();
    const text = Buffer.from(content).toString('utf8').replace(/\r\n/g, '\n');
    // Source records never keep trailing blanks, so compare and store lines without them.
    const lines = text.split('\n').map(l => l.replace(/\s+$/, ''));
    if (lines.length && lines[lines.length - 1] === '') { lines.pop(); }
    try {
      await this.checkBeforeSave(uri, library, file, member);
      const max = await conn.sourceLineLength(library, file).catch(() => 0);
      const long = max ? tooLongLines(lines, max) : [];
      if (long.length) {
        throw new Error(`Line${long.length > 1 ? 's' : ''} ${long.slice(0, 10).join(', ')}${long.length > 10 ? '…' : ''} ` +
          `${long.length > 1 ? 'are' : 'is'} longer than the ${max} characters ${library}/${file} can hold. Shorten ${long.length > 1 ? 'them' : 'it'} and save again.`);
      }
      const original = sourceRecords.get(uri.toString());
      if (original && await conn.canKeepSourceDates()) {
        // Today's date as the IBM i sees it (YYMMDD), for changed lines.
        const today = Number((await conn.rows<{ D: string }>(
          `SELECT VARCHAR_FORMAT(CURRENT TIMESTAMP, 'YYMMDD') AS D FROM SYSIBM.SYSDUMMY1`, 1))[0]?.D);
        if (!today) { throw new Error('Could not read the IBM i date.'); }
        const merged = mergeRecords(original, lines, today);
        await conn.writeMemberRecords(library, file, member, merged);
        sourceRecords.set(uri.toString(), merged);
        sourceRecordsChanged.fire(uri);
      } else {
        await conn.writeMember(library, file, member, lines.join('\n'));
      }
      this.openedAt.set(uri.toString(), (await conn.memberState(library, file, member)).changed);
    } catch (e) {
      if (e instanceof SaveCancelled) { throw vscode.FileSystemError.NoPermissions(e.message); }
      throw e;
    }
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

/** IFS stream files: vanthrex-ifs:/home/me/src/hello.rpgle */
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
