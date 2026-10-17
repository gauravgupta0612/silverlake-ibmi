// Security tools: exit points, ownership and authority in bulk, and the *PUBLIC authority scan.
import * as vscode from 'vscode';
import { IbmiConnection } from '../core/connection';
import { errorMessage, logError } from '../core/log';
import { ConnectionManager } from '../core/manager';
import {
  bulkAuthorityCommand, chgobjownCommand, matchesGeneric, NETWORK_EXIT_POINTS, publicRisk, setPublicCommand, unprotectedExitPoints,
} from '../core/security';
import { assertSystemName, sqlString } from '../core/util';
import { showReport } from './reportPanel';

/** Commands the report pages may run (anything else posted by a webview is ignored). */
const ALLOWED = new Set([
  'vanthrex.exitPoints', 'vanthrex.securityCenter', 'vanthrex.publicAuthority.set', 'vanthrex.publicAuthorityScan',
]);

type Row = Record<string, unknown>;

const s = (r: Row | undefined, k: string) => String(r?.[k] ?? '').trim();

const progress = <T>(title: string, fn: () => Promise<T>) => vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title }, fn);

async function askLib(title: string, x?: unknown, conn?: IbmiConnection): Promise<string | undefined> {
  const lib = typeof x === 'string' ? x : (x as { library?: string } | undefined)?.library;
  const v = lib ?? (await vscode.window.showInputBox({ title, prompt: vscode.l10n.t('Library'), value: conn?.profile.currentLibrary ?? '', ignoreFocusOut: true }));
  return v ? assertSystemName(v, 'library') : undefined;
}

async function run(conn: IbmiConnection, cmd: string, warn = ''): Promise<boolean> {
  const p = await vscode.window.showWarningMessage(cmd, { modal: true, detail: warn || undefined }, vscode.l10n.t('Run'));
  if (p !== vscode.l10n.t('Run')) { return false; }
  const r = await progress(cmd.split(' ')[0], () => conn.runCL(cmd));
  if (!r.ok) { throw new Error(`${cmd.split(' ')[0]}: ${(r.stderr || r.stdout).trim().split('\n').slice(-3).join(' ')}`); }
  vscode.window.showInformationMessage(vscode.l10n.t('Done.'));
  return true;
}

async function exitPoints(manager: ConnectionManager): Promise<void> {
  const conn = manager.require();
  const progs = await progress(vscode.l10n.t('Reading exit programs…'), () => conn.rows<Row>(
    `SELECT EXIT_POINT_NAME AS P, EXIT_POINT_FORMAT AS F, EXIT_PROGRAM_NUMBER AS N, EXIT_PROGRAM_LIBRARY AS L, EXIT_PROGRAM AS PGM, COALESCE(EXIT_PROGRAM_DESCRIPTION, '') AS D FROM QSYS2.EXIT_PROGRAM_INFO ORDER BY 1, 3`, 5000));
  const open = unprotectedExitPoints(progs.map(p => ({ point: s(p, 'P') })));
  showReport('exitPoints', {
    title: vscode.l10n.t('Exit points and exit programs'), subtitle: vscode.l10n.t('{0} exit program(s) registered. {1} of {2} network exit points have none — requests through them are not checked by any exit program.', progs.length, open.length, Object.keys(NETWORK_EXIT_POINTS).length),
    actions: [{ label: vscode.l10n.t('Security Admin'), command: 'vanthrex.securityCenter' }],
    tables: [
      { title: vscode.l10n.t('Network exit points without an exit program'), columns: ['Exit point', 'What goes through it'], rows: open.map(o => [o.point, o.what]), rowClass: open.map(() => 'different'), empty: vscode.l10n.t('Every listed network exit point has an exit program.') },
      { title: vscode.l10n.t('Registered exit programs'), filter: true, columns: ['Exit point', 'Format', '#', 'Program', 'Description'], rows: progs.map(p => [s(p, 'P'), s(p, 'F'), s(p, 'N'), `${s(p, 'L')}/${s(p, 'PGM')}`, s(p, 'D') || NETWORK_EXIT_POINTS[s(p, 'P')] || '']) },
    ],
    note: vscode.l10n.t('Exit programs let you log or refuse ODBC, FTP, remote command and file-server requests. Registering them (ADDEXITPGM / WRKREGINF) needs *ALLOBJ and *SECADM; Vanthrex only reports them.'),
  }, ALLOWED);
}

