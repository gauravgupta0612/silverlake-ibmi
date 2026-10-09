// Locate and read the source a program was compiled from, with the prototypes of its /COPY members.
// Shared by "Who calls each exported procedure?" and the call graph's "Find dynamic calls".

import * as vscode from 'vscode';
import { IbmiConnection } from '../core/connection';
import { errorMessage, log } from '../core/log';
import { sqlString } from '../core/util';
import { Prototype, ScanLanguage, copyMembers, findPrototypes, scanLanguage } from '../rpg/callScan';
import { ifsUri, memberUri } from './fileSystems';

/** One module's source (an OPM program has a single one). */
export interface SourceRef {
  program: string;        // LIB/NAME
  module: string;
  lib?: string; file?: string; member?: string;
  stmf?: string;
  type: string;           // source type (RPGLE, SQLRPGLE, CLLE…) or module attribute
}

export function sourceLabel(r: SourceRef): string {
  return r.stmf || (r.file ? `${r.lib}/${r.file}(${r.member})` : '');
}

export function languageOf(r: SourceRef): ScanLanguage {
  return scanLanguage(r.stmf ? r.stmf : r.type);
}

const v = (r: Record<string, unknown>, k: string) => String(r[k] ?? '').trim();

function chunks<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) { out.push(items.slice(i, i + size)); }
  return out;
}

/** Source of every module of the given programs (key LIB/NAME). Programs without source info are left out. */
export async function sourcesOfPrograms(conn: IbmiConnection, programs: { lib: string; name: string }[]): Promise<Map<string, SourceRef[]>> {
  const out = new Map<string, SourceRef[]>();
  const add = (ref: SourceRef) => (out.get(ref.program) ?? out.set(ref.program, []).get(ref.program)!).push(ref);
  const where = (ps: { lib: string; name: string }[]) =>
    ps.map(p => `(PROGRAM_LIBRARY = ${sqlString(p.lib)} AND PROGRAM_NAME = ${sqlString(p.name)})`).join(' OR ');

  for (const part of chunks(programs, 40)) {
    try {
      const rows = await conn.rows<Record<string, unknown>>(
        `SELECT PROGRAM_LIBRARY, PROGRAM_NAME, BOUND_MODULE, COALESCE(MODULE_ATTRIBUTE, '') AS ATTR, ` +
        `COALESCE(SOURCE_FILE_LIBRARY, '') AS LIB, COALESCE(SOURCE_FILE, '') AS FILE, COALESCE(SOURCE_FILE_MEMBER, '') AS MBR, ` +
        `COALESCE(SOURCE_STREAM_FILE_PATH, '') AS STMF FROM QSYS2.BOUND_MODULE_INFO WHERE ${where(part)}`, 20000);
      for (const r of rows) {
        const ref: SourceRef = { program: `${v(r, 'PROGRAM_LIBRARY')}/${v(r, 'PROGRAM_NAME')}`, module: v(r, 'BOUND_MODULE'), type: v(r, 'ATTR') };
        if (v(r, 'STMF')) { ref.stmf = v(r, 'STMF'); } else if (v(r, 'FILE')) { Object.assign(ref, { lib: v(r, 'LIB'), file: v(r, 'FILE'), member: v(r, 'MBR') }); }
        add(ref);
      }
    } catch (e) { log(`BOUND_MODULE_INFO: ${errorMessage(e)}`); }
  }
  // OPM programs have no bound modules: their source is in PROGRAM_INFO.
  const missing = programs.filter(p => !out.has(`${p.lib}/${p.name}`));
  for (const part of chunks(missing, 40)) {
    try {
      const rows = await conn.rows<Record<string, unknown>>(
        `SELECT PROGRAM_LIBRARY, PROGRAM_NAME, COALESCE(SOURCE_FILE_LIBRARY, '') AS LIB, COALESCE(SOURCE_FILE, '') AS FILE, ` +
        `COALESCE(SOURCE_FILE_MEMBER, '') AS MBR FROM QSYS2.PROGRAM_INFO WHERE ${where(part)}`, 5000);
      for (const r of rows) {
        if (!v(r, 'FILE')) { continue; }
        add({ program: `${v(r, 'PROGRAM_LIBRARY')}/${v(r, 'PROGRAM_NAME')}`, module: v(r, 'PROGRAM_NAME'), lib: v(r, 'LIB'), file: v(r, 'FILE'), member: v(r, 'MBR'), type: '' });
      }
    } catch (e) { log(`PROGRAM_INFO: ${errorMessage(e)}`); }
  }
  // The member's source type tells SQLRPGLE from RPGLE and RPG from RPGLE.
  const members = [...out.values()].flat().filter(r => r.file);
  for (const part of chunks(members, 40)) {
    try {
      const rows = await conn.rows<Record<string, unknown>>(
        `SELECT SYSTEM_TABLE_SCHEMA AS L, SYSTEM_TABLE_NAME AS F, SYSTEM_TABLE_MEMBER AS M, COALESCE(SOURCE_TYPE, '') AS T ` +
        `FROM QSYS2.SYSPARTITIONSTAT WHERE ` +
        part.map(r => `(SYSTEM_TABLE_SCHEMA = ${sqlString(r.lib!)} AND SYSTEM_TABLE_NAME = ${sqlString(r.file!)} AND SYSTEM_TABLE_MEMBER = ${sqlString(r.member!)})`).join(' OR '), 5000);
      const types = new Map(rows.map(r => [`${v(r, 'L')}/${v(r, 'F')}(${v(r, 'M')})`, v(r, 'T')]));
      for (const r of part) { r.type = types.get(sourceLabel(r)) || r.type; }
    } catch (e) { log(`SYSPARTITIONSTAT: ${errorMessage(e)}`); }
  }
  return out;
}

