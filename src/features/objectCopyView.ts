// Copy objects and members, move or rename objects, and find duplicate rows.
import * as vscode from 'vscode';
import { IbmiConnection } from '../core/connection';
import { Column } from '../core/dataTransfer';
import { errorMessage, logError } from '../core/log';
import { ConnectionManager } from '../core/manager';
import { cpysrcfCommand, crtdupobjCommand, duplicatesSql, moveCommand, renameCommand } from '../core/objectCommands';
import { assertSystemName, parseMemberPath, sqlString } from '../core/util';
import { reportProgress, showReport } from './reportPanel';

/** Commands the report pages may run (anything else posted by a webview is ignored). */
const ALLOWED = new Set([
  'vanthrex.findDuplicates', 'vanthrex.editData',
]);

type Row = Record<string, unknown>;

type Obj = { library: string; name: string; type?: string };

const s = (r: Row | undefined, k: string) => String(r?.[k] ?? '').trim();

const progress = <T>(title: string, fn: () => Promise<T>) => vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title }, fn);

async function askTable(title: string, o?: Obj): Promise<Obj | undefined> {
  if (o?.library && o?.name) { return o; }
  const v = await vscode.window.showInputBox({ title, prompt: 'LIBRARY/TABLE', ignoreFocusOut: true });
  if (!v?.includes('/')) { return undefined; }
  const [l, t] = v.trim().toUpperCase().split('/');
  return { library: assertSystemName(l, 'library'), name: assertSystemName(t, 'table') };
}

async function columnsOf(conn: IbmiConnection, t: Obj): Promise<(Column & { pk: boolean })[]> {
  const [cols, pk] = await Promise.all([
    conn.rows<Row>(`SELECT COLUMN_NAME AS N, DATA_TYPE AS T, LENGTH AS L, COALESCE(NUMERIC_SCALE, 0) AS S, IS_NULLABLE AS NL, HAS_DEFAULT AS D, COALESCE(IS_IDENTITY, 'NO') AS ID FROM QSYS2.SYSCOLUMNS ` +
      `WHERE SYSTEM_TABLE_SCHEMA = ${sqlString(t.library)} AND SYSTEM_TABLE_NAME = ${sqlString(t.name)} ORDER BY ORDINAL_POSITION`, 2000),
    conn.rows<Row>(`SELECT K.COLUMN_NAME AS C FROM QSYS2.SYSCST C JOIN QSYS2.SYSKEYCST K ON K.CONSTRAINT_SCHEMA = C.CONSTRAINT_SCHEMA AND K.CONSTRAINT_NAME = C.CONSTRAINT_NAME ` +
      `WHERE C.SYSTEM_TABLE_SCHEMA = ${sqlString(t.library)} AND C.SYSTEM_TABLE_NAME = ${sqlString(t.name)} AND C.CONSTRAINT_TYPE IN ('PRIMARY KEY', 'UNIQUE') ORDER BY C.CONSTRAINT_TYPE DESC, K.ORDINAL_POSITION`, 50).catch(() => []),
  ]);
  if (!cols.length) { throw new Error(vscode.l10n.t('{0}/{1} was not found.', t.library, t.name)); }
  const pks = new Set(pk.map(p => s(p, 'C')));
  return cols.filter(c => s(c, 'ID') !== 'YES').map(c => ({ name: s(c, 'N'), type: s(c, 'T'), length: Number(c.L), scale: Number(c.S), nullable: s(c, 'NL') === 'Y', pk: pks.has(s(c, 'N')) }));
}

