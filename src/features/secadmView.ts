import * as vscode from 'vscode';
import { ConnectionManager } from '../core/manager';
import { IbmiConnection } from '../core/connection';
import { errorMessage, log, logError } from '../core/log';
import { sqlString } from '../core/util';
import {
  LIMIT_CAPABILITIES, ProfileSpec, SPECIAL_AUTHORITIES, USER_CLASSES, addAutlEntryCommand, changeAutlEntryCommand, changeProfileCommand, createAutlCommand,
  createProfileCommand, deleteProfileCommand, hasSecadm, inactiveProfiles, redactPasswords, removeAutlEntryCommand, specFromExisting,
} from '../core/secadm';
import { showReport } from './reportPanel';

type Row = Record<string, unknown>;
const s = (r: Row | undefined, k: string) => String(r?.[k] ?? '').trim();
const progress = <T>(title: string, fn: () => Promise<T>) => vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title }, fn);
const ALLOWED = new Set(['vanthrex.securityCenter', 'vanthrex.secadm.row', 'vanthrex.secadm.createUser', 'vanthrex.secadm.copyUser', 'vanthrex.secadm.inactive',
  'vanthrex.secadm.disableInactive', 'vanthrex.secadm.powerful', 'vanthrex.secadm.groups', 'vanthrex.secadm.autl', 'vanthrex.secadm.autlEntries', 'vanthrex.secadm.autlRow',
  'vanthrex.secadm.createAutl', 'vanthrex.secadm.addAutlEntry', 'vanthrex.exitPoints', 'vanthrex.auditJournal', 'vanthrex.wrkSystemValues', 'vanthrex.checkAuthority']);

const secadmCache = new Map<string, boolean>();

async function detect(conn: IbmiConnection): Promise<boolean> {
  const key = `${conn.profile.id}|${conn.user}`;
  if (secadmCache.has(key)) { return secadmCache.get(key)!; }
  let ok = false;
  try {
    const me = await conn.rows<Row>(`SELECT COALESCE(SPECIAL_AUTHORITIES, '') AS S, COALESCE(GROUP_PROFILE_NAME, '*NONE') AS G, COALESCE(SUPPLEMENTAL_GROUP_LIST, '') AS SG FROM QSYS2.USER_INFO WHERE AUTHORIZATION_NAME = ${sqlString(conn.user)}`, 1);
    const groups = [s(me[0], 'G'), ...s(me[0], 'SG').split(/\s+/)].filter(g => g && g !== '*NONE');
    const gs = groups.length ? await conn.rows<Row>(`SELECT COALESCE(SPECIAL_AUTHORITIES, '') AS S FROM QSYS2.USER_INFO WHERE AUTHORIZATION_NAME IN (${groups.map(sqlString).join(', ')})`, 20).catch(() => []) : [];
    ok = hasSecadm(s(me[0], 'S'), gs.map(g => s(g, 'S')));
  } catch (e) { log(`*SECADM check: ${errorMessage(e)}`); }
  secadmCache.set(key, ok);
  return ok;
}

async function requireSecadm(manager: ConnectionManager): Promise<IbmiConnection> {
  const conn = manager.require();
  if (!(await detect(conn))) {
    throw new Error(vscode.l10n.t('The Security Admin center needs *SECADM special authority (yours or one of your group profiles). {0} does not have it on {1}.', conn.user, conn.profile.name));
  }
  return conn;
}

async function run(conn: IbmiConnection, cmd: string, warn: string, done: string): Promise<boolean> {
  const shown = redactPasswords(cmd);
  const pick = await vscode.window.showWarningMessage(shown, { modal: true, detail: warn }, vscode.l10n.t('Run'));
  if (pick !== vscode.l10n.t('Run')) { return false; }
  const r = await progress(shown.split(' ')[0], () => conn.runCL(cmd));
  if (!r.ok) { throw new Error(redactPasswords(`${cmd.split(' ')[0]}: ${(r.stderr || r.stdout).trim().split('\n').slice(-3).join(' ')}`)); }
  vscode.window.showInformationMessage(done);
  return true;
}

const USER_COLS = `AUTHORIZATION_NAME AS USR, STATUS, COALESCE(USER_CLASS_NAME, '') AS CLS, COALESCE(SPECIAL_AUTHORITIES, '*NONE') AS SPC, COALESCE(GROUP_PROFILE_NAME, '*NONE') AS GRP, ` +
  `COALESCE(SUPPLEMENTAL_GROUP_LIST, '') AS SUP, VARCHAR_FORMAT(PREVIOUS_SIGNON, 'YYYY-MM-DD HH24:MI') AS LAST, VARCHAR_FORMAT(CREATION_TIMESTAMP, 'YYYY-MM-DD HH24:MI') AS CRT, ` +
  `COALESCE(SIGN_ON_ATTEMPTS_NOT_VALID, 0) AS BAD, VARCHAR_FORMAT(DATE_PASSWORD_EXPIRES, 'YYYY-MM-DD') AS PWDEXP, COALESCE(NO_PASSWORD_INDICATOR, 'NO') AS NOPWD, COALESCE(TEXT_DESCRIPTION, '') AS TXT`;