/** Reads sources once per scan (copybooks are shared by many programs). */
export class SourceReader {
  private readonly cache = new Map<string, Promise<string>>();
  constructor(private readonly conn: IbmiConnection) {}

  read(r: { lib?: string; file?: string; member?: string; stmf?: string }): Promise<string> {
    const key = r.stmf || `${r.lib}/${r.file}(${r.member})`;
    let p = this.cache.get(key);
    if (!p) {
      p = r.stmf ? this.conn.readStreamFile(r.stmf).then(b => b.toString('utf8')) : this.conn.readMember(r.lib!, r.file!, r.member!);
      this.cache.set(key, p);
    }
    return p;
  }

  /** Prototypes declared in the /COPY and /INCLUDE members of an RPG source (two levels deep). */
  async copiedPrototypes(text: string, from: SourceRef, depth = 2): Promise<{ prototypes: Prototype[]; missing: string[] }> {
    const prototypes: Prototype[] = [];
    const missing: string[] = [];
    if (depth <= 0) { return { prototypes, missing }; }
    for (const c of copyMembers(text).slice(0, 30)) {
      const target = c.ifsPath
        ? (c.ifsPath.startsWith('/') ? { stmf: c.ifsPath } : undefined)
        : c.member ? { lib: c.library || from.lib, file: c.file || 'QRPGLESRC', member: c.member } : undefined;
      if (!target || (!target.stmf && !target.lib)) { missing.push(c.target); continue; }
      try {
        const copied = await this.read(target);
        prototypes.push(...findPrototypes(copied));
        const nested = await this.copiedPrototypes(copied, { ...from, ...target }, depth - 1);
        prototypes.push(...nested.prototypes); missing.push(...nested.missing);
      } catch { missing.push(c.target); }
    }
    return { prototypes, missing };
  }
}

/** Run `fn` over `items` with at most `limit` at a time. */
export async function eachLimited<T>(items: T[], limit: number, fn: (item: T) => Promise<void>, token?: vscode.CancellationToken): Promise<void> {
  let next = 0;
  const worker = async () => {
    while (next < items.length && !token?.isCancellationRequested) { await fn(items[next++]); }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
}

/** Open a source member or stream file at a line (1-based). */
export async function openSourceAtLine(r: { lib?: string; file?: string; member?: string; stmf?: string; type?: string }, line: number): Promise<void> {
  const uri = r.stmf ? ifsUri(r.stmf) : memberUri(r.lib!, r.file!, r.member!, r.type || 'mbr');
  const pos = new vscode.Position(Math.max(0, line - 1), 0);
  await vscode.window.showTextDocument(uri, { selection: new vscode.Range(pos, pos) });
}