async function copyObjects(manager: ConnectionManager, o?: Obj): Promise<void> {
  const conn = manager.require();
  const lib = o?.library ?? (await vscode.window.showInputBox({ title: vscode.l10n.t('Copy objects from library'), ignoreFocusOut: true }))?.trim().toUpperCase();
  if (!lib) { return; }
  let picked: { name: string; type: string }[];
  if (o?.name && o.type) { picked = [{ name: o.name, type: o.type }]; }
  else {
    const objs = await conn.rows<Row>(`SELECT OBJNAME AS N, OBJTYPE AS T, COALESCE(OBJATTRIBUTE, '') AS A, COALESCE(OBJTEXT, '') AS X FROM TABLE(QSYS2.OBJECT_STATISTICS(${sqlString(lib)}, '*ALL')) X ORDER BY OBJNAME`, 20000);
    const p = await vscode.window.showQuickPick(objs.map(r => ({ label: s(r, 'N'), description: `${s(r, 'T')} ${s(r, 'A')}`, detail: s(r, 'X'), r })), { canPickMany: true, title: vscode.l10n.t('Objects to copy from {0}', lib), matchOnDescription: true });
    if (!p?.length) { return; }
    picked = p.map(x => ({ name: s(x.r, 'N'), type: s(x.r, 'T') }));
  }
  const to = (await vscode.window.showInputBox({ title: vscode.l10n.t('Copy to library'), ignoreFocusOut: true }))?.trim().toUpperCase();
  if (!to) { return; }
  let newName: string | undefined;
  if (picked.length === 1) { newName = (await vscode.window.showInputBox({ title: vscode.l10n.t('New name (optional)'), value: picked[0].name, ignoreFocusOut: true }))?.trim().toUpperCase(); if (newName === undefined) { return; } }
  let data = false;
  if (picked.some(x => x.type === '*FILE')) {
    const d = await vscode.window.showQuickPick([{ label: vscode.l10n.t('Without data'), v: false }, { label: vscode.l10n.t('With data'), v: true }], { title: vscode.l10n.t('Copy the data of files too?') });
    if (!d) { return; } data = d.v;
  }
  const cmds = picked.map(x => crtdupobjCommand(lib, x.name, x.type, to, newName, data));
  const ok = await vscode.window.showWarningMessage(vscode.l10n.t('Copy {0} object(s) from {1} to {2}?', picked.length, lib, to), { modal: true, detail: cmds.slice(0, 15).join('\n') }, vscode.l10n.t('Copy'));
  if (ok !== vscode.l10n.t('Copy')) { return; }
  const fails: string[] = [];
  await progress(vscode.l10n.t('Copying…'), async () => { for (const c of cmds) { const r = await conn.runCL(c); if (!r.ok) { fails.push(`${c.split(' ')[1]}: ${(r.stderr || r.stdout).trim().split('\n').pop()}`); } } });
  if (fails.length) { vscode.window.showErrorMessage(vscode.l10n.t('{0} copied, {1} failed: {2}', cmds.length - fails.length, fails.length, fails.join('; '))); }
  else { vscode.window.showInformationMessage(vscode.l10n.t('Copied {0} object(s) to {1}.', cmds.length, to)); }
  void vscode.commands.executeCommand('vanthrex.refreshLibraries');
}

async function copyMembers(manager: ConnectionManager, n?: { library?: string; file?: string; member?: string }): Promise<void> {
  const conn = manager.require();
  if (!n?.library || !n.file) { throw new Error(vscode.l10n.t('Right-click a source file or member in the Libraries view.')); }
  let members: string[];
  if (n.member) { members = [n.member]; }
  else {
    const all = await conn.rows<Row>(`SELECT SYSTEM_TABLE_MEMBER AS M, COALESCE(SOURCE_TYPE, '') AS T, COALESCE(PARTITION_TEXT, '') AS X FROM QSYS2.SYSPARTITIONSTAT WHERE SYSTEM_TABLE_SCHEMA = ${sqlString(n.library)} AND SYSTEM_TABLE_NAME = ${sqlString(n.file)} ORDER BY 1`, 5000);
    const p = await vscode.window.showQuickPick(all.map(r => ({ label: s(r, 'M'), description: s(r, 'T'), detail: s(r, 'X') })), { canPickMany: true, title: vscode.l10n.t('Members to copy') });
    if (!p?.length) { return; }
    members = p.map(x => x.label);
  }
  const to = (await vscode.window.showInputBox({ title: vscode.l10n.t('Copy to source file'), prompt: 'LIBRARY/FILE', value: `${n.library}/${n.file}`, ignoreFocusOut: true }))?.trim().toUpperCase();
  if (!to?.includes('/')) { return; }
  const [tl, tf] = to.split('/');
  let newName: string | undefined;
  if (members.length === 1) { newName = (await vscode.window.showInputBox({ title: vscode.l10n.t('Member name in the target'), value: members[0], ignoreFocusOut: true }))?.trim().toUpperCase(); if (!newName) { return; } }
  if (tl === n.library && tf === n.file && (!newName || newName === members[0])) { throw new Error(vscode.l10n.t('Pick another source file or another name.')); }
  const rep = await vscode.window.showQuickPick([{ label: vscode.l10n.t('Keep existing members (skip them)'), v: false }, { label: vscode.l10n.t('Replace existing members'), v: true }], { title: vscode.l10n.t('If a member already exists in {0}', to) });
  if (!rep) { return; }
  const fails: string[] = [];
  await progress(vscode.l10n.t('Copying…'), async () => {
    for (const m of members) {
      const r = await conn.runCL(cpysrcfCommand(n.library!, n.file!, m, tl, tf, rep.v, members.length === 1 ? newName : undefined));
      if (!r.ok) { fails.push(`${m}: ${(r.stderr || r.stdout).trim().split('\n').pop()}`); }
    }
  });
  if (fails.length) { vscode.window.showWarningMessage(vscode.l10n.t('{0} copied, {1} not copied: {2}', members.length - fails.length, fails.length, fails.join('; '))); }
  else { vscode.window.showInformationMessage(vscode.l10n.t('Copied {0} member(s) to {1} — sequence numbers and dates kept.', members.length, to)); }
  void vscode.commands.executeCommand('vanthrex.refreshLibraries');
}

