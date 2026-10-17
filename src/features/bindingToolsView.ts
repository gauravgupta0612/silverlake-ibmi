// Binding tools: binder source, binding directories and the service program signature check.
import * as vscode from 'vscode';
import { addBnddirEntryCommand, rebindCommand, removeBnddirEntryCommand, rtvbndsrcCommand, signatureState, splitSignatures } from '../core/binding';
import { IbmiConnection } from '../core/connection';
import { errorMessage, logError } from '../core/log';
import { ConnectionManager } from '../core/manager';
import { parseMemberPath, sqlString } from '../core/util';
import { MEMBER_SCHEME, memberUri } from './fileSystems';
import { reportProgress, showReport } from './reportPanel';

/** Commands the report pages may run (anything else posted by a webview is ignored). */
const ALLOWED = new Set([
  'vanthrex.bindingDirectory', 'vanthrex.bnddir.add', 'vanthrex.bnddir.remove',
]);

type Row = Record<string, unknown>;

type Obj = { library: string; name: string; type?: string };

const s = (r: Row | undefined, k: string) => String(r?.[k] ?? '').trim();

const progress = <T>(title: string, fn: () => Promise<T>) => vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title }, fn);

async function run(conn: IbmiConnection, cmd: string, warn = ''): Promise<boolean> {
  const p = await vscode.window.showWarningMessage(cmd, { modal: true, detail: warn || undefined }, vscode.l10n.t('Run'));
  if (p !== vscode.l10n.t('Run')) { return false; }
  const r = await progress(cmd.split(' ')[0], () => conn.runCL(cmd));
  if (!r.ok) { throw new Error(`${cmd.split(' ')[0]}: ${(r.stderr || r.stdout).trim().split('\n').slice(-3).join(' ')}`); }
  vscode.window.showInformationMessage(vscode.l10n.t('Done.'));
  return true;
}

async function retrieveBinderSource(manager: ConnectionManager, o?: Obj): Promise<void> {
  const conn = manager.require();
  if (!o?.library || !o.name) { throw new Error(vscode.l10n.t('Right-click a service program in the Libraries view.')); }
  const target = (await vscode.window.showInputBox({ title: vscode.l10n.t('Binder source for {0} — write it into', o.name), prompt: 'LIBRARY/SOURCEFILE', value: `${o.library}/QSRVSRC`, ignoreFocusOut: true }))?.trim().toUpperCase();
  if (!target?.includes('/')) { return; }
  const [sl, sf] = target.split('/');
  const exists = await conn.rows<Row>(`SELECT 1 AS X FROM QSYS2.SYSTABLES WHERE SYSTEM_TABLE_SCHEMA = ${sqlString(sl)} AND SYSTEM_TABLE_NAME = ${sqlString(sf)}`, 1).catch(() => []);
  if (!exists.length) {
    const r = await conn.runCL(`CRTSRCPF FILE(${sl}/${sf}) RCDLEN(112) TEXT('Binder source')`);
    if (!r.ok) { throw new Error((r.stderr || r.stdout).trim()); }
  }
  const r = await progress(vscode.l10n.t('Retrieving binder source…'), () => conn.runCL(rtvbndsrcCommand(o.library, o.name, sl, sf, o.name)));
  if (!r.ok) { throw new Error((r.stderr || r.stdout).trim()); }
  await vscode.window.showTextDocument(memberUri(sl, sf, o.name, 'bnd'));
  vscode.window.showInformationMessage(vscode.l10n.t('Binder source of {0} written to {1}/{2}({0}). Add new exports at the end to keep programs working without a rebind.', o.name, sl, sf));
}

