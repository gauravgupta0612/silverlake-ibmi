// Call Program with typed parameters read from the program's source.
import * as vscode from 'vscode';
import { IbmiConnection } from '../core/connection';
import { errorMessage, logError } from '../core/log';
import { ConnectionManager } from '../core/manager';
import { callCommand, callLiteral, describeParm, Parm, ParmKind, programParameters } from '../core/programCall';
import { sqlString } from '../core/util';

type Row = Record<string, unknown>;

const s = (r: Row | undefined, k: string) => String(r?.[k] ?? '').trim();

const pick = (r: Row | undefined, ...keys: string[]) => { for (const k of keys) { const v = s(r, k); if (v) { return v; } } return ''; };

async function findSource(conn: IbmiConnection, lib: string, pgm: string): Promise<{ lib: string; file: string; member: string; type: string } | undefined> {
  const info = (await conn.rows<Row>(`SELECT * FROM QSYS2.PROGRAM_INFO WHERE PROGRAM_LIBRARY = ${sqlString(lib)} AND PROGRAM_NAME = ${sqlString(pgm)} AND OBJECT_TYPE = '*PGM'`, 1).catch(() => [] as Row[]))[0];
  let src = { lib: pick(info, 'SOURCE_FILE_LIBRARY'), file: pick(info, 'SOURCE_FILE'), member: pick(info, 'SOURCE_FILE_MEMBER') };
  if (!src.member) {
    const pepLib = pick(info, 'PROGRAM_ENTRY_PROCEDURE_MODULE_LIBRARY'); const pep = pick(info, 'PROGRAM_ENTRY_PROCEDURE_MODULE');
    const mod = (await conn.rows<Row>(`SELECT * FROM QSYS2.BOUND_MODULE_INFO WHERE PROGRAM_LIBRARY = ${sqlString(lib)} AND PROGRAM_NAME = ${sqlString(pgm)}` +
      (pep ? ` AND BOUND_MODULE = ${sqlString(pep)}${pepLib ? ` AND BOUND_MODULE_LIBRARY = ${sqlString(pepLib)}` : ''}` : ''), 1).catch(() => [] as Row[]))[0];
    src = { lib: pick(mod, 'SOURCE_FILE_LIBRARY'), file: pick(mod, 'SOURCE_FILE'), member: pick(mod, 'SOURCE_FILE_MEMBER') };
  }
  if (!src.member) { return undefined; }
  const t = (await conn.rows<Row>(`SELECT COALESCE(SOURCE_TYPE, '') AS T FROM QSYS2.SYSPARTITIONSTAT WHERE SYSTEM_TABLE_SCHEMA = ${sqlString(src.lib)} AND SYSTEM_TABLE_NAME = ${sqlString(src.file)} AND SYSTEM_TABLE_MEMBER = ${sqlString(src.member)}`, 1).catch(() => [] as Row[]))[0];
  return { ...src, type: s(t, 'T') || pick(info, 'PROGRAM_ATTRIBUTE', 'OBJECT_ATTRIBUTE') };
}

async function askParmsByHand(): Promise<Parm[] | undefined> {
  const out: Parm[] = [];
  for (;;) {
    const kind = await vscode.window.showQuickPick([
      { label: vscode.l10n.t('$(check) Done — {0} parameter(s)', out.length), k: 'done' },
      { label: vscode.l10n.t('char(n)'), k: 'char' }, { label: vscode.l10n.t('packed(p:s)'), k: 'packed' }, { label: vscode.l10n.t('zoned(p:s)'), k: 'zoned' }, { label: vscode.l10n.t('int(10)'), k: 'int' }, { label: vscode.l10n.t('ind'), k: 'ind' },
      { label: vscode.l10n.t('Other (type the CL literal yourself)'), k: 'other' },
    ], { title: vscode.l10n.t('The source was not found: describe parameter {0}', out.length + 1) });
    if (!kind) { return undefined; }
    if (kind.k === 'done') { return out; }
    let length = 0; let decimals = 0;
    if (kind.k === 'char' || kind.k === 'packed' || kind.k === 'zoned') {
      const v = await vscode.window.showInputBox({ title: kind.k === 'char' ? vscode.l10n.t('Length') : vscode.l10n.t('Digits and decimals, e.g. 9 2'), validateInput: x => (/^\d+(\s+\d+)?$/.test(x.trim()) ? undefined : '9 2') });
      if (!v) { return undefined; }
      [length, decimals] = v.trim().split(/\s+/).map(Number); decimals = decimals || 0;
    }
    out.push({ name: `PARM${out.length + 1}`, kind: kind.k as ParmKind, length: kind.k === 'int' ? 10 : kind.k === 'ind' ? 1 : length, decimals, raw: '' });
  }
}

