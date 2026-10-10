import * as vscode from 'vscode';
import { ConnectionManager } from '../core/manager';
import { ConnectionProfile } from '../core/profiles';
import { errorMessage, logError, showLog } from '../core/log';
import { assertSystemName, clString, isValidSystemName, sqlString } from '../core/util';
import { LibNode, LibraryTreeProvider } from '../views/libraryTree';
import { IfsNode, IfsTreeProvider } from '../views/ifsTree';
import { ConnectionForm } from './connectionForm';
import { ifsUri, memberUri } from './fileSystems';
import { runSqlAndShow } from './sqlRunner';

/** Git for IBM i is hidden from users for now. Keep false until the feature is released. */
const GIT_FOR_IBMI_ENABLED = false;

type Member = Extract<LibNode, { kind: 'member' }>;
type SrcFile = Extract<LibNode, { kind: 'srcfile' }>;
type Library = Extract<LibNode, { kind: 'library' }>;
type ObjectNode = Extract<LibNode, { kind: 'object' }>;

const MEMBER_TYPES = [
  { label: 'RPGLE', description: 'ILE RPG' },
  { label: 'SQLRPGLE', description: 'ILE RPG with embedded SQL' },
  { label: 'RPGLEINC', description: 'RPG copy member / prototypes' },
  { label: 'CLLE', description: 'ILE CL' },
  { label: 'CLP', description: 'OPM CL' },
  { label: 'CMD', description: 'Command definition' },
  { label: 'SQL', description: 'SQL script (RUNSQLSTM)' },
  { label: 'PF', description: 'Physical file DDS' },
  { label: 'LF', description: 'Logical file DDS' },
  { label: 'DSPF', description: 'Display file DDS' },
  { label: 'PRTF', description: 'Printer file DDS' },
  { label: 'TXT', description: 'Plain text' },
];

const SOURCE_FILES = [
  { label: 'QRPGLESRC', description: 'RPG source', rcdlen: 112 },
  { label: 'QCLLESRC', description: 'CL source', rcdlen: 92 },
  { label: 'QDDSSRC', description: 'DDS source', rcdlen: 92 },
  { label: 'QSQLSRC', description: 'SQL source', rcdlen: 160 },
  { label: 'QCMDSRC', description: 'Command source', rcdlen: 92 },
  { label: 'QCPYSRC', description: 'Copy members', rcdlen: 112 },
];

const STARTERS: Record<string, string> = {
  rpgle: `**free\nctl-opt dftactgrp(*no) actgrp(*caller) option(*srcstmt: *nodebugio);\n\ndcl-s message varchar(52);\n\nmessage = 'Hello from Vanthrex';\ndsply message;\n\n*inlr = *on;\nreturn;\n`,
  sqlrpgle: `**free\nctl-opt dftactgrp(*no) actgrp(*caller) option(*srcstmt: *nodebugio);\n\ndcl-s today date;\n\nexec sql SET :today = CURRENT DATE;\ndsply %char(today);\n\n*inlr = *on;\nreturn;\n`,
  clle: `             PGM\n             DCL        VAR(&MSG) TYPE(*CHAR) LEN(52) VALUE('Hello from Vanthrex')\n             SNDPGMMSG  MSG(&MSG)\n             ENDPGM\n`,
};

async function guard(fn: () => Promise<unknown>): Promise<void> {
  try { await fn(); }
  catch (e) {
    logError(e);
    const c = await vscode.window.showErrorMessage(errorMessage(e), 'Show Log');
    if (c) { showLog(); }
  }
}

function askName(title: string, prompt: string, value = ''): Thenable<string | undefined> {
  return vscode.window.showInputBox({
    title, prompt, value, ignoreFocusOut: true,
    validateInput: v => isValidSystemName(v.trim()) ? undefined : '1–10 characters, starting with a letter, $, # or @',
  }).then(v => v?.trim().toUpperCase());
}