async function bulkOwnerAuthority(manager: ConnectionManager, x?: unknown): Promise<void> {
  const conn = manager.require();
  const lib = await askLib(vscode.l10n.t('Change owner or authority of many objects'), x, conn);
  if (!lib) { return; }
  const what = await vscode.window.showQuickPick([
    { label: vscode.l10n.t('$(person) Change the owner'), v: 'own' }, { label: vscode.l10n.t('$(add) Grant authority'), v: 'grt' }, { label: vscode.l10n.t('$(remove) Revoke authority'), v: 'rvk' },
  ], { title: vscode.l10n.t('Objects of {0}', lib) });
  if (!what) { return; }
  const pattern = (await vscode.window.showInputBox({ title: vscode.l10n.t('Which objects?'), prompt: vscode.l10n.t('A name, a generic name like ORD* or *ALL'), value: '*ALL', ignoreFocusOut: true }))?.trim().toUpperCase();
  if (!pattern) { return; }
  const type = (await vscode.window.showInputBox({ title: vscode.l10n.t('Object type'), value: '*ALL', prompt: '*ALL, *PGM, *FILE, *SRVPGM, *DTAARA…', ignoreFocusOut: true }))?.trim().toUpperCase();
  if (!type) { return; }
  if (what.v === 'own') {
    const owner = (await vscode.window.showInputBox({ title: vscode.l10n.t('New owner'), ignoreFocusOut: true }))?.trim().toUpperCase();
    if (!owner) { return; }
    const objs = (await conn.rows<Row>(`SELECT OBJNAME AS N, OBJTYPE AS T, OBJOWNER AS O FROM TABLE(QSYS2.OBJECT_STATISTICS(${sqlString(lib)}, ${sqlString(type)})) X ORDER BY OBJNAME`, 50000))
      .filter(r => matchesGeneric(s(r, 'N'), pattern) && s(r, 'O') !== owner);
    if (!objs.length) { vscode.window.showInformationMessage(vscode.l10n.t('No object to change — they are already owned by {0}, or none match.', owner)); return; }
    const revoke = await vscode.window.showQuickPick([{ label: vscode.l10n.t('Keep the old owner\'s authority'), v: false }, { label: vscode.l10n.t('Revoke the old owner\'s authority'), v: true }], { title: vscode.l10n.t('Old owner') });
    if (!revoke) { return; }
    const ok = await vscode.window.showWarningMessage(vscode.l10n.t('Give {0} object(s) of {1} to {2}?', objs.length, lib, owner), { modal: true, detail: objs.slice(0, 20).map(r => `${s(r, 'N')} ${s(r, 'T')} (${s(r, 'O')})`).join('\n') + (objs.length > 20 ? '\n…' : '') }, vscode.l10n.t('Change Owner'));
    if (ok !== vscode.l10n.t('Change Owner')) { return; }
    const fails: string[] = [];
    await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: vscode.l10n.t('Changing owners…'), cancellable: true }, async (p, token) => {
      for (const r of objs) {
        if (token.isCancellationRequested) { break; }
        p.report({ message: s(r, 'N'), increment: 100 / objs.length });
        const res = await conn.runCL(chgobjownCommand(lib, s(r, 'N'), s(r, 'T'), owner, revoke.v));
        if (!res.ok) { fails.push(s(r, 'N')); }
      }
    });
    vscode.window.showInformationMessage(vscode.l10n.t('{0} object(s) changed.{1}', objs.length - fails.length, fails.length ? ` ${vscode.l10n.t('Failed: {0}', fails.slice(0, 20).join(', '))}` : ''));
    return;
  }
  const user = (await vscode.window.showInputBox({ title: vscode.l10n.t('User, group or *PUBLIC'), ignoreFocusOut: true }))?.trim().toUpperCase();
  if (!user) { return; }
  const aut = await vscode.window.showQuickPick(['*USE', '*CHANGE', '*ALL', '*EXCLUDE', '*OBJOPR', '*READ', '*ADD', '*UPD', '*DLT', '*EXECUTE'], { title: vscode.l10n.t('Authority') });
  if (!aut) { return; }
  await run(conn, bulkAuthorityCommand(what.v === 'grt', lib, pattern, type, user, aut), vscode.l10n.t('One command covers every matching object.'));
}

const pick = (r: Row | undefined, ...keys: string[]) => { for (const k of keys) { const v = s(r, k); if (v) { return v; } } return ''; };