async function bindingDirectory(manager: ConnectionManager, o?: Obj): Promise<void> {
  const conn = manager.require();
  if (!o?.library || !o.name) { throw new Error(vscode.l10n.t('Right-click a binding directory in the Libraries view.')); }
  const rows = await reportProgress('bnddir', vscode.l10n.t('Reading from the IBM i…'), () => conn.rows<Row>(`SELECT * FROM QSYS2.BINDING_DIRECTORY_INFO WHERE BINDING_DIRECTORY_LIBRARY = ${sqlString(o.library)} AND BINDING_DIRECTORY = ${sqlString(o.name)}`, 5000));
  const bd = `${o.library}/${o.name}`;
  showReport('bnddir', {
    title: vscode.l10n.t('Binding directory {0}', bd), subtitle: vscode.l10n.t('{0} entr(ies). Click one to remove it.', rows.length),
    actions: [{ label: vscode.l10n.t('Add an entry…'), command: 'vanthrex.bnddir.add', args: [o] }, { label: vscode.l10n.t('Refresh'), command: 'vanthrex.bindingDirectory', args: [o] }],
    tables: [{ title: vscode.l10n.t('Entries'), filter: true, columns: ['Library', 'Object', 'Type', 'Activation', 'Created'],
      rows: rows.map(r => [s(r, 'ENTRY_LIBRARY'), s(r, 'ENTRY'), s(r, 'ENTRY_TYPE'), s(r, 'ENTRY_ACTIVATION'), s(r, 'ENTRY_CREATE_TIMESTAMP').slice(0, 16)]),
      rowActions: rows.map(r => ({ label: vscode.l10n.t('Remove…'), command: 'vanthrex.bnddir.remove', args: [o, s(r, 'ENTRY_LIBRARY'), s(r, 'ENTRY'), s(r, 'ENTRY_TYPE')] })), empty: vscode.l10n.t('Empty.') }],
  }, ALLOWED);
}


function libraryList(conn: IbmiConnection, uri?: vscode.Uri): string[] {
  const own = uri?.scheme === MEMBER_SCHEME ? parseMemberPath(uri.path).library : undefined;
  return [...new Set([own, conn.profile.currentLibrary, ...(conn.profile.libraries ?? [])].filter(Boolean).map(x => x!.toUpperCase()))];
}

const SIG_ALLOWED = new Set(['vanthrex.signatureCheck', 'vanthrex.signatureCheck.rebind', 'vanthrex.signatureCheck.rebindAll']);

interface Bound { lib: string; name: string; type: string; srvLib: string; srv: string }