export function registerBrowseCommands(
  context: vscode.ExtensionContext,
  manager: ConnectionManager,
  libraries: LibraryTreeProvider,
  ifs: IfsTreeProvider,
): void {
  const reg = (id: string, fn: (...args: any[]) => Promise<unknown> | unknown) =>
    context.subscriptions.push(vscode.commands.registerCommand(id, (...args) => guard(async () => fn(...args))));

  // ------------------------------------------------------------ connections
  reg('vanthrex.addConnection', () => ConnectionForm.open(manager.profiles));
  reg('vanthrex.editConnection', (p?: ConnectionProfile) => {
    const profile = p ?? manager.connection?.profile;
    if (!profile) { return vscode.window.showInformationMessage('Right-click a connection to edit it.'); }
    ConnectionForm.open(manager.profiles, manager.profiles.get(profile.id) ?? profile);
  });
  reg('vanthrex.deleteConnection', async (p: ConnectionProfile) => {
    const ok = await vscode.window.showWarningMessage(`Remove connection "${p.name}" and its saved password?`, { modal: true }, 'Remove');
    if (ok !== 'Remove') { return; }
    if (manager.isOpen(p.id)) { await manager.disconnect(p.id); }
    await manager.profiles.remove(p.id);
  });
  reg('vanthrex.connect', async (p?: ConnectionProfile) => {
    let profile = p;
    if (!profile) {
      const all = manager.profiles.list();
      if (!all.length) { return vscode.commands.executeCommand('vanthrex.addConnection'); }
      const pick = await vscode.window.showQuickPick(all.map(x => ({ label: x.name, description: `${x.user}@${x.host}`, x })),
        { title: 'Connect to IBM i' });
      profile = pick?.x;
    }
    if (profile) { await manager.connect(profile); }
  });
  reg('vanthrex.disconnect', (p?: ConnectionProfile) => manager.disconnect(p?.id));
  reg('vanthrex.disconnectAll', () => manager.disconnectAll());
  reg('vanthrex.switchConnection', async () => {
    const open = manager.openConnections;
    const active = manager.connection?.profile.id;
    type Item = vscode.QuickPickItem & { id?: string };
    const items: Item[] = [
      ...open.map(c => ({
        label: `${c.profile.id === active ? '$(vm-running)' : '$(vm-active)'} ${c.profile.name}`,
        description: `${c.user}@${c.profile.host}${c.profile.id === active ? ' · active' : ''}`,
        id: c.profile.id,
      })),
      ...manager.profiles.list().filter(p => !manager.isOpen(p.id)).map(p => ({
        label: `$(vm) ${p.name}`, description: `${p.user.toUpperCase()}@${p.host} · connect`, id: p.id,
      })),
    ];
    if (!items.length) { return vscode.commands.executeCommand('vanthrex.addConnection'); }
    const pick = await vscode.window.showQuickPick(items, { title: 'Switch IBM i system', placeHolder: 'Open systems switch instantly; others connect and stay open' });
    if (!pick?.id) { return; }
    if (manager.isOpen(pick.id)) { return manager.switchTo(pick.id); }
    const profile = manager.profiles.get(pick.id);
    if (profile) { await manager.connect(profile); }
  });
  reg('vanthrex.openWalkthrough', () =>
    vscode.commands.executeCommand('workbench.action.openWalkthrough', `${context.extension.id}#vanthrex.gettingStarted`, false));

  reg('vanthrex.showMenu', async () => {
    const c = manager.connection;
    type Item = vscode.QuickPickItem & { cmd?: string };
    const items: Item[] = c ? [
      { label: '$(sparkle) Ask the IBM i AI assistant…', cmd: 'vanthrex.ai.open' },
      { label: '$(dashboard) System dashboard', cmd: 'vanthrex.openDashboard' },
      { label: '$(arrow-swap) Switch / add IBM i system…', cmd: 'vanthrex.switchConnection' },
      { label: '$(type-hierarchy) Call graph & impact analysis…', cmd: 'vanthrex.callGraph' },
      // Git for IBM i is hidden for now (condition forced to false). Change to true to show it again.
      ...(GIT_FOR_IBMI_ENABLED ? [
        { label: '$(source-control) Export source to a Git repository…', cmd: 'vanthrex.git.export' },
        { label: '$(cloud-upload) Git: upload changed files to IBM i', cmd: 'vanthrex.git.upload' },
        { label: '$(cloud-download) Git: get changes from IBM i', cmd: 'vanthrex.git.download' },
      ] : []),
      { label: '$(debug-alt) Debug a program…', cmd: 'vanthrex.debugProgram' },
      { label: '$(checklist) Debugger setup check', cmd: 'vanthrex.debugSetup' },
      { label: '$(terminal) Run CL command…', cmd: 'vanthrex.runCl' },
      { label: '$(list-selection) Prompt and run a CL command (F4)…', cmd: 'vanthrex.promptCl' },
      { label: '$(search) Search objects…', cmd: 'vanthrex.searchObjects' },
      { label: '$(search-fuzzy) Search source code…', cmd: 'vanthrex.searchSource' },
      { label: '$(table) Edit table data…', cmd: 'vanthrex.editData' },
      { label: '$(mail) Send a message…', cmd: 'vanthrex.sendMessage' },
      { label: '$(database) SQL editor with results…', cmd: 'vanthrex.sqlQuery' },
      { label: '$(database) New SQL scratchpad', cmd: 'vanthrex.newSqlScratchpad' },
      { label: '$(history) SQL history…', cmd: 'vanthrex.sqlHistory' },
      { label: '$(star-full) Saved queries…', cmd: 'vanthrex.savedQueries' },
      { label: '$(info) Object information…', cmd: 'vanthrex.objectInfo' },
      { label: '$(lock) Who has an object locked?…', cmd: 'vanthrex.objectLocks' },
      { label: '$(diff) Compare two libraries…', cmd: 'vanthrex.compareLibraries' },
      { label: '$(search) Find & open member…', cmd: 'vanthrex.findMember' },
      { label: '$(library) Add library to list…', cmd: 'vanthrex.addLibrary' },
      { label: '$(folder-opened) Go to IFS directory…', cmd: 'vanthrex.ifsChangeRoot' },
      { label: '$(output) Show output log', cmd: 'vanthrex.showOutput' },
      { label: '$(book) Open documentation', cmd: 'vanthrex.openDocs' },
      { label: '$(edit) Edit this connection…', cmd: 'vanthrex.editConnection' },
      { label: '$(debug-disconnect) Disconnect', cmd: 'vanthrex.disconnect' },
      ...(manager.openConnections.length > 1 ? [{ label: '$(debug-disconnect) Disconnect all systems', cmd: 'vanthrex.disconnectAll' }] : []),
    ] : [
      { label: '$(plug) Connect…', cmd: 'vanthrex.connect' },
      { label: '$(add) Add connection…', cmd: 'vanthrex.addConnection' },
      { label: '$(book) Getting started', cmd: 'vanthrex.openWalkthrough' },
      { label: '$(globe) Open documentation', cmd: 'vanthrex.openDocs' },
    ];
    const pick = await vscode.window.showQuickPick(items, {
      title: c ? `IBM i — ${c.profile.name} (${c.user})` : 'IBM i — not connected',
    });
    if (pick?.cmd) { await vscode.commands.executeCommand(pick.cmd); }
  });
  reg('vanthrex.showOutput', () => showLog());
  reg('vanthrex.openDocs', () => vscode.env.openExternal(vscode.Uri.parse('https://gauravgupta0612.github.io/vanthrex-ibmi-docs/')));

  // ------------------------------------------------------------ libraries
  reg('vanthrex.refreshLibraries', () => libraries.refresh());
  reg('vanthrex.addLibrary', async () => {
    const conn = manager.require();
    const lib = await askName('Add library', 'Library to add to the top of your list');
    if (!lib) { return; }
    const exists = await conn.rows(`SELECT 1 AS X FROM TABLE(QSYS2.OBJECT_STATISTICS('QSYS', '*LIB', ${sqlString(lib)})) FETCH FIRST 1 ROW ONLY`)
      .catch(() => [{}]);
    if (!exists.length) {
      const go = await vscode.window.showWarningMessage(`Library ${lib} was not found. Add it anyway?`, 'Add', 'Cancel');
      if (go !== 'Add') { return; }
    }
    await manager.updateActiveProfile(p => { p.libraries = [lib, ...p.libraries.filter(l => l !== lib)]; });
  });
  reg('vanthrex.removeLibrary', (n: Library) =>
    manager.updateActiveProfile(p => {
      p.libraries = p.libraries.filter(l => l !== n.library);
      if (p.currentLibrary === n.library) { p.currentLibrary = undefined; }
    }));
  reg('vanthrex.setCurrentLibrary', (n: Library) =>
    manager.updateActiveProfile(p => { p.currentLibrary = n.library; }));

  reg('vanthrex.newSourceFile', async (n: Library) => {
    const conn = manager.require();
    const pick = await vscode.window.showQuickPick(
      [...SOURCE_FILES, { label: '$(edit) Other name…', description: '', rcdlen: 112 }],
      { title: `New source file in ${n.library}` });
    if (!pick) { return; }
    const name = pick.label.startsWith('$(') ? await askName('Source file name', 'Name of the new source file') : pick.label;
    if (!name) { return; }
    const r = await conn.runCL(`CRTSRCPF FILE(${n.library}/${name}) RCDLEN(${pick.rcdlen}) TEXT(${clString(pick.description || 'Source file')})`);
    if (!r.ok) { throw new Error(`Could not create ${n.library}/${name}: ${(r.stderr || r.stdout).trim()}`); }
    libraries.refresh();
    vscode.window.showInformationMessage(`Created source file ${n.library}/${name}.`);
  });

  reg('vanthrex.newMember', async (n: SrcFile) => {
    const conn = manager.require();
    const guess = n.file.includes('CL') ? 'CLLE' : n.file.includes('DDS') ? 'PF' : n.file.includes('SQL') ? 'SQL' : 'RPGLE';
    const typePick = await vscode.window.showQuickPick(
      [...MEMBER_TYPES].sort((a, b) => (a.label === guess ? -1 : b.label === guess ? 1 : 0)),
      { title: `New member in ${n.library}/${n.file}`, placeHolder: 'Source type' });
    if (!typePick) { return; }
    const name = await askName('Member name', `Name of the new ${typePick.label} member`);
    if (!name) { return; }
    const text = await vscode.window.showInputBox({ title: 'Description (optional)', prompt: 'Member text', ignoreFocusOut: true });
    if (text === undefined) { return; }
    const r = await conn.runCL(`ADDPFM FILE(${n.library}/${n.file}) MBR(${name}) SRCTYPE(${typePick.label}) TEXT(${clString(text || ' ')})`);
    if (!r.ok) { throw new Error(`Could not add member ${name}: ${(r.stderr || r.stdout).trim()}`); }
    libraries.refresh(n);
    const uri = memberUri(n.library, n.file, name, typePick.label);
    const editor = await vscode.window.showTextDocument(uri);
    const starter = STARTERS[typePick.label.toLowerCase()];
    if (starter && editor.document.getText().trim() === '') {
      await editor.edit(e => e.insert(new vscode.Position(0, 0), starter));
    }
  });

  reg('vanthrex.filterMembersByDate', async (n: SrcFile) => {
    const key = `${n.library}/${n.file}`;
    const pick = await vscode.window.showQuickPick([
      { label: 'Changed today', days: 1 }, { label: 'Changed in the last 7 days', days: 7 },
      { label: 'Changed in the last 30 days', days: 30 }, { label: 'Changed in the last 90 days', days: 90 },
      { label: 'Other number of days…', days: -1 }, { label: '$(clear-all) Show all members', days: 0 },
    ], { title: `Filter ${key} by last change` });
    if (!pick) { return; }
    let days = pick.days;
    if (days < 0) {
      const v = await vscode.window.showInputBox({ title: 'Days', validateInput: x => /^\d+$/.test(x.trim()) && Number(x) > 0 ? undefined : 'Enter a number of days' });
      if (!v) { return; }
      days = Number(v);
    }
    if (days) { libraries.memberFilter.set(key, days); } else { libraries.memberFilter.delete(key); }
    libraries.refresh();
  });
  reg('vanthrex.sortMembers', async () => {
    const cfg = vscode.workspace.getConfiguration('vanthrex');
    const next = cfg.get<string>('members.sortBy', 'name') === 'name' ? 'date' : 'name';
    await cfg.update('members.sortBy', next, vscode.ConfigurationTarget.Global);
    libraries.refresh();
    vscode.window.setStatusBarMessage(`Members sorted by ${next === 'date' ? 'last change (newest first)' : 'name'}`, 3000);
  });

  reg('vanthrex.deleteMember', async (n: Member) => {
    const ok = await vscode.window.showWarningMessage(`Delete member ${n.library}/${n.file}(${n.member})? This cannot be undone.`,
      { modal: true }, 'Delete');
    if (ok !== 'Delete') { return; }
    const r = await manager.require().runCL(`RMVM FILE(${n.library}/${n.file}) MBR(${n.member})`);
    if (!r.ok) { throw new Error((r.stderr || r.stdout).trim()); }
    libraries.refresh();
  });

  reg('vanthrex.findMember', async () => {
    const conn = manager.require();
    const pattern = await vscode.window.showInputBox({
      title: 'Find member', prompt: 'Member name or pattern (use * as a wildcard), searched across your library list',
      placeHolder: 'ORD*', ignoreFocusOut: true,
    });
    if (!pattern?.trim()) { return; }
    const libs = [...new Set([conn.profile.currentLibrary, ...conn.profile.libraries].filter(Boolean) as string[])];
    if (!libs.length) { throw new Error('Your library list is empty – add a library first.'); }
    const like = pattern.trim().toUpperCase().replace(/\*/g, '%');
    const rows = await vscode.window.withProgress({ location: vscode.ProgressLocation.Window, title: 'Searching members…' }, () =>
      conn.rows<{ LIB: string; FILE: string; MBR: string; TYPE: string; TEXT: string }>(
        `SELECT SYSTEM_TABLE_SCHEMA AS LIB, SYSTEM_TABLE_NAME AS FILE, SYSTEM_TABLE_MEMBER AS MBR, ` +
        `COALESCE(SOURCE_TYPE, '') AS TYPE, COALESCE(PARTITION_TEXT, '') AS TEXT FROM QSYS2.SYSPARTITIONSTAT ` +
        `WHERE SYSTEM_TABLE_SCHEMA IN (${libs.map(sqlString).join(', ')}) AND SOURCE_TYPE IS NOT NULL ` +
        `AND SYSTEM_TABLE_MEMBER LIKE ${sqlString(like)} ORDER BY 3, 1, 2 FETCH FIRST 500 ROWS ONLY`, 500));
    if (!rows.length) { return vscode.window.showInformationMessage(`No members matching "${pattern}" in ${libs.join(', ')}.`); }
    const pick = await vscode.window.showQuickPick(rows.map(r => ({
      label: `$(file-code) ${String(r.MBR).trim()}.${String(r.TYPE).trim().toLowerCase()}`,
      description: `${String(r.LIB).trim()}/${String(r.FILE).trim()}`,
      detail: String(r.TEXT ?? '').trim() || undefined, r,
    })), { title: `${rows.length} member(s) found`, matchOnDescription: true, matchOnDetail: true });
    if (pick) {
      const r = pick.r;
      await vscode.window.showTextDocument(memberUri(String(r.LIB).trim(), String(r.FILE).trim(), String(r.MBR).trim(), String(r.TYPE).trim()));
    }
  });

  // ------------------------------------------------------------ objects
  reg('vanthrex.objectCall', async (n: ObjectNode) => {
    const parms = await vscode.window.showInputBox({
      title: `Call ${n.library}/${n.name}`, prompt: "Parameters (optional), e.g. 'ABC' 'X'", ignoreFocusOut: true });
    if (parms === undefined) { return; }
    await vscode.commands.executeCommand('vanthrex.runCl',
      `CALL PGM(${n.library}/${n.name})${parms.trim() ? ` PARM(${parms.trim()})` : ''}`);
  });
  reg('vanthrex.objectQuery', (n: ObjectNode) =>
    runSqlAndShow(manager, context.globalState, `SELECT * FROM ${n.library}/${n.name} FETCH FIRST 100 ROWS ONLY`));
  reg('vanthrex.objectDelete', async (n: ObjectNode) => {
    const ok = await vscode.window.showWarningMessage(`Delete ${n.type} ${n.library}/${n.name}? This cannot be undone.`,
      { modal: true }, 'Delete');
    if (ok !== 'Delete') { return; }
    const lib = assertSystemName(n.library, 'library');
    const cmds: Record<string, string> = {
      '*PGM': `DLTPGM PGM(${lib}/${n.name})`, '*SRVPGM': `DLTSRVPGM SRVPGM(${lib}/${n.name})`,
      '*MODULE': `DLTMOD MODULE(${lib}/${n.name})`, '*FILE': `DLTF FILE(${lib}/${n.name})`,
      '*DTAARA': `DLTDTAARA DTAARA(${lib}/${n.name})`, '*CMD': `DLTCMD CMD(${lib}/${n.name})`,
      '*DTAQ': `DLTDTAQ DTAQ(${lib}/${n.name})`, '*BNDDIR': `DLTBNDDIR BNDDIR(${lib}/${n.name})`,
    };
    const cmd = cmds[n.type] ?? `DLTOBJ OBJ(${lib}/${n.name}) OBJTYPE(${n.type})`;
    const r = await manager.require().runCL(cmd);
    if (!r.ok) { throw new Error((r.stderr || r.stdout).trim()); }
    libraries.refresh();
  });

  // ------------------------------------------------------------ IFS
  reg('vanthrex.refreshIfs', () => ifs.refresh());
  reg('vanthrex.ifsChangeRoot', async () => {
    manager.require();
    const path = await vscode.window.showInputBox({ title: 'Go to IFS directory', value: ifs.rootPath ?? '/home', ignoreFocusOut: true });
    if (path?.trim()) { ifs.setRoot(path.trim()); }
  });
  reg('vanthrex.ifsNewFile', async (n: IfsNode) => {
    const name = await vscode.window.showInputBox({ title: `New file in ${n.path}`, placeHolder: 'hello.rpgle', ignoreFocusOut: true });
    if (!name?.trim()) { return; }
    const uri = ifsUri(`${n.path.replace(/\/$/, '')}/${name.trim()}`);
    await vscode.workspace.fs.writeFile(uri, new Uint8Array());
    ifs.refresh(n);
    await vscode.window.showTextDocument(uri);
  });
  reg('vanthrex.ifsNewFolder', async (n: IfsNode) => {
    const name = await vscode.window.showInputBox({ title: `New folder in ${n.path}`, ignoreFocusOut: true });
    if (!name?.trim()) { return; }
    await manager.require().mkdir(`${n.path.replace(/\/$/, '')}/${name.trim()}`);
    ifs.refresh(n);
  });
  reg('vanthrex.ifsDelete', async (n: IfsNode) => {
    const ok = await vscode.window.showWarningMessage(
      `Delete ${n.isDirectory ? 'folder (and everything in it)' : 'file'} ${n.path}?`, { modal: true }, 'Delete');
    if (ok !== 'Delete') { return; }
    await manager.require().removePath(n.path, n.isDirectory);
    ifs.refresh();
  });
}
