// Reads the real system facts the AI commands need: IBM help for compile errors, program dependencies,
// and the job log with the failing source statement.

import * as vscode from 'vscode';
import { IbmiConnection } from '../core/connection';
import { errorMessage, log } from '../core/log';
import { parseMemberPath, sqlString } from '../core/util';
import { messageFileFor } from '../core/insights';
import { dataStructures } from '../core/v29';
import { exportedProcedures } from '../core/codeTools';
import { MEMBER_SCHEME } from '../features/fileSystems';
import {
  Dependencies, Diag, Failing, JobLogRow, dependenciesForModel, errorSnippets, failingProgram, fileUsage, jobLogForModel, lineForStatement,
  messageIds, parseSpooledJobLog, plainHelp, sourceWindow,
} from './context';

type Row = Record<string, unknown>;
const s = (r: Row | undefined, ...keys: string[]) => { for (const k of keys) { const v = String(r?.[k] ?? '').trim(); if (v) { return v; } } return ''; };
const NAME = /^[A-Z$#@][A-Z0-9$#@_.]{0,9}$/;

// ---------------------------------------------------------------- compile errors

const helpCache = new Map<string, string>();
async function messageHelp(conn: IbmiConnection, ids: string[]): Promise<string[]> {
  const out: string[] = [];
  for (const id of ids.slice(0, 12)) {
    if (!helpCache.has(id)) {
      const f = messageFileFor(id);
      let t = '';
      if (f) {
        try {
          const r = (await conn.rows<Row>(`SELECT MESSAGE_TEXT AS T, COALESCE(MESSAGE_SECOND_LEVEL_TEXT, '') AS H FROM QSYS2.MESSAGE_FILE_DATA WHERE MESSAGE_FILE_LIBRARY = ${sqlString(f.library)} AND MESSAGE_FILE = ${sqlString(f.file)} AND MESSAGE_ID = ${sqlString(id)}`, 1))[0];
          if (r) { t = `${s(r, 'T')}\n${plainHelp(s(r, 'H')).slice(0, 1200)}`; }
        } catch (e) { log(`Message help ${id}: ${errorMessage(e)}`); }
      }
      helpCache.set(id, t);
    }
    const t = helpCache.get(id);
    if (t) { out.push(`${id}: ${t}`); }
  }
  return out;
}

/** The lines around each error and IBM's help for each message ID. */
export async function compileErrorContext(conn: IbmiConnection | undefined, text: string, diags: Diag[]): Promise<string[]> {
  if (!diags.length) { return []; }
  const out = [`The lines around each error (>> marks the line the compiler reported):\n\`\`\`\n${errorSnippets(text, diags)}\n\`\`\``];
  if (conn) { const h = await messageHelp(conn, messageIds(diags)); if (h.length) { out.push(`IBM help text for these messages:\n${h.join('\n\n')}`); } }
  return out;
}

// ---------------------------------------------------------------- unit tests

/** Procedure signatures and data structure layouts, so tests use the right parameter types. */
export function testContext(text: string): string[] {
  const out: string[] = [];
  try {
    const procs = exportedProcedures(text);
    if (procs.length) { out.push('Exported procedures and their parameters:\n' + procs.map(p => `- ${p.name}(${p.params.map(x => `${x.name} ${x.type}`).join('; ')})${p.returns ? ` returns ${p.returns}` : ''}`).join('\n')); }
    const ds = dataStructures(text).filter(d => d.fields.length).slice(0, 15);
    if (ds.length) { out.push('Data structures (subfield: type, positions):\n' + ds.map(d => `- ${d.name}${d.qualified ? ' (qualified)' : ''}, ${d.length ?? '?'} bytes: ` + d.fields.slice(0, 30).map(f => `${f.name} ${f.type}${f.dim ? ` dim(${f.dim})` : ''}`).join(', ')).join('\n')); }
  } catch (e) { log(`Test context: ${errorMessage(e)}`); }
  return out;
}

// ---------------------------------------------------------------- dependencies

/** Programs compiled from a member (OPM directly, ILE through their modules). */
export async function programsFromMember(conn: IbmiConnection, uri: vscode.Uri): Promise<{ lib: string; name: string; type: string }[]> {
  if (uri.scheme !== MEMBER_SCHEME) { return []; }
  const m = parseMemberPath(uri.path);
  const w = `SOURCE_FILE_LIBRARY = ${sqlString(m.library)} AND SOURCE_FILE = ${sqlString(m.file)} AND SOURCE_FILE_MEMBER = ${sqlString(m.member)}`;
  const [a, b] = await Promise.all([
    conn.rows<Row>(`SELECT PROGRAM_LIBRARY AS L, PROGRAM_NAME AS N, OBJECT_TYPE AS T FROM QSYS2.PROGRAM_INFO WHERE ${w}`, 20).catch(() => [] as Row[]),
    conn.rows<Row>(`SELECT DISTINCT PROGRAM_LIBRARY AS L, PROGRAM_NAME AS N, OBJECT_TYPE AS T FROM QSYS2.BOUND_MODULE_INFO WHERE ${w}`, 20).catch(() => [] as Row[]),
  ]);
  const seen = new Set<string>();
  return [...a, ...b].map(r => ({ lib: s(r, 'L'), name: s(r, 'N'), type: s(r, 'T') || '*PGM' })).filter(x => x.name && !seen.has(`${x.lib}/${x.name}`) && seen.add(`${x.lib}/${x.name}`));
}

export async function dependencies(conn: IbmiConnection, lib: string, name: string, type?: string): Promise<Dependencies> {
  if (!NAME.test(lib) || !NAME.test(name)) { throw new Error(vscode.l10n.t('Invalid object name.')); }
  const t = type && /^\*(PGM|SRVPGM)$/.test(type) ? type : undefined;
  const info = (await conn.rows<Row>(`SELECT * FROM QSYS2.PROGRAM_INFO WHERE PROGRAM_LIBRARY = ${sqlString(lib)} AND PROGRAM_NAME = ${sqlString(name)}${t ? ` AND OBJECT_TYPE = ${sqlString(t)}` : ''}`, 1))[0];
  if (!info) { throw new Error(vscode.l10n.t('{0}/{1} is not a program or service program.', lib, name)); }
  const objType = s(info, 'OBJECT_TYPE') || '*PGM';
  const libs = [...new Set([lib, conn.profile.currentLibrary, ...(conn.profile.libraries ?? [])].filter(Boolean).map(x => x!.toUpperCase()))];
  const [mods, srvs, usedBy] = await Promise.all([
    conn.rows<Row>(`SELECT BOUND_MODULE_LIBRARY AS L, BOUND_MODULE AS N, COALESCE(MODULE_ATTRIBUTE, '') AS A, COALESCE(SOURCE_FILE_LIBRARY, '') AS SL, COALESCE(SOURCE_FILE, '') AS SF, COALESCE(SOURCE_FILE_MEMBER, '') AS SM ` +
      `FROM QSYS2.BOUND_MODULE_INFO WHERE PROGRAM_LIBRARY = ${sqlString(lib)} AND PROGRAM_NAME = ${sqlString(name)} AND OBJECT_TYPE = ${sqlString(objType)}`, 500).catch(() => [] as Row[]),
    conn.rows<Row>(`SELECT BOUND_SERVICE_PROGRAM_LIBRARY AS L, BOUND_SERVICE_PROGRAM AS N, COALESCE(BOUND_SERVICE_PROGRAM_ACTIVATION, '') AS A ` +
      `FROM QSYS2.BOUND_SRVPGM_INFO WHERE PROGRAM_LIBRARY = ${sqlString(lib)} AND PROGRAM_NAME = ${sqlString(name)} AND OBJECT_TYPE = ${sqlString(objType)}`, 500).catch(() => [] as Row[]),
    objType === '*SRVPGM'
      ? conn.rows<Row>(`SELECT PROGRAM_LIBRARY AS L, PROGRAM_NAME AS N, OBJECT_TYPE AS T FROM QSYS2.BOUND_SRVPGM_INFO WHERE BOUND_SERVICE_PROGRAM = ${sqlString(name)} AND BOUND_SERVICE_PROGRAM_LIBRARY IN (${sqlString(lib)}, '*LIBL') AND PROGRAM_LIBRARY IN (${libs.map(sqlString).join(', ')})`, 500).catch(() => [] as Row[])
      : Promise.resolve([] as Row[]),
  ]);
  const d: Dependencies = {
    object: `${lib}/${name}`, type: objType, text: s(info, 'TEXT_DESCRIPTION'), attribute: s(info, 'PROGRAM_ATTRIBUTE', 'OBJECT_ATTRIBUTE'), activationGroup: s(info, 'ACTIVATION_GROUP'),
    created: s(info, 'CREATE_TIMESTAMP', 'PROGRAM_CREATE_TIMESTAMP'),
    source: s(info, 'SOURCE_FILE_MEMBER') ? `${s(info, 'SOURCE_FILE_LIBRARY')}/${s(info, 'SOURCE_FILE')}(${s(info, 'SOURCE_FILE_MEMBER')})` : undefined,
    modules: mods.map(r => ({ lib: s(r, 'L'), name: s(r, 'N'), attribute: s(r, 'A') || undefined, source: s(r, 'SM') ? `${s(r, 'SL')}/${s(r, 'SF')}(${s(r, 'SM')})` : undefined })),
    servicePrograms: srvs.map(r => ({ lib: s(r, 'L'), name: s(r, 'N'), activation: s(r, 'A') || undefined })).filter(x => !/^Q/.test(x.name) || !/^QSYS$/.test(x.lib)),
    refs: [], usedBy: usedBy.map(r => ({ lib: s(r, 'L'), name: s(r, 'N'), type: s(r, 'T') })),
  };
  // Files, programs and data areas: DSPPGMREF into QTEMP, read in the same SQL job.
  try {
    await conn.sql('VALUES 1', 1);
    if (!conn.sqlKeepsJob) { throw new Error(vscode.l10n.t('the SQL engine does not keep its job (QTEMP)')); }
    await conn.sql(`CALL QSYS2.QCMDEXC(${sqlString(`DSPPGMREF PGM(${lib}/${name}) OUTPUT(*OUTFILE) OBJTYPE(${objType}) OUTFILE(QTEMP/VXAIREF)`)})`, 1);
    const refs = await conn.rows<Row>('SELECT DISTINCT WHLNAM, WHFNAM, WHOTYP, WHFUSG FROM QTEMP.VXAIREF', 2000);
    d.refs = refs.map(r => ({ lib: s(r, 'WHLNAM') || '*LIBL', name: s(r, 'WHFNAM'), type: s(r, 'WHOTYP'), usage: fileUsage(s(r, 'WHFUSG')) }))
      .filter(r => r.name && !r.name.startsWith('*') && !/^(QSYS|QSYS2)$/.test(r.lib));
  } catch (e) {
    d.refsNote = `not read (${errorMessage(e).split('\n')[0]})`;
  }
  return d;
}

export async function dependencyContext(conn: IbmiConnection, ref: { library: string; name: string; type?: string }): Promise<{ text: string[]; deps: Dependencies; sourceText?: string; sourceLabel?: string }> {
  const deps = await dependencies(conn, ref.library, ref.name, ref.type);
  const text = [`Dependencies read from the system:\n${dependenciesForModel(deps)}`];
  if (deps.type === '*PGM') { text.push('(Callers of a *PGM are not listed: they need the Call Graph cross-reference — say so if it matters.)'); }
  const src = deps.source ?? deps.modules.find(m => m.source)?.source;
  let sourceText: string | undefined;
  const m = src ? /^([^/]+)\/([^(]+)\(([^)]+)\)$/.exec(src) : null;
  if (m) { sourceText = await conn.readMember(m[1], m[2], m[3]).catch(() => undefined); }
  return { text, deps, sourceText, sourceLabel: src };
}

// ---------------------------------------------------------------- job log

const JOB = /^\d{6}\/[A-Z0-9$#@_.]{1,10}\/[A-Z0-9$#@_.]{1,10}$/;

async function readJobLog(conn: IbmiConnection, job: string): Promise<{ rows: JobLogRow[]; from: string }> {
  try {
    const rows = await conn.rows<Row>(
      `SELECT VARCHAR_FORMAT(MESSAGE_TIMESTAMP, 'YYYY-MM-DD HH24:MI:SS') AS TS, COALESCE(MESSAGE_ID, '') AS ID, COALESCE(MESSAGE_TYPE, '') AS TY, COALESCE(SEVERITY, 0) AS SEV, ` +
      `COALESCE(MESSAGE_TEXT, '') AS TX, COALESCE(MESSAGE_SECOND_LEVEL_TEXT, '') AS HL, COALESCE(FROM_LIBRARY, '') AS FL, COALESCE(FROM_PROGRAM, '') AS FP, COALESCE(FROM_MODULE, '') AS FM, ` +
      `COALESCE(FROM_PROCEDURE, '') AS FR, COALESCE(FROM_INSTRUCTION, '') AS FI, COALESCE(TO_LIBRARY, '') AS TL, COALESCE(TO_PROGRAM, '') AS TP, COALESCE(TO_MODULE, '') AS TM, ` +
      `COALESCE(TO_PROCEDURE, '') AS TR, COALESCE(TO_INSTRUCTION, '') AS TI FROM TABLE(QSYS2.JOBLOG_INFO(${sqlString(job)})) ORDER BY ORDINAL_POSITION`, 20000);
    if (rows.length) {
      return { from: 'JOBLOG_INFO', rows: rows.map(r => ({ id: s(r, 'ID'), type: s(r, 'TY'), severity: Number(r.SEV ?? 0), text: s(r, 'TX'), help: s(r, 'HL'), time: s(r, 'TS'),
        fromLib: s(r, 'FL'), fromPgm: s(r, 'FP'), fromModule: s(r, 'FM'), fromProc: s(r, 'FR'), fromStmt: s(r, 'FI'), toLib: s(r, 'TL'), toPgm: s(r, 'TP'), toModule: s(r, 'TM'), toProc: s(r, 'TR'), toStmt: s(r, 'TI') })) };
    }
  } catch (e) { log(`JOBLOG_INFO ${job}: ${errorMessage(e)}`); }
  // Ended job: the job log is a spooled file.
  const sp = await conn.rows<Row>(`SELECT FILE_NUMBER AS N FROM QSYS2.OUTPUT_QUEUE_ENTRIES_BASIC WHERE JOB_NAME = ${sqlString(job)} AND SPOOLED_FILE_NAME = 'QPJOBLOG' ORDER BY FILE_NUMBER DESC`, 1).catch(() => [] as Row[]);
  if (!sp.length) { throw new Error(vscode.l10n.t('No job log found for {0} (it may have been deleted, or the job did not keep one).', job)); }
  const lines = await conn.rows<Row>(`SELECT SPOOLED_DATA AS D FROM TABLE(SYSTOOLS.SPOOLED_FILE_DATA(JOB_NAME => ${sqlString(job)}, SPOOLED_FILE_NAME => 'QPJOBLOG', SPOOLED_FILE_NUMBER => ${Number(sp[0].N)})) ORDER BY ORDINAL_POSITION`, 100000);
  return { from: 'QPJOBLOG', rows: parseSpooledJobLog(lines.map(r => String(r.D ?? '')).join('\n')) };
}

async function failingSource(conn: IbmiConnection, f: Failing): Promise<{ label: string; lib: string; file: string; member: string } | undefined> {
  if (f.module) {
    const r = (await conn.rows<Row>(`SELECT SOURCE_FILE_LIBRARY AS L, SOURCE_FILE AS F, SOURCE_FILE_MEMBER AS M FROM QSYS2.BOUND_MODULE_INFO WHERE PROGRAM_LIBRARY = ${sqlString(f.lib)} AND PROGRAM_NAME = ${sqlString(f.pgm)} AND BOUND_MODULE = ${sqlString(f.module.toUpperCase())}`, 1).catch(() => [] as Row[]))[0];
    if (s(r, 'M')) { return { lib: s(r, 'L'), file: s(r, 'F'), member: s(r, 'M'), label: `${s(r, 'L')}/${s(r, 'F')}(${s(r, 'M')})` }; }
  }
  const p = (await conn.rows<Row>(`SELECT SOURCE_FILE_LIBRARY AS L, SOURCE_FILE AS F, SOURCE_FILE_MEMBER AS M FROM QSYS2.PROGRAM_INFO WHERE PROGRAM_LIBRARY = ${sqlString(f.lib)} AND PROGRAM_NAME = ${sqlString(f.pgm)}`, 1).catch(() => [] as Row[]))[0];
  if (s(p, 'M')) { return { lib: s(p, 'L'), file: s(p, 'F'), member: s(p, 'M'), label: `${s(p, 'L')}/${s(p, 'F')}(${s(p, 'M')})` }; }
  return undefined;
}

export interface JobLogContext { text: string[]; failing?: Failing; source?: { label: string; line?: number; how: string }; rows: number }

export async function jobLogContext(conn: IbmiConnection, jobArg: string): Promise<JobLogContext> {
  const job = jobArg.trim().toUpperCase();
  if (!JOB.test(job)) { throw new Error(vscode.l10n.t('Give the qualified job name: number/user/name (for example 123456/QUSER/ORDENTRY).')); }
  const { rows, from } = await readJobLog(conn, job);
  const text = [`Job log of ${job} (${rows.length} messages, read from ${from}):\n${jobLogForModel(rows)}`];
  const failing = failingProgram(rows);
  const out: JobLogContext = { text, failing, rows: rows.length };
  if (!failing) { text.push('No user program could be identified in the job log as the place of the error.'); return out; }
  text.push(`The error happened in ${failing.lib}/${failing.pgm}${failing.module ? `, module ${failing.module}` : ''}${failing.proc ? `, procedure ${failing.proc}` : ''}${failing.stmt ? `, statement ${failing.stmt}` : ''} (message ${failing.message.id} ${failing.message.text}).`);
  const src = await failingSource(conn, failing);
  if (!src) { text.push('Its source member was not found (the program may have been compiled from the IFS or a deleted member).'); return out; }
  let body = ''; let seqs: number[] | undefined;
  try {
    if (conn.sqlKeepsJob) { const recs = await conn.readMemberRecords(src.lib, src.file, src.member); body = recs.map(r => r.text).join('\n'); seqs = recs.map(r => r.seq); }
    else { body = await conn.readMember(src.lib, src.file, src.member); }
  } catch (e) { text.push(`The source ${src.label} could not be read: ${errorMessage(e)}`); return out; }
  const at = lineForStatement(failing.stmt, seqs, body.split(/\r?\n/).length);
  out.source = { label: src.label, line: at.line, how: at.how };
  if (at.line) { text.push(`Source ${src.label} around the failing statement (${at.how}; >> marks it):\n\`\`\`\n${sourceWindow(body, at.line)}\n\`\`\``); }
  text.push(`Source ${src.label} (first part, for the definitions):\n\`\`\`\n${body.slice(0, 25000)}\n\`\`\``);
  return out;
}