// ================================================================ center

async function center(manager: ConnectionManager): Promise<void> {
  const conn = await requireSecadm(manager);
  const rows = await progress(vscode.l10n.t('Reading user profiles…'), () => conn.rows<Row>(`SELECT ${USER_COLS} FROM QSYS2.USER_INFO WHERE AUTHORIZATION_NAME NOT LIKE 'Q%' ORDER BY AUTHORIZATION_NAME`, 20000));
  const enabled = rows.filter(r => s(r, 'STATUS') === '*ENABLED');
  const strong = rows.filter(r => /\*ALLOBJ|\*SECADM/.test(s(r, 'SPC')));
  const idle = inactiveProfiles(rows.map(r => ({ user: s(r, 'USR'), status: s(r, 'STATUS'), lastSignon: s(r, 'LAST'), created: s(r, 'CRT') })), new Date(), 90);
  showReport('secadm', {
    title: vscode.l10n.t('Security Admin — {0}', conn.profile.name),
    subtitle: vscode.l10n.t('Signed on as {0} with *SECADM. {1} user profile(s) (IBM Q* profiles hidden). Click a profile to change, reset, disable, copy or delete it — every command is shown before it runs.', conn.user, rows.length),
    facts: [['Enabled / disabled', `${enabled.length} / ${rows.length - enabled.length}`], ['With *ALLOBJ or *SECADM', strong.length],
      ['Enabled but unused for 90+ days', idle.length], ['Locked out by bad sign-ons (≥ 3)', rows.filter(r => Number(r.BAD) >= 3).length]],
    actions: [
      { label: vscode.l10n.t('Create a user…'), command: 'vanthrex.secadm.createUser' }, { label: vscode.l10n.t('Copy a user…'), command: 'vanthrex.secadm.copyUser' },
      { label: vscode.l10n.t('Unused profiles'), command: 'vanthrex.secadm.inactive' }, { label: vscode.l10n.t('Powerful profiles'), command: 'vanthrex.secadm.powerful' },
      { label: vscode.l10n.t('Group profiles'), command: 'vanthrex.secadm.groups' }, { label: vscode.l10n.t('Authorization lists'), command: 'vanthrex.secadm.autl' },
      { label: vscode.l10n.t('Security audit journal'), command: 'vanthrex.auditJournal' }, { label: vscode.l10n.t('System values'), command: 'vanthrex.wrkSystemValues' },
      { label: vscode.l10n.t('Refresh'), command: 'vanthrex.securityCenter' },
    ],
    tables: [{ title: vscode.l10n.t('User profiles'), filter: true, columns: ['User', 'Status', 'Class', 'Special authorities', 'Group', 'Last sign-on', 'Bad sign-ons', 'Password expires', 'Description'],
      rows: rows.map(r => [s(r, 'USR'), s(r, 'STATUS'), s(r, 'CLS'), s(r, 'SPC'), s(r, 'GRP'), s(r, 'LAST') || 'never', s(r, 'BAD'), s(r, 'NOPWD') === 'YES' ? '*NONE' : s(r, 'PWDEXP'), s(r, 'TXT')]),
      rowActions: rows.map(r => ({ label: vscode.l10n.t('Options…'), command: 'vanthrex.secadm.row', args: [s(r, 'USR')] })),
      rowClass: rows.map(r => (s(r, 'STATUS') === '*DISABLED' ? 'dim' : /\*ALLOBJ|\*SECADM/.test(s(r, 'SPC')) ? 'different' : Number(r.BAD) >= 3 ? 'bad' : undefined)) }],
    note: vscode.l10n.t('Passwords are never shown, stored or written to the Vanthrex log. Changing special authorities, *SECOFR / *SECADM classes or other administrators may need *ALLOBJ as well as *SECADM, as IBM i requires.'),
  }, ALLOWED);
}

// ================================================================ create / copy / change / delete

async function pickMany<T extends string>(title: string, items: readonly T[], picked: string[]): Promise<string[] | undefined> {
  const r = await vscode.window.showQuickPick(items.map(i => ({ label: i, picked: picked.includes(i) })), { canPickMany: true, title, ignoreFocusOut: true });
  return r?.map(x => x.label);
}