const NAME = /^[A-Za-z$#@][A-Za-z0-9$#@_.]{0,9}$/;

const nameCheck = (v: string) => (NAME.test(v.trim()) ? undefined : vscode.l10n.t('1–10 characters, starting with a letter, $, # or @.'));

async function runOk(conn: IbmiConnection, cmd: string): Promise<void> {
  const r = await conn.runCL(cmd);
  if (!r.ok) { throw new Error((r.stderr || r.stdout).trim().split('\n').filter(l => /[A-Z]{3}[0-9A-F]{4}/.test(l)).pop() || (r.stderr || r.stdout).trim().split('\n').pop() || cmd); }
}

async function publicAuthorityScan(manager: ConnectionManager, a?: unknown): Promise<void> {
  const conn = manager.require();
  const lib = ((a as { library?: string } | undefined)?.library ?? (typeof a === 'string' ? a : undefined)
    ?? await vscode.window.showInputBox({ title: vscode.l10n.t('*PUBLIC authority scan'), prompt: vscode.l10n.t('Library'), validateInput: nameCheck, ignoreFocusOut: true }))?.trim().toUpperCase();
  if (!lib) { return; }
  const rows = await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: vscode.l10n.t('Reading *PUBLIC authority in {0}…', lib) }, () =>
    conn.rows<Row>(`SELECT * FROM QSYS2.OBJECT_PRIVILEGES WHERE SYSTEM_OBJECT_SCHEMA = ${sqlString(lib)} AND AUTHORIZATION_NAME = '*PUBLIC'`, 20000));
  const list = rows.map(r => {
    const aut = pick(r, 'OBJECT_AUTHORITY'); const autl = pick(r, 'AUTHORIZATION_LIST');
    return { name: pick(r, 'SYSTEM_OBJECT_NAME', 'OBJECT_NAME'), type: pick(r, 'OBJECT_TYPE'), aut, autl, owner: pick(r, 'OWNER'), risk: publicRisk(aut, autl) };
  });
  const order = { bad: 0, warn: 1, info: 2, ok: 3 };
  list.sort((x, y) => order[x.risk] - order[y.risk] || x.name.localeCompare(y.name));
  const fix = (o: typeof list[number]) => {
    try {
      return { label: vscode.l10n.t('Set *PUBLIC *USE'), command: 'vanthrex.publicAuthority.set', args: [setPublicCommand(lib, o.name, o.type, '*USE'), lib] };
    } catch { return undefined; }
  };
  const bad = list.filter(o => o.risk === 'bad').length; const warn = list.filter(o => o.risk === 'warn').length;
  showReport('publicAuthority', {
    title: vscode.l10n.t('*PUBLIC authority — {0}', lib),
    subtitle: bad || warn ? vscode.l10n.t('{0} object(s) give *ALL and {1} give *CHANGE to everybody (*PUBLIC). Riskiest first.', bad, warn) : vscode.l10n.t('No object gives *ALL or *CHANGE to *PUBLIC. 👍'),
    facts: [[vscode.l10n.t('Objects'), list.length], ['*ALL', bad], ['*CHANGE', warn], ['*USE', list.filter(o => o.aut === '*USE').length], ['*EXCLUDE', list.filter(o => o.aut === '*EXCLUDE').length],
      [vscode.l10n.t('Secured by an authorization list'), list.filter(o => o.autl).length]],
    actions: [{ label: vscode.l10n.t('Scan again'), command: 'vanthrex.publicAuthorityScan', args: [lib] }],
    tables: [{ title: vscode.l10n.t('Objects'), filter: true, columns: [vscode.l10n.t('Object'), vscode.l10n.t('Type'), vscode.l10n.t('*PUBLIC authority'), vscode.l10n.t('Authorization list'), vscode.l10n.t('Owner')],
      rows: list.map(o => [o.name, o.type, o.aut, o.autl, o.owner]), rowClass: list.map(o => (o.risk === 'bad' ? 'bad' : o.risk === 'warn' ? 'different' : undefined)),
      rowActions: list.map(o => (o.risk === 'bad' || o.risk === 'warn' ? fix(o) : undefined)) }],
    note: vscode.l10n.t('Click a risky row to set *PUBLIC to *USE (asked first). Check that programs and users still work: some objects need *CHANGE on purpose.'),
  }, ALLOWED);
}

// ================================================================ registration

export function registerSecurityTools(context: vscode.ExtensionContext, manager: ConnectionManager): void {
  const guard = <A extends unknown[]>(fn: (...a: A) => Promise<unknown>) => async (...a: A) => {
    try { await fn(...a); } catch (e) { logError(e); vscode.window.showErrorMessage(errorMessage(e)); }
  };
  context.subscriptions.push(
    vscode.commands.registerCommand('vanthrex.exitPoints', guard(() => exitPoints(manager))),
    vscode.commands.registerCommand('vanthrex.bulkOwnerAuthority', guard((x?: unknown) => bulkOwnerAuthority(manager, x))),
    vscode.commands.registerCommand('vanthrex.publicAuthorityScan', guard((a?: unknown) => publicAuthorityScan(manager, a))),
    vscode.commands.registerCommand('vanthrex.publicAuthority.set', guard(async (cmd: string, lib: string) => {
      if (!/^(GRTOBJAUT|RVKOBJAUT) OBJ\([A-Z0-9$#@_.]+\/[A-Z0-9$#@_.]+\) OBJTYPE\(\*[A-Z]+\) USER\(\*PUBLIC\) AUT\(\*[A-Z]+\)( REPLACE\(\*YES\))?$/.test(cmd)) { throw new Error(vscode.l10n.t('Not allowed here: {0}', cmd)); }
      const yes = vscode.l10n.t('Run');
      if (await vscode.window.showWarningMessage(vscode.l10n.t('Run {0}?', cmd), { modal: true, detail: vscode.l10n.t('Programs or users that need more than *USE through *PUBLIC will get "not authorized".') }, yes) !== yes) { return; }
      await runOk(manager.require(), cmd);
      await publicAuthorityScan(manager, lib);
    })),
  );
}