async function moveRename(manager: ConnectionManager, o: Obj): Promise<void> {
  const conn = manager.require();
  if (!o?.library || !o.name || !o.type) { throw new Error(vscode.l10n.t('Right-click an object in the Libraries view.')); }
  const what = await vscode.window.showQuickPick([{ label: vscode.l10n.t('$(edit) Rename'), v: 'rename' }, { label: vscode.l10n.t('$(arrow-right) Move to another library'), v: 'move' }], { title: `${o.library}/${o.name} ${o.type}` });
  if (!what) { return; }
  const v = (await vscode.window.showInputBox({ title: what.v === 'rename' ? vscode.l10n.t('New name') : vscode.l10n.t('Move to library'), value: what.v === 'rename' ? o.name : '', ignoreFocusOut: true }))?.trim().toUpperCase();
  if (!v) { return; }
  const cmd = what.v === 'rename' ? renameCommand(o.library, o.name, o.type, v) : moveCommand(o.library, o.name, o.type, v);
  const ok = await vscode.window.showWarningMessage(cmd, { modal: true, detail: vscode.l10n.t('Programs that refer to the old name or library will no longer find it.') }, vscode.l10n.t('Run'));
  if (ok !== vscode.l10n.t('Run')) { return; }
  const r = await conn.runCL(cmd);
  if (!r.ok) { throw new Error((r.stderr || r.stdout).trim()); }
  vscode.window.showInformationMessage(vscode.l10n.t('Done.'));
  void vscode.commands.executeCommand('vanthrex.refreshLibraries');
}

async function findDuplicates(manager: ConnectionManager, o?: Obj): Promise<void> {
  const conn = manager.require();
  const t = await askTable(vscode.l10n.t('Find duplicate rows'), o);
  if (!t) { return; }
  const cols = await columnsOf(conn, t);
  const picked = await vscode.window.showQuickPick(cols.map(c => ({ label: c.name, description: c.type, picked: c.pk })), { canPickMany: true, title: vscode.l10n.t('Rows count as duplicates when these columns are equal') });
  if (!picked?.length) { return; }
  const keys = picked.map(p => p.label);
  const rows = await reportProgress('dups', vscode.l10n.t('Looking for duplicates…'), () => conn.rows<Row>(duplicatesSql(t.library, t.name, keys), 500));
  showReport('dups', {
    title: vscode.l10n.t('Duplicates in {0}/{1}', t.library, t.name), subtitle: rows.length ? `${rows.length} value(s) appear more than once (by ${keys.join(', ')}), most copies first.` : `No duplicates by ${keys.join(', ')}.`,
    actions: [{ label: vscode.l10n.t('Check other columns'), command: 'vanthrex.findDuplicates', args: [t] }, { label: vscode.l10n.t('Edit data'), command: 'vanthrex.editData', args: [t] }],
    tables: [{ title: vscode.l10n.t('Duplicated values'), filter: true, columns: [...keys, 'Copies'], rows: rows.map(r => [...keys.map(k => String(r[k] ?? '')), String(r.COPIES ?? '')]), empty: vscode.l10n.t('None.') }],
  }, ALLOWED);
}

// ================================================================ registration

export function registerObjectCopy(context: vscode.ExtensionContext, manager: ConnectionManager): void {
  const guard = <A extends unknown[]>(fn: (...a: A) => Promise<unknown> | unknown) => async (...a: A) => {
    try { await fn(...a); } catch (e) { logError(e); vscode.window.showErrorMessage(errorMessage(e)); }
  };
  const obj = (x: unknown): Obj | undefined => { const o = x as Partial<Obj> | undefined; return o?.library && o?.name ? { library: o.library, name: o.name, type: o.type } : undefined; };
  context.subscriptions.push(
    vscode.commands.registerCommand('vanthrex.copyObjects', guard((x?: unknown) => {
      const o = x as Partial<Obj> | undefined; return copyObjects(manager, o?.library ? { library: o.library, name: o.name ?? '', type: o.type } : undefined);
    })),
    vscode.commands.registerCommand('vanthrex.copyMembers', guard((n?: { library?: string; file?: string; member?: string }) => {
      const doc = vscode.window.activeTextEditor?.document;
      if (!n && doc?.uri.scheme === 'vanthrex-member') { const p = parseMemberPath(doc.uri.path); return copyMembers(manager, { library: p.library, file: p.file, member: p.member }); }
      return copyMembers(manager, n);
    })),
    vscode.commands.registerCommand('vanthrex.moveRenameObject', guard((x: unknown) => moveRename(manager, obj(x)!))),
    vscode.commands.registerCommand('vanthrex.findDuplicates', guard((x?: unknown) => findDuplicates(manager, obj(x)))),
  );
}