async function askPassword(user: string): Promise<{ password: string; expired: boolean } | undefined> {
  const how = await vscode.window.showQuickPick([
    { label: vscode.l10n.t('$(key) Set a first password (must be changed at first sign-on)'), v: 'temp' },
    { label: vscode.l10n.t('$(circle-slash) No password (*NONE) — for service accounts and group profiles'), v: 'none' },
  ], { title: vscode.l10n.t('Password for {0}', user) });
  if (!how) { return undefined; }
  if (how.v === 'none') { return { password: '', expired: false }; }
  const p1 = await vscode.window.showInputBox({ title: vscode.l10n.t('First password for {0}', user), password: true, ignoreFocusOut: true, validateInput: v => (v.length ? (/'/.test(v) ? vscode.l10n.t('No quotes') : undefined) : vscode.l10n.t('Required')) });
  if (!p1) { return undefined; }
  const p2 = await vscode.window.showInputBox({ title: vscode.l10n.t('Type the password again'), password: true, ignoreFocusOut: true });
  if (p2 !== p1) { vscode.window.showErrorMessage(vscode.l10n.t('The two passwords are different.')); return undefined; }
  return { password: p1, expired: true };
}

async function groupPick(conn: IbmiConnection, current = ''): Promise<string | undefined> {
  const groups = await conn.rows<Row>(`SELECT AUTHORIZATION_NAME AS G, COALESCE(TEXT_DESCRIPTION, '') AS T FROM QSYS2.USER_INFO WHERE GROUP_ID_NUMBER IS NOT NULL AND GROUP_ID_NUMBER > 0 ORDER BY 1`, 2000).catch(() => []);
  const pick = await vscode.window.showQuickPick([{ label: '*NONE', description: vscode.l10n.t('No group profile') }, ...groups.map(g => ({ label: s(g, 'G'), description: s(g, 'T') }))],
    { title: vscode.l10n.t('Group profile (current: {0})', current || '*NONE') });
  return pick ? (pick.label === '*NONE' ? '' : pick.label) : undefined;
}

async function createUser(manager: ConnectionManager, base?: ProfileSpec): Promise<void> {
  const conn = await requireSecadm(manager);
  const user = (await vscode.window.showInputBox({ title: base ? vscode.l10n.t('Copy profile: new user name') : vscode.l10n.t('Create user (1/5): user profile name'), ignoreFocusOut: true,
    validateInput: v => (/^[A-Za-z$#@][\w$#@]{0,9}$/.test(v.trim()) && !/^q/i.test(v.trim()) ? undefined : vscode.l10n.t('1–10 characters, not starting with Q')) }))?.trim().toUpperCase();
  if (!user) { return; }
  const exists = await conn.rows<Row>(`SELECT 1 AS X FROM QSYS2.USER_INFO WHERE AUTHORIZATION_NAME = ${sqlString(user)}`, 1).catch(() => []);
  if (exists.length) { throw new Error(vscode.l10n.t('User profile {0} already exists.', user)); }
  const text = await vscode.window.showInputBox({ title: vscode.l10n.t('Description (usually the person\'s name)'), ignoreFocusOut: true });
  if (text === undefined) { return; }
  let spec: ProfileSpec = { ...(base ?? {}), user, text };
  if (!base) {
    const cls = await vscode.window.showQuickPick(USER_CLASSES.map(c => ({ label: c, picked: c === '*USER' })), { title: vscode.l10n.t('Create user (2/5): user class') });
    if (!cls) { return; }
    const spc = await pickMany(vscode.l10n.t('Create user (3/5): special authorities (none is the safe default)'), SPECIAL_AUTHORITIES, []);
    if (spc === undefined) { return; }
    const grp = await groupPick(conn);
    if (grp === undefined) { return; }
    const lib = await vscode.window.showInputBox({ title: vscode.l10n.t('Create user (4/5): current library (optional)'), ignoreFocusOut: true });
    if (lib === undefined) { return; }
    spec = { ...spec, userClass: cls.label, specialAuthorities: spc, groupProfile: grp, currentLibrary: lib.trim() || undefined };
  }
  const pw = await askPassword(user);
  if (!pw) { return; }
  spec = { ...spec, password: pw.password, passwordExpired: pw.password ? pw.expired : undefined };
  const cmd = createProfileCommand(spec);
  if (await run(conn, cmd, vscode.l10n.t('A new user profile is created. Tell the person their first password over a safe channel.'), vscode.l10n.t('User {0} created.', user))) { await center(manager); }
}

async function copyUser(manager: ConnectionManager, from?: string): Promise<void> {
  const conn = await requireSecadm(manager);
  const src = from ?? (await vscode.window.showInputBox({ title: vscode.l10n.t('Copy which user profile?'), ignoreFocusOut: true }))?.trim().toUpperCase();
  if (!src) { return; }
  const r = await conn.rows<Row>(`SELECT * FROM QSYS2.USER_INFO WHERE AUTHORIZATION_NAME = ${sqlString(src)}`, 1);
  if (!r.length) { throw new Error(vscode.l10n.t('User profile {0} was not found.', src)); }
  await createUser(manager, specFromExisting(r[0], ''));
}

async function changeUser(manager: ConnectionManager, user: string): Promise<void> {
  const conn = await requireSecadm(manager);
  const cur = (await conn.rows<Row>(`SELECT * FROM QSYS2.USER_INFO WHERE AUTHORIZATION_NAME = ${sqlString(user)}`, 1))[0];
  if (!cur) { throw new Error(vscode.l10n.t('User profile {0} was not found.', user)); }
  const what = await vscode.window.showQuickPick([
    { label: vscode.l10n.t('Description'), detail: s(cur, 'TEXT_DESCRIPTION'), v: 'text' },
    { label: vscode.l10n.t('User class'), detail: s(cur, 'USER_CLASS_NAME'), v: 'class' },
    { label: vscode.l10n.t('Special authorities'), detail: s(cur, 'SPECIAL_AUTHORITIES') || '*NONE', v: 'spc' },
    { label: vscode.l10n.t('Group profile'), detail: s(cur, 'GROUP_PROFILE_NAME'), v: 'grp' },
    { label: vscode.l10n.t('Supplemental groups'), detail: s(cur, 'SUPPLEMENTAL_GROUP_LIST') || '*NONE', v: 'sup' },
    { label: vscode.l10n.t('Current library'), detail: s(cur, 'CURRENT_LIBRARY_NAME'), v: 'curlib' },
    { label: vscode.l10n.t('Initial program'), detail: `${s(cur, 'INITIAL_PROGRAM_LIBRARY_NAME')}/${s(cur, 'INITIAL_PROGRAM_NAME')}`, v: 'inlpgm' },
    { label: vscode.l10n.t('Initial menu'), detail: `${s(cur, 'INITIAL_MENU_LIBRARY_NAME')}/${s(cur, 'INITIAL_MENU_NAME')}`, v: 'inlmnu' },
    { label: vscode.l10n.t('Limit capabilities'), detail: s(cur, 'LIMIT_CAPABILITIES'), v: 'lmt' },
    { label: vscode.l10n.t('Password expiration interval'), detail: s(cur, 'PASSWORD_EXPIRATION_INTERVAL'), v: 'pwdexpitv' },
  ], { title: vscode.l10n.t('Change {0}', user) });
  if (!what) { return; }
  let spec: ProfileSpec | undefined;
  switch (what.v) {
    case 'text': { const v = await vscode.window.showInputBox({ title: what.label, value: s(cur, 'TEXT_DESCRIPTION') }); if (v !== undefined) { spec = { user, text: v }; } break; }
    case 'class': { const v = await vscode.window.showQuickPick([...USER_CLASSES], { title: what.label }); if (v) { spec = { user, userClass: v }; } break; }
    case 'spc': { const v = await pickMany(what.label, SPECIAL_AUTHORITIES, s(cur, 'SPECIAL_AUTHORITIES').split(/\s+/)); if (v) { spec = { user, specialAuthorities: v }; } break; }
    case 'grp': { const v = await groupPick(conn, s(cur, 'GROUP_PROFILE_NAME')); if (v !== undefined) { spec = { user, groupProfile: v }; } break; }
    case 'sup': { const v = await vscode.window.showInputBox({ title: what.label, value: s(cur, 'SUPPLEMENTAL_GROUP_LIST'), prompt: vscode.l10n.t('Group profiles separated by spaces (at most 15)') }); if (v !== undefined) { spec = { user, supplementalGroups: v.split(/[\s,]+/).filter(Boolean) }; } break; }
    case 'curlib': { const v = await vscode.window.showInputBox({ title: what.label, value: s(cur, 'CURRENT_LIBRARY_NAME') }); if (v !== undefined) { spec = { user, currentLibrary: v }; } break; }
    case 'inlpgm': { const v = await vscode.window.showInputBox({ title: what.label, prompt: 'LIBRARY/PROGRAM or *NONE' }); if (v !== undefined) { spec = { user, initialProgram: v }; } break; }
    case 'inlmnu': { const v = await vscode.window.showInputBox({ title: what.label, prompt: 'LIBRARY/MENU, MAIN or *SIGNOFF' }); if (v !== undefined) { spec = { user, initialMenu: v }; } break; }
    case 'lmt': { const v = await vscode.window.showQuickPick([...LIMIT_CAPABILITIES], { title: what.label }); if (v) { spec = { user, limitCapabilities: v }; } break; }
    case 'pwdexpitv': {
      const v = await vscode.window.showInputBox({ title: what.label, prompt: vscode.l10n.t('Days (1–366), 0 = system value, -1 = no maximum'), validateInput: x => (/^-?\d+$/.test(x.trim()) ? undefined : vscode.l10n.t('A number')) });
      if (v !== undefined) { spec = { user, passwordExpirationInterval: Number(v) }; } break;
    }
  }
  if (!spec) { return; }
  if (await run(conn, changeProfileCommand(spec), vscode.l10n.t('Changes {0}. It takes effect at the next sign-on for most attributes.', user), vscode.l10n.t('{0} changed.', user))) { await center(manager); }
}

async function deleteUser(manager: ConnectionManager, user: string): Promise<void> {
  const conn = await requireSecadm(manager);
  if (user === conn.user) { throw new Error(vscode.l10n.t('You cannot delete the profile you are signed on with.')); }
  const owned = await conn.rows<Row>(`SELECT COUNT(*) AS N FROM QSYS2.OBJECT_OWNERSHIP WHERE AUTHORIZATION_NAME = ${sqlString(user)}`, 1).catch(() => []);
  const n = Number(owned[0]?.N ?? 0);
  const opt = await vscode.window.showQuickPick([
    { label: vscode.l10n.t('$(person) Give its objects to another profile'), v: 'chg' },
    ...(n === 0 ? [{ label: vscode.l10n.t('$(check) It owns nothing — delete it'), v: 'nodlt' }] : []),
    { label: vscode.l10n.t('$(trash) Delete its objects too'), v: 'dlt' },
  ], { title: vscode.l10n.t('Delete {0} — it owns {1} object(s)', user, n) });
  if (!opt) { return; }
  let own: '*NODLT' | '*DLT' | { newOwner: string } = opt.v === 'dlt' ? '*DLT' : '*NODLT';
  if (opt.v === 'chg') {
    const to = (await vscode.window.showInputBox({ title: vscode.l10n.t('New owner of the objects of {0}', user), value: 'QDFTOWN', ignoreFocusOut: true }))?.trim().toUpperCase();
    if (!to) { return; } own = { newOwner: to };
  }
  const confirm = await vscode.window.showInputBox({ title: vscode.l10n.t('Type {0} to confirm deleting this user profile', user), ignoreFocusOut: true });
  if (confirm?.trim().toUpperCase() !== user) { return; }
  if (await run(conn, deleteProfileCommand(user, own), opt.v === 'dlt' ? vscode.l10n.t('The profile and every object it owns are deleted. This can\'t be undone.') : vscode.l10n.t('The profile is deleted. This can\'t be undone.'), vscode.l10n.t('{0} deleted.', user))) { await center(manager); }
}

async function rowMenu(manager: ConnectionManager, user: string): Promise<void> {
  const conn = await requireSecadm(manager);
  const r = (await conn.rows<Row>(`SELECT ${USER_COLS} FROM QSYS2.USER_INFO WHERE AUTHORIZATION_NAME = ${sqlString(user)}`, 1))[0];
  if (!r) { throw new Error(vscode.l10n.t('User profile {0} was not found.', user)); }
  const enabled = s(r, 'STATUS') === '*ENABLED';
  const opts: { label: string; run: () => Promise<unknown> }[] = [
    { label: vscode.l10n.t('$(edit) Change attributes…'), run: () => changeUser(manager, user) },
    { label: vscode.l10n.t('$(key) Reset password…'), run: async () => {
      const pw = await askPassword(user); if (!pw) { return; }
      await run(conn, changeProfileCommand({ user, password: pw.password, passwordExpired: pw.password ? true : undefined, status: '*ENABLED' }), vscode.l10n.t('Sets a new password and enables the profile.'), vscode.l10n.t('Password of {0} reset.', user));
    } },
    enabled
      ? { label: vscode.l10n.t('$(lock) Disable'), run: () => run(conn, changeProfileCommand({ user, status: '*DISABLED' }), vscode.l10n.t('{0} can no longer sign on. Running jobs continue.', user), vscode.l10n.t('{0} disabled.', user)).then(async ok => { if (ok) { await center(manager); } }) }
      : { label: vscode.l10n.t('$(unlock) Enable'), run: () => run(conn, changeProfileCommand({ user, status: '*ENABLED' }), vscode.l10n.t('{0} can sign on again.', user), vscode.l10n.t('{0} enabled.', user)).then(async ok => { if (ok) { await center(manager); } }) },
    { label: vscode.l10n.t('$(clock) Expire password (change at next sign-on)'), run: () => run(conn, changeProfileCommand({ user, passwordExpired: true }), '', vscode.l10n.t('Done.')) },
    { label: vscode.l10n.t('$(copy) Create a new user like this one…'), run: () => copyUser(manager, user) },
    { label: vscode.l10n.t('$(shield) Check its authority on an object…'), run: async () => { await vscode.commands.executeCommand('vanthrex.checkAuthority'); } },
    { label: vscode.l10n.t('$(trash) Delete…'), run: () => deleteUser(manager, user) },
  ];
  const p = await vscode.window.showQuickPick(opts, { title: `${user} — ${s(r, 'TXT')} (${s(r, 'STATUS')}, ${s(r, 'CLS')})` });
  if (p) { await p.run(); }
}

// ================================================================ reports

async function inactive(manager: ConnectionManager, days?: number): Promise<void> {
  const conn = await requireSecadm(manager);
  const d = days ?? Number((await vscode.window.showQuickPick(['30', '60', '90', '180', '365'], { title: vscode.l10n.t('Not used for how many days?') })) ?? 0);
  if (!d) { return; }
  const rows = await conn.rows<Row>(`SELECT ${USER_COLS} FROM QSYS2.USER_INFO WHERE STATUS = '*ENABLED' AND AUTHORIZATION_NAME NOT LIKE 'Q%'`, 20000);
  const idle = inactiveProfiles(rows.map(r => ({ user: s(r, 'USR'), status: s(r, 'STATUS'), lastSignon: s(r, 'LAST'), created: s(r, 'CRT'), r })), new Date(), d)
    .filter(x => s(x.r, 'NOPWD') !== 'YES' && s(x.r, 'USR') !== conn.user);
  lastIdle = idle.map(x => x.user);
  showReport('secadmIdle', {
    title: vscode.l10n.t('Unused profiles — {0}+ days', d), subtitle: vscode.l10n.t('{0} enabled profile(s) with a password have not signed on for {1} days or more. Profiles without a password (service accounts, groups) are not listed.', idle.length, d),
    actions: idle.length ? [{ label: vscode.l10n.t('Disable all {0}…', idle.length), command: 'vanthrex.secadm.disableInactive' }, { label: vscode.l10n.t('Back'), command: 'vanthrex.securityCenter' }] : [{ label: vscode.l10n.t('Back'), command: 'vanthrex.securityCenter' }],
    tables: [{ title: vscode.l10n.t('Profiles'), filter: true, columns: ['User', 'Days unused', 'Last sign-on', 'Created', 'Class', 'Special authorities', 'Description'],
      rows: idle.map(x => [x.user, x.idleDays, s(x.r, 'LAST') || 'never', s(x.r, 'CRT'), s(x.r, 'CLS'), s(x.r, 'SPC'), s(x.r, 'TXT')]),
      rowActions: idle.map(x => ({ label: vscode.l10n.t('Options…'), command: 'vanthrex.secadm.row', args: [x.user] })), empty: vscode.l10n.t('None.') }],
    note: vscode.l10n.t('Disabling unused profiles is one of the most common audit recommendations; disabled profiles keep their objects and can be enabled again.'),
  }, ALLOWED);
}
let lastIdle: string[] = [];

async function disableInactive(manager: ConnectionManager): Promise<void> {
  const conn = await requireSecadm(manager);
  if (!lastIdle.length) { return; }
  const ok = await vscode.window.showWarningMessage(vscode.l10n.t('Disable {0} unused profile(s)?', lastIdle.length), { modal: true, detail: lastIdle.join(', ') }, vscode.l10n.t('Disable'));
  if (ok !== vscode.l10n.t('Disable')) { return; }
  const fails: string[] = [];
  await progress(vscode.l10n.t('Disabling…'), async () => { for (const u of lastIdle) { const r = await conn.runCL(changeProfileCommand({ user: u, status: '*DISABLED' })); if (!r.ok) { fails.push(u); } } });
  vscode.window.showInformationMessage(vscode.l10n.t('{0} profile(s) disabled.{1}', lastIdle.length - fails.length, fails.length ? ` ${vscode.l10n.t('Failed: {0}', fails.join(', '))}` : ''));
  lastIdle = [];
  await center(manager);
}

async function powerful(manager: ConnectionManager): Promise<void> {
  const conn = await requireSecadm(manager);
  const rows = await conn.rows<Row>(`SELECT ${USER_COLS} FROM QSYS2.USER_INFO WHERE SPECIAL_AUTHORITIES LIKE '%*ALLOBJ%' OR SPECIAL_AUTHORITIES LIKE '%*SECADM%' OR SPECIAL_AUTHORITIES LIKE '%*AUDIT%' ` +
    `OR SPECIAL_AUTHORITIES LIKE '%*SERVICE%' OR USER_CLASS_NAME IN ('*SECOFR', '*SECADM') ORDER BY AUTHORIZATION_NAME`, 5000);
  const members = await conn.rows<Row>(`SELECT GROUP_PROFILE_NAME AS G, USER_PROFILE_NAME AS U FROM QSYS2.GROUP_PROFILE_ENTRIES`, 50000).catch(() => []);
  const via = (g: string) => members.filter(m => s(m, 'G') === g).map(m => s(m, 'U'));
  showReport('secadmPowerful', {
    title: vscode.l10n.t('Powerful profiles'), subtitle: vscode.l10n.t('{0} profile(s) with *ALLOBJ, *SECADM, *AUDIT or *SERVICE, or class *SECOFR / *SECADM. Members of a powerful group get its special authorities too.', rows.length),
    actions: [{ label: vscode.l10n.t('Back'), command: 'vanthrex.securityCenter' }],
    tables: [{ title: vscode.l10n.t('Profiles'), filter: true, columns: ['Profile', 'Status', 'Class', 'Special authorities', 'Last sign-on', 'Members (if a group)', 'Description'],
      rows: rows.map(r => [s(r, 'USR'), s(r, 'STATUS'), s(r, 'CLS'), s(r, 'SPC'), s(r, 'LAST') || 'never', via(s(r, 'USR')).join(', '), s(r, 'TXT')]),
      rowActions: rows.map(r => (/^Q/.test(s(r, 'USR')) ? undefined : { label: vscode.l10n.t('Options…'), command: 'vanthrex.secadm.row', args: [s(r, 'USR')] })),
      rowClass: rows.map(r => (s(r, 'STATUS') === '*DISABLED' ? 'dim' : /\*ALLOBJ/.test(s(r, 'SPC')) ? 'bad' : 'different')) }],
  }, ALLOWED);
}

async function groups(manager: ConnectionManager): Promise<void> {
  const conn = await requireSecadm(manager);
  const g = await conn.rows<Row>(`SELECT ${USER_COLS} FROM QSYS2.USER_INFO WHERE GROUP_ID_NUMBER IS NOT NULL AND GROUP_ID_NUMBER > 0 ORDER BY AUTHORIZATION_NAME`, 5000);
  const members = await conn.rows<Row>(`SELECT GROUP_PROFILE_NAME AS G, USER_PROFILE_NAME AS U FROM QSYS2.GROUP_PROFILE_ENTRIES`, 50000).catch(() => []);
  showReport('secadmGroups', {
    title: vscode.l10n.t('Group profiles'), subtitle: vscode.l10n.t('{0} group profile(s). Users get the group\'s authorities and special authorities.', g.length),
    actions: [{ label: vscode.l10n.t('Create a group (a user with no password)…'), command: 'vanthrex.secadm.createUser' }, { label: vscode.l10n.t('Back'), command: 'vanthrex.securityCenter' }],
    tables: [{ title: vscode.l10n.t('Groups'), filter: true, columns: ['Group', 'Members', 'Special authorities', 'Description'],
      rows: g.map(r => { const m = members.filter(x => s(x, 'G') === s(r, 'USR')).map(x => s(x, 'U')); return [s(r, 'USR'), `${m.length}: ${m.slice(0, 30).join(', ')}${m.length > 30 ? '…' : ''}`, s(r, 'SPC'), s(r, 'TXT')]; }),
      rowActions: g.map(r => (/^Q/.test(s(r, 'USR')) ? undefined : { label: vscode.l10n.t('Options…'), command: 'vanthrex.secadm.row', args: [s(r, 'USR')] })) }],
    note: vscode.l10n.t('Add a user to a group with Options → Change attributes → Group profile (or Supplemental groups).'),
  }, ALLOWED);
}

async function autl(manager: ConnectionManager): Promise<void> {
  const conn = await requireSecadm(manager);
  const lists = await conn.rows<Row>(`SELECT AUTHORIZATION_LIST AS L, COALESCE(OWNER, '') AS O, COALESCE(TEXT_DESCRIPTION, '') AS T FROM QSYS2.AUTHORIZATION_LIST_INFO ORDER BY 1`, 5000)
    .catch(async () => conn.rows<Row>(`SELECT OBJNAME AS L, OBJOWNER AS O, COALESCE(OBJTEXT, '') AS T FROM TABLE(QSYS2.OBJECT_STATISTICS('QSYS', '*AUTL')) X ORDER BY 1`, 5000));
  showReport('secadmAutl', {
    title: vscode.l10n.t('Authorization lists'), subtitle: vscode.l10n.t('{0} authorization list(s). Click one to see and change who is on it.', lists.length),
    actions: [{ label: vscode.l10n.t('Create an authorization list…'), command: 'vanthrex.secadm.createAutl' }, { label: vscode.l10n.t('Back'), command: 'vanthrex.securityCenter' }],
    tables: [{ title: vscode.l10n.t('Lists'), filter: true, columns: ['List', 'Owner', 'Description'], rows: lists.map(r => [s(r, 'L'), s(r, 'O'), s(r, 'T')]),
      rowActions: lists.map(r => ({ label: vscode.l10n.t('Entries'), command: 'vanthrex.secadm.autlEntries', args: [s(r, 'L')] })) }],
  }, ALLOWED);
}

async function autlEntries(manager: ConnectionManager, list: string): Promise<void> {
  const conn = await requireSecadm(manager);
  const rows = await conn.rows<Row>(`SELECT AUTHORIZATION_NAME AS U, OBJECT_AUTHORITY AS A, COALESCE(AUTHORIZATION_LIST_MANAGEMENT, '') AS M FROM QSYS2.AUTHORIZATION_LIST_USER_INFO WHERE AUTHORIZATION_LIST = ${sqlString(list)} ORDER BY 1`, 5000);
  const objs = await conn.rows<Row>(`SELECT DISTINCT SYSTEM_OBJECT_SCHEMA AS L, SYSTEM_OBJECT_NAME AS N, OBJECT_TYPE AS T FROM QSYS2.OBJECT_PRIVILEGES WHERE AUTHORIZATION_LIST = ${sqlString(list)} FETCH FIRST 500 ROWS ONLY`, 500).catch(() => []);
  showReport('secadmAutlE', {
    title: vscode.l10n.t('Authorization list {0}', list), subtitle: vscode.l10n.t('{0} entr(ies); secures {1}{2} object(s). Click an entry to change or remove it.', rows.length, objs.length, objs.length >= 500 ? '+' : ''),
    actions: [{ label: vscode.l10n.t('Add a user…'), command: 'vanthrex.secadm.addAutlEntry', args: [list] }, { label: vscode.l10n.t('All lists'), command: 'vanthrex.secadm.autl' }],
    tables: [
      { title: vscode.l10n.t('Entries'), columns: ['User / *PUBLIC', 'Authority', 'List management'], rows: rows.map(r => [s(r, 'U'), s(r, 'A'), s(r, 'M')]),
        rowActions: rows.map(r => ({ label: vscode.l10n.t('Options…'), command: 'vanthrex.secadm.autlRow', args: [list, s(r, 'U')] })) },
      { title: vscode.l10n.t('Objects secured by this list'), filter: true, columns: ['Library', 'Object', 'Type'], rows: objs.map(o => [s(o, 'L'), s(o, 'N'), s(o, 'T')]), empty: vscode.l10n.t('None found.') },
    ],
  }, ALLOWED);
}

const AUTHS = ['*USE', '*CHANGE', '*ALL', '*EXCLUDE', '*AUTLMGT'];

export function registerSecadm(context: vscode.ExtensionContext, manager: ConnectionManager): void {
  const guard = <A extends unknown[]>(fn: (...a: A) => Promise<unknown>) => async (...a: A) => {
    try { await fn(...a); } catch (e) { logError(e); vscode.window.showErrorMessage(redactPasswords(errorMessage(e))); }
  };
  const setContext = async () => {
    const c = manager.connection;
    const ok = c ? await detect(c).catch(() => false) : false;
    await vscode.commands.executeCommand('setContext', 'vanthrex.secadm', ok);
  };
  context.subscriptions.push(
    manager.onDidChange(() => { void setContext(); }),
    vscode.commands.registerCommand('vanthrex.securityCenter', guard(() => center(manager))),
    vscode.commands.registerCommand('vanthrex.secadm.row', guard((u: string) => rowMenu(manager, String(u)))),
    vscode.commands.registerCommand('vanthrex.secadm.createUser', guard(() => createUser(manager))),
    vscode.commands.registerCommand('vanthrex.secadm.copyUser', guard((u?: string) => copyUser(manager, typeof u === 'string' ? u : undefined))),
    vscode.commands.registerCommand('vanthrex.secadm.inactive', guard(() => inactive(manager))),
    vscode.commands.registerCommand('vanthrex.secadm.disableInactive', guard(() => disableInactive(manager))),
    vscode.commands.registerCommand('vanthrex.secadm.powerful', guard(() => powerful(manager))),
    vscode.commands.registerCommand('vanthrex.secadm.groups', guard(() => groups(manager))),
    vscode.commands.registerCommand('vanthrex.secadm.autl', guard(() => autl(manager))),
    vscode.commands.registerCommand('vanthrex.secadm.autlEntries', guard((l: string) => autlEntries(manager, String(l)))),
    vscode.commands.registerCommand('vanthrex.secadm.createAutl', guard(async () => {
      const conn = await requireSecadm(manager);
      const name = (await vscode.window.showInputBox({ title: vscode.l10n.t('New authorization list name'), ignoreFocusOut: true }))?.trim().toUpperCase();
      if (!name) { return; }
      const text = await vscode.window.showInputBox({ title: vscode.l10n.t('Description'), ignoreFocusOut: true });
      if (text === undefined) { return; }
      if (await run(conn, createAutlCommand(name, text), vscode.l10n.t('*PUBLIC gets *EXCLUDE on the new list; add users next.'), vscode.l10n.t('{0} created.', name))) { await autlEntries(manager, name); }
    })),
    vscode.commands.registerCommand('vanthrex.secadm.addAutlEntry', guard(async (list: string) => {
      const conn = await requireSecadm(manager);
      const user = (await vscode.window.showInputBox({ title: vscode.l10n.t('Add which user or group to {0}?', list), ignoreFocusOut: true }))?.trim().toUpperCase();
      if (!user) { return; }
      const a = await vscode.window.showQuickPick(AUTHS, { title: vscode.l10n.t('Authority of {0}', user) });
      if (!a) { return; }
      if (await run(conn, addAutlEntryCommand(list, user, a), '', vscode.l10n.t('Done.'))) { await autlEntries(manager, list); }
    })),
    vscode.commands.registerCommand('vanthrex.secadm.autlRow', guard(async (list: string, user: string) => {
      const conn = await requireSecadm(manager);
      const p = await vscode.window.showQuickPick([{ label: vscode.l10n.t('$(edit) Change authority…'), v: 'chg' }, ...(user === '*PUBLIC' ? [] : [{ label: vscode.l10n.t('$(trash) Remove from the list'), v: 'rmv' }])], { title: `${list}: ${user}` });
      if (!p) { return; }
      if (p.v === 'chg') {
        const a = await vscode.window.showQuickPick(AUTHS.filter(x => user !== '*PUBLIC' || x !== '*AUTLMGT'), { title: vscode.l10n.t('Authority of {0}', user) });
        if (a && await run(conn, changeAutlEntryCommand(list, user, a), '', vscode.l10n.t('Done.'))) { await autlEntries(manager, list); }
      } else if (await run(conn, removeAutlEntryCommand(list, user), vscode.l10n.t('{0} loses the authority it had through this list.', user), vscode.l10n.t('Done.'))) { await autlEntries(manager, list); }
    })),
  );
  void setContext();
}