async function signatureCheck(manager: ConnectionManager, a?: unknown, scopeArg?: string): Promise<void> {
  const conn = manager.require();
  const n = a as { library?: string; name?: string } | string | undefined;
  let lib = typeof n === 'object' ? n?.library?.toUpperCase() : undefined; let srv = typeof n === 'object' ? n?.name?.toUpperCase() : undefined;
  if (typeof n === 'string' && n.includes('/')) { [lib, srv] = n.toUpperCase().split('/'); }
  if (!srv) {
    const v = (await vscode.window.showInputBox({ title: vscode.l10n.t('Check service program signatures'), prompt: 'LIBRARY/SRVPGM', ignoreFocusOut: true, validateInput: x => (/^[A-Z$#@][A-Z0-9$#@_.]{0,9}\/[A-Z$#@][A-Z0-9$#@_.]{0,9}$/i.test(x.trim()) ? undefined : 'LIBRARY/SRVPGM') }))?.trim().toUpperCase();
    if (!v) { return; }
    [lib, srv] = v.split('/');
  }
  let scope = scopeArg;
  if (!scope) {
    const p = await vscode.window.showQuickPick([
      { label: vscode.l10n.t('$(library) Library list and {0}', lib!), k: 'libl' },
      { label: vscode.l10n.t('$(globe) All libraries'), description: vscode.l10n.t('can take a few minutes'), k: 'all' },
    ], { title: vscode.l10n.t('Look for programs bound to {0}/{1} in…', lib!, srv!) });
    if (!p) { return; }
    scope = p.k;
  }
  const libs = [...new Set([lib!, ...libraryList(conn)])];
  const [info, bound] = await reportProgress('signatureCheck', vscode.l10n.t('Checking who is bound to {0}…', srv!), () => Promise.all([
    conn.rows<Row>(`SELECT HEX(CAST(SUBSTR(EXPORT_SIGNATURES, 1, 3400) AS VARBINARY(3400))) AS SIGS FROM QSYS2.PROGRAM_INFO WHERE PROGRAM_LIBRARY = ${sqlString(lib!)} AND PROGRAM_NAME = ${sqlString(srv!)} AND OBJECT_TYPE = '*SRVPGM'`, 1),
    conn.rows<Row>(`SELECT PROGRAM_LIBRARY AS L, PROGRAM_NAME AS N, OBJECT_TYPE AS T, BOUND_SERVICE_PROGRAM_LIBRARY AS BL, HEX(BOUND_SERVICE_PROGRAM_SIGNATURE) AS SIG ` +
      `FROM QSYS2.BOUND_SRVPGM_INFO WHERE BOUND_SERVICE_PROGRAM = ${sqlString(srv!)} AND BOUND_SERVICE_PROGRAM_LIBRARY IN (${sqlString(lib!)}, '*LIBL')` +
      (scope === 'all' ? '' : ` AND PROGRAM_LIBRARY IN (${libs.map(sqlString).join(', ')})`) + ' ORDER BY PROGRAM_LIBRARY, PROGRAM_NAME', 20000),
  ]).catch(e => { throw new Error(vscode.l10n.t('The signature check needs QSYS2.PROGRAM_INFO and QSYS2.BOUND_SRVPGM_INFO (IBM i 7.3 or later with a recent Db2 PTF group): {0}', errorMessage(e).split('\n')[0])); }));
  if (!info.length) { throw new Error(vscode.l10n.t('{0}/{1} is not a service program.', lib!, srv!)); }
  const sigs = splitSignatures(s(info[0], 'SIGS'));
  const list = bound.map(r => ({ b: { lib: s(r, 'L'), name: s(r, 'N'), type: s(r, 'T'), srvLib: s(r, 'BL') || lib!, srv: srv! } as Bound, state: signatureState(s(r, 'SIG'), sigs), sig: s(r, 'SIG') }))
    .sort((x, y) => ['mismatch', 'unknown', 'older', 'current'].indexOf(x.state) - ['mismatch', 'unknown', 'older', 'current'].indexOf(y.state));
  const bad = list.filter(x => x.state === 'mismatch');
  const label = { current: vscode.l10n.t('OK — current signature'), older: vscode.l10n.t('OK — older signature still exported'), mismatch: vscode.l10n.t('Signature violation: fails when called'), unknown: vscode.l10n.t('Unknown') };
  showReport('signatureCheck', {
    title: vscode.l10n.t('Signatures of {0}/{1}', lib!, srv!),
    subtitle: bad.length ? vscode.l10n.t('{0} of {1} bound object(s) would fail with a signature violation.', bad.length, list.length) : vscode.l10n.t('All {0} bound object(s) are fine.', list.length),
    facts: [[vscode.l10n.t('Current signature'), sigs[0] ?? '?'], [vscode.l10n.t('Valid signatures'), sigs.length], [vscode.l10n.t('Bound objects'), list.length], [vscode.l10n.t('Searched'), scope === 'all' ? vscode.l10n.t('All libraries') : libs.join(' ')]],
    actions: [{ label: vscode.l10n.t('Refresh'), command: 'vanthrex.signatureCheck', args: [`${lib}/${srv}`, scope] },
      ...(bad.length ? [{ label: vscode.l10n.t('Re-bind all {0} failing object(s)…', bad.length), command: 'vanthrex.signatureCheck.rebindAll', args: [bad.map(x => x.b), `${lib}/${srv}`, scope] }] : [])],
    tables: [
      { title: vscode.l10n.t('Bound programs and service programs'), filter: list.length > 20, columns: [vscode.l10n.t('Object'), vscode.l10n.t('Type'), vscode.l10n.t('Bound to'), vscode.l10n.t('State')],
        rows: list.map(x => [`${x.b.lib}/${x.b.name}`, x.b.type, `${x.b.srvLib}/${srv}`, label[x.state]]),
        rowClass: list.map(x => (x.state === 'mismatch' ? 'bad' : x.state === 'older' ? 'different' : undefined)),
        rowActions: list.map(x => (x.state === 'mismatch' || x.state === 'older' ? { label: vscode.l10n.t('Re-bind…'), command: 'vanthrex.signatureCheck.rebind', args: [x.b, `${lib}/${srv}`, scope] } : undefined)),
        empty: vscode.l10n.t('Nothing is bound to this service program in the libraries searched.') },
      { title: vscode.l10n.t('Signatures exported'), columns: ['#', vscode.l10n.t('Signature')], rows: sigs.map((x, i) => [i === 0 ? vscode.l10n.t('1 (current)') : String(i + 1), x]) },
    ],
    note: vscode.l10n.t('Re-binding runs UPDPGM / UPDSRVPGM with MODULE(*NONE): no module changes, the object just picks up the current signature. Recompile instead when procedures were removed or their parameters changed.'),
  }, SIG_ALLOWED);
}

async function rebind(manager: ConnectionManager, items: Bound[], again: [string, string]): Promise<void> {
  const conn = manager.require();
  const cmds = items.map(b => rebindCommand(b.type, b.lib, b.name, b.srvLib, b.srv));
  const yes = vscode.l10n.t('Re-bind');
  if (await vscode.window.showWarningMessage(items.length === 1 ? vscode.l10n.t('Re-bind {0}/{1}?', items[0].lib, items[0].name) : vscode.l10n.t('Re-bind {0} objects?', items.length),
    { modal: true, detail: cmds.slice(0, 15).join('\n') + (cmds.length > 15 ? '\n…' : '') }, yes) !== yes) { return; }
  const failed: string[] = [];
  await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: vscode.l10n.t('Re-binding…'), cancellable: true }, async (p, tok) => {
    for (let i = 0; i < cmds.length && !tok.isCancellationRequested; i++) {
      p.report({ message: `${items[i].lib}/${items[i].name}`, increment: 100 / cmds.length });
      try { const r = await conn.runCL(cmds[i]); if (!r.ok) { failed.push(`${items[i].lib}/${items[i].name}: ${(r.stderr || r.stdout).trim().split('\n').pop()}`); } } catch (e) { failed.push(`${items[i].lib}/${items[i].name}: ${errorMessage(e)}`); }
    }
  });
  if (failed.length) { vscode.window.showErrorMessage(vscode.l10n.t('{0} could not be re-bound.', failed.length), { modal: true, detail: failed.join('\n') }); }
  else { vscode.window.setStatusBarMessage(vscode.l10n.t('✓ Re-bound {0} object(s)', cmds.length), 5000); }
  await signatureCheck(manager, again[0], again[1]);
}

// ================================================================ registration

export function registerBindingTools(context: vscode.ExtensionContext, manager: ConnectionManager): void {
  const guard = <A extends unknown[]>(fn: (...a: A) => Promise<unknown>) => async (...a: A) => {
    try { await fn(...a); } catch (e) { logError(e); vscode.window.showErrorMessage(errorMessage(e)); }
  };
  const obj = (x: unknown): Obj | undefined => { const o = x as Partial<Obj> | undefined; return o?.library && o?.name ? { library: o.library, name: o.name, type: o.type } : undefined; };
  context.subscriptions.push(
    vscode.commands.registerCommand('vanthrex.retrieveBinderSource', guard((x?: unknown) => retrieveBinderSource(manager, obj(x)))),
    vscode.commands.registerCommand('vanthrex.bindingDirectory', guard((x?: unknown) => bindingDirectory(manager, obj(x)))),
    vscode.commands.registerCommand('vanthrex.bnddir.add', guard(async (o: Obj) => {
      const conn = manager.require();
      const v = (await vscode.window.showInputBox({ title: vscode.l10n.t('Add to {0}/{1}', o.library, o.name), prompt: 'LIBRARY/OBJECT or *LIBL/OBJECT', ignoreFocusOut: true }))?.trim().toUpperCase();
      if (!v) { return; }
      const [l, n] = v.includes('/') ? v.split('/') : ['*LIBL', v];
      const t = await vscode.window.showQuickPick(['*SRVPGM', '*MODULE'], { title: vscode.l10n.t('Object type') });
      if (t && await run(conn, addBnddirEntryCommand(`${o.library}/${o.name}`, l, n, t as '*SRVPGM' | '*MODULE'))) { await bindingDirectory(manager, o); }
    })),
    vscode.commands.registerCommand('vanthrex.bnddir.remove', guard(async (o: Obj, l: string, n: string, t: string) => {
      if (await run(manager.require(), removeBnddirEntryCommand(`${o.library}/${o.name}`, l, n, t), vscode.l10n.t('Programs created later will no longer bind to it through this directory.'))) { await bindingDirectory(manager, o); }
    })),
    vscode.commands.registerCommand('vanthrex.signatureCheck', guard((a?: unknown, scope?: string) => signatureCheck(manager, a, scope))),
    vscode.commands.registerCommand('vanthrex.signatureCheck.rebind', guard((b: Bound, srv: string, scope: string) => rebind(manager, [b], [srv, scope]))),
    vscode.commands.registerCommand('vanthrex.signatureCheck.rebindAll', guard((b: Bound[], srv: string, scope: string) => rebind(manager, b, [srv, scope]))),
  );
}