async function callTyped(manager: ConnectionManager, state: vscode.Memento, a?: unknown): Promise<void> {
  const conn = manager.require();
  const n = a as { library?: string; name?: string } | string | undefined;
  let lib = typeof n === 'object' ? n?.library?.toUpperCase() : undefined; let pgm = typeof n === 'object' ? n?.name?.toUpperCase() : undefined;
  if (typeof n === 'string' && n.includes('/')) { [lib, pgm] = n.toUpperCase().split('/'); }
  if (!pgm) {
    const v = (await vscode.window.showInputBox({ title: vscode.l10n.t('Call program'), prompt: 'LIBRARY/PROGRAM', ignoreFocusOut: true }))?.trim().toUpperCase();
    if (!v) { return; }
    [lib, pgm] = v.includes('/') ? v.split('/') : ['*LIBL', v];
  }
  if (!lib || lib === '*LIBL') {
    const r = (await conn.rows<Row>(`SELECT OBJLIB AS L FROM TABLE(QSYS2.OBJECT_STATISTICS('*LIBL', '*PGM', ${sqlString(pgm!)})) X`, 1).catch(() => [] as Row[]))[0];
    lib = s(r, 'L') || '*LIBL';
  }
  const src = lib !== '*LIBL' ? await vscode.window.withProgress({ location: vscode.ProgressLocation.Window, title: vscode.l10n.t('Reading the parameters of {0}…', pgm!) }, () => findSource(conn, lib!, pgm!)) : undefined;
  let parms: Parm[] | undefined;
  let from = '';
  if (src) {
    try { parms = programParameters(await conn.readMember(src.lib, src.file, src.member), src.type); from = `${src.lib}/${src.file}(${src.member})`; } catch (e) { logError(e); }
  }
  if (!parms) { parms = await askParmsByHand(); if (!parms) { return; } }
  const key = `vanthrex.call.${conn.profile.name}.${lib}/${pgm}`;
  const last = state.get<string[]>(key, []);
  const values: string[] = []; const literals: string[] = [];
  for (let i = 0; i < parms.length; i++) {
    const p = parms[i];
    const v = await vscode.window.showInputBox({
      title: vscode.l10n.t('{0} — parameter {1}/{2}: {3} {4}', pgm!, i + 1, parms.length, p.name, describeParm(p)),
      prompt: p.kind === 'other' ? vscode.l10n.t('Type the CL literal yourself (e.g. \'ABC\' or X\'00F1\')') : from ? vscode.l10n.t('From {0}', from) : undefined,
      value: last[i] ?? '', ignoreFocusOut: true,
      validateInput: x => { try { callLiteral(p, x); return undefined; } catch (e) { return errorMessage(e); } },
    });
    if (v === undefined) { return; }
    values.push(v); literals.push(callLiteral(p, v));
  }
  await state.update(key, values);
  const cmd = callCommand(lib, pgm!, literals);
  const run = vscode.l10n.t('Run'); const batch = vscode.l10n.t('Submit to Batch'); const copy = vscode.l10n.t('Copy');
  const c = await vscode.window.showInformationMessage(cmd, {
    modal: true, detail: parms.length ? parms.map((p, i) => `${p.name} ${describeParm(p)} = ${values[i]} → ${literals[i]}`).join('\n') : vscode.l10n.t('No parameters.'),
  }, run, batch, copy);
  if (c === copy) { await vscode.env.clipboard.writeText(cmd); return; }
  if (c === batch) {
    const r = await conn.runCL(`SBMJOB CMD(${cmd}) JOB(${pgm})`);
    vscode.window.showInformationMessage(r.ok ? vscode.l10n.t('Submitted: {0}', (r.stdout + r.stderr).match(/\d{6}\/\S+\/\S+/)?.[0] ?? pgm!) : (r.stderr || r.stdout).trim());
    return;
  }
  if (c !== run) { return; }
  const r = await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: vscode.l10n.t('Calling {0}…', pgm!) }, () => conn.runCL(cmd));
  const text = `${r.stdout}\n${r.stderr}`.split('\n').map(x => x.trim()).filter(Boolean).slice(-5).join('\n');
  if (r.ok) { vscode.window.showInformationMessage(vscode.l10n.t('{0} ended normally.', pgm!), { modal: true, detail: text || vscode.l10n.t('No messages.') }); }
  else { vscode.window.showErrorMessage(vscode.l10n.t('{0} ended with an error: {1}', pgm!, text.split('\n').pop() ?? '')); }
}

// ================================================================ registration

export function registerProgramCall(context: vscode.ExtensionContext, manager: ConnectionManager): void {
  const guard = <A extends unknown[]>(fn: (...a: A) => Promise<unknown>) => async (...a: A) => {
    try { await fn(...a); } catch (e) { logError(e); vscode.window.showErrorMessage(errorMessage(e)); }
  };
  context.subscriptions.push(
    vscode.commands.registerCommand('vanthrex.callTyped', guard((a?: unknown) => callTyped(manager, context.globalState, a))),
  );
}
