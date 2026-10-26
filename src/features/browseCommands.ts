import * as vscode from 'vscode';
import { readLibraries } from './libraryLookup';
import { ConnectionManager } from '../core/manager';
import { ConnectionProfile } from '../core/profiles';
import { errorMessage, logError, showLog } from '../core/log';
import { assertSystemName, clString, isValidSystemName } from '../core/util';
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
    const c = await vscode.window.showErrorMessage(errorMessage(e), vscode.l10n.t('Show Log'));
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
    if (!profile) { return vscode.window.showInformationMessage(vscode.l10n.t('Right-click a connection to edit it.')); }
    ConnectionForm.open(manager.profiles, manager.profiles.get(profile.id) ?? profile);
  });
  reg('vanthrex.deleteConnection', async (p: ConnectionProfile) => {
    const ok = await vscode.window.showWarningMessage(vscode.l10n.t('Remove connection "{0}" and its saved password?', p.name), { modal: true }, vscode.l10n.t('Remove'));
    if (ok !== vscode.l10n.t('Remove')) { return; }
    if (manager.isOpen(p.id)) { await manager.disconnect(p.id); }
    await manager.profiles.remove(p.id);
  });
  reg('vanthrex.connect', async (p?: ConnectionProfile) => {
    let profile = p;
    if (!profile) {
      const all = manager.profiles.list();
      if (!all.length) { return vscode.commands.executeCommand('vanthrex.addConnection'); }
      const pick = await vscode.window.showQuickPick(all.map(x => ({ label: x.name, description: `${x.user}@${x.host}`, x })),
        { title: vscode.l10n.t('Connect to IBM i') });
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
    const pick = await vscode.window.showQuickPick(items, { title: vscode.l10n.t('Switch IBM i system'), placeHolder: vscode.l10n.t('Open systems switch instantly; others connect and stay open') });
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
      { label: vscode.l10n.t('$(sparkle) Ask the IBM i AI assistant…'), cmd: 'vanthrex.ai.open' },
      { label: vscode.l10n.t('$(dashboard) System dashboard'), cmd: 'vanthrex.openDashboard' },
      { label: vscode.l10n.t('$(arrow-swap) Switch / add IBM i system…'), cmd: 'vanthrex.switchConnection' },
      { label: vscode.l10n.t('$(type-hierarchy) Call graph & impact analysis…'), cmd: 'vanthrex.callGraph' },
      // Git for IBM i is hidden for now (condition forced to false). Change to true to show it again.
      ...(GIT_FOR_IBMI_ENABLED ? [
        { label: vscode.l10n.t('$(source-control) Export source to a Git repository…'), cmd: 'vanthrex.git.export' },
        { label: vscode.l10n.t('$(cloud-upload) Git: upload changed files to IBM i'), cmd: 'vanthrex.git.upload' },
        { label: vscode.l10n.t('$(cloud-download) Git: get changes from IBM i'), cmd: 'vanthrex.git.download' },
      ] : []),
      { label: vscode.l10n.t('$(debug-alt) Debug a program…'), cmd: 'vanthrex.debugProgram' },
      { label: vscode.l10n.t('$(checklist) Debugger setup check'), cmd: 'vanthrex.debugSetup' },
      { label: vscode.l10n.t('$(terminal) Run CL command…'), cmd: 'vanthrex.runCl' },
      { label: vscode.l10n.t('$(list-selection) Prompt and run a CL command (F4)…'), cmd: 'vanthrex.promptCl' },
      { label: vscode.l10n.t('$(search) Search objects…'), cmd: 'vanthrex.searchObjects' },
      { label: vscode.l10n.t('$(search-fuzzy) Search source code…'), cmd: 'vanthrex.searchSource' },
      { label: vscode.l10n.t('$(table) Edit table data…'), cmd: 'vanthrex.editData' },
      { label: vscode.l10n.t('$(mail) Send a message…'), cmd: 'vanthrex.sendMessage' },
      { label: vscode.l10n.t('$(database) SQL editor with results…'), cmd: 'vanthrex.sqlQuery' },
      { label: vscode.l10n.t('$(database) New SQL scratchpad'), cmd: 'vanthrex.newSqlScratchpad' },
      { label: vscode.l10n.t('$(history) SQL history…'), cmd: 'vanthrex.sqlHistory' },
      { label: vscode.l10n.t('$(star-full) Saved queries…'), cmd: 'vanthrex.savedQueries' },
      { label: vscode.l10n.t('$(info) Object information…'), cmd: 'vanthrex.objectInfo' },
      { label: vscode.l10n.t('$(lock) Who has an object locked?…'), cmd: 'vanthrex.objectLocks' },
      { label: vscode.l10n.t('$(diff) Compare two libraries…'), cmd: 'vanthrex.compareLibraries' },
      { label: vscode.l10n.t('$(table) Compare table data (DEV ↔ PROD)…'), cmd: 'vanthrex.compareData' },
      { label: vscode.l10n.t('$(rocket) Index advisor…'), cmd: 'vanthrex.indexAdvisor' },
      { label: vscode.l10n.t('$(question) Explain a message ID…'), cmd: 'vanthrex.explainMessage' },
      { label: vscode.l10n.t('$(search-fuzzy) Analyze a job log…'), cmd: 'vanthrex.analyzeJobLog' },
      { label: vscode.l10n.t('$(history) Journal explorer: who changed a table…'), cmd: 'vanthrex.journalExplorer' },
      { label: vscode.l10n.t('$(shield) Check authority: can a user use an object?…'), cmd: 'vanthrex.checkAuthority' },
      { label: vscode.l10n.t('$(list-ordered) Data queue…'), cmd: 'vanthrex.dataQueue' },
      { label: vscode.l10n.t('$(symbol-variable) Data area…'), cmd: 'vanthrex.dataArea' },
      { label: vscode.l10n.t('$(pulse) PTF & system health…'), cmd: 'vanthrex.systemHealth' },
      { label: vscode.l10n.t('$(search) Find & open member…'), cmd: 'vanthrex.findMember' },
      { label: vscode.l10n.t('$(pulse) System Tracker — everything in one place'), cmd: 'vanthrex.systemTracker' },
      { label: vscode.l10n.t('$(repo-create) Create library…'), cmd: 'vanthrex.createLibrary' },
      { label: vscode.l10n.t('$(new-file) Create IFS folder or file…'), cmd: 'vanthrex.createIfs' },
      { label: vscode.l10n.t('$(terminal) Open 5250 session'), cmd: 'vanthrex.open5250' },
      { label: vscode.l10n.t('$(terminal-cmd) Command line (5250 style)'), cmd: 'vanthrex.commandLine' },
      { label: vscode.l10n.t('$(list-flat) Work with active jobs'), cmd: 'vanthrex.wrkactjob' },
      { label: vscode.l10n.t('$(terminal-linux) PASE terminal (IBM i shell)'), cmd: 'vanthrex.paseTerminal' },
      { label: vscode.l10n.t('$(notebook) New IBM i notebook (SQL, CL, shell)'), cmd: 'vanthrex.newNotebook' },
      { label: vscode.l10n.t('$(database) Browse a schema (SQL objects)…'), cmd: 'vanthrex.schemaBrowser' },
      { label: vscode.l10n.t('$(play) Call a stored procedure…'), cmd: 'vanthrex.callProcedure' },
      { label: vscode.l10n.t('$(warning) SQL error log'), cmd: 'vanthrex.sqlErrorLog' },
      { label: vscode.l10n.t('$(cloud-upload) Deploy local changes to the IFS'), cmd: 'vanthrex.deploy' },
      { label: vscode.l10n.t('$(tools) Build the local project on IBM i'), cmd: 'vanthrex.build' },
      { label: vscode.l10n.t('$(diff) Compare a local folder with the IFS…'), cmd: 'vanthrex.compareWithIfs' },
      { label: vscode.l10n.t('$(search) Find a value in table data…'), cmd: 'vanthrex.findInTable' },
      { label: vscode.l10n.t('$(json) Generate RPG from a JSON sample…'), cmd: 'vanthrex.jsonToRpg' },
      { label: vscode.l10n.t('$(briefcase) Work with job descriptions'), cmd: 'vanthrex.wrkJobDescriptions' },
      { label: vscode.l10n.t('$(pulse) My SQL job (library list, job log)'), cmd: 'vanthrex.mySqlJob' },
      { label: vscode.l10n.t('$(sparkle) AI: is the system healthy?'), cmd: 'vanthrex.ai.health' },
      { label: vscode.l10n.t('$(sparkle) AI: write CL from a description…'), cmd: 'vanthrex.ai.cl' },
      { label: vscode.l10n.t('$(shield) AI privacy and security'), cmd: 'vanthrex.ai.privacy' },
      { label: vscode.l10n.t('$(history) Job run history (how long each run took)…'), cmd: 'vanthrex.jobRunHistory' },
      { label: vscode.l10n.t('$(search) Find a message in job logs…'), cmd: 'vanthrex.findMessageInJobLogs' },
      { label: vscode.l10n.t('$(book) Document a library (Markdown)…'), cmd: 'vanthrex.documentLibrary' },
      { label: vscode.l10n.t('$(table) CRUD matrix of a library…'), cmd: 'vanthrex.crudMatrix' },
      { label: vscode.l10n.t('$(trash) Unused indexes of a library…'), cmd: 'vanthrex.unusedIndexes' },
      { label: vscode.l10n.t('$(book) Journal coverage of a library…'), cmd: 'vanthrex.journalCoverage' },
      { label: vscode.l10n.t('$(warning) Programs that would get a level check…'), cmd: 'vanthrex.levelCheck' },
      { label: vscode.l10n.t('$(device-camera) Take a library snapshot…'), cmd: 'vanthrex.librarySnapshot' },
      { label: vscode.l10n.t('$(diff) Compare a library with its snapshot…'), cmd: 'vanthrex.compareSnapshot' },
      { label: vscode.l10n.t('$(table) Create a table from a CSV or Excel file…'), cmd: 'vanthrex.csvToTable' },
      { label: vscode.l10n.t('$(json) JSON_TABLE query from a JSON sample…'), cmd: 'vanthrex.jsonTable' },
      { label: vscode.l10n.t('$(search) Find a text in spooled files…'), cmd: 'vanthrex.searchSpooledFiles' },
      ...(manager.openConnections.length > 1 ? [{ label: vscode.l10n.t('$(server-environment) Run SQL on several systems…'), cmd: 'vanthrex.sqlOnSystems' }, { label: vscode.l10n.t('$(server-environment) Run a CL command on several systems…'), cmd: 'vanthrex.clOnSystems' }] : []),
      { label: vscode.l10n.t('$(person) Who is signed on'), cmd: 'vanthrex.signedOn' },
      { label: vscode.l10n.t('$(note) All member notes'), cmd: 'vanthrex.notes.all' },
      { label: vscode.l10n.t('$(error) Failed jobs'), cmd: 'vanthrex.failedJobs' },
      { label: vscode.l10n.t('$(shield) Check service program signatures'), cmd: 'vanthrex.signatureCheck' },
      { label: vscode.l10n.t('$(list-selection) Work with using PDM…'), cmd: 'vanthrex.pdm' },
      { label: vscode.l10n.t('$(history) Compile history'), cmd: 'vanthrex.compileHistory' },
      { label: vscode.l10n.t('$(output) Live job log…'), cmd: 'vanthrex.jobLogLive' },
      { label: vscode.l10n.t('$(library) Add library to list…'), cmd: 'vanthrex.addLibrary' },
      { label: vscode.l10n.t('$(folder-opened) Go to IFS directory…'), cmd: 'vanthrex.ifsChangeRoot' },
      { label: vscode.l10n.t('$(output) Show output log'), cmd: 'vanthrex.showOutput' },
      { label: vscode.l10n.t('$(book) Open documentation'), cmd: 'vanthrex.openDocs' },
      { label: vscode.l10n.t('$(edit) Edit this connection…'), cmd: 'vanthrex.editConnection' },
      { label: vscode.l10n.t('$(debug-disconnect) Disconnect'), cmd: 'vanthrex.disconnect' },
      ...(manager.openConnections.length > 1 ? [{ label: vscode.l10n.t('$(debug-disconnect) Disconnect all systems'), cmd: 'vanthrex.disconnectAll' }] : []),
    ] : [
      { label: vscode.l10n.t('$(plug) Connect…'), cmd: 'vanthrex.connect' },
      { label: vscode.l10n.t('$(add) Add connection…'), cmd: 'vanthrex.addConnection' },
      { label: vscode.l10n.t('$(book) Getting started'), cmd: 'vanthrex.openWalkthrough' },
      { label: vscode.l10n.t('$(globe) Open documentation'), cmd: 'vanthrex.openDocs' },
    ];
    const pick = await vscode.window.showQuickPick(items, {
      title: c ? `IBM i — ${c.profile.name} (${c.user})` : 'IBM i — not connected',
    });
    if (pick?.cmd) { await vscode.commands.executeCommand(pick.cmd); }
  });
  reg('vanthrex.showOutput', () => showLog());
  reg('vanthrex.openDocs', () => vscode.env.openExternal(vscode.Uri.parse('https://gauravgupta0612.github.io/vanthrex-ibmi-docs/')));

  // ------------------------------------------------------------ libraries
  reg('vanthrex.refreshLibraries', () => { manager.connection?.invalidateCache(); libraries.refresh(); });
  reg('vanthrex.addLibrary', async () => {
    const conn = manager.require();
    const lib = await askName('Add library', 'Library to add to the top of your list');
    if (!lib) { return; }
    const found = await readLibraries(conn, [lib], 1);
    const exists = found.error ? [{}] : found.rows;
    if (!exists.length) {
      const go = await vscode.window.showWarningMessage(vscode.l10n.t('Library {0} was not found. Add it anyway?', lib), 'Add', vscode.l10n.t('Cancel'));
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
      [...SOURCE_FILES, { label: vscode.l10n.t('$(edit) Other name…'), description: '', rcdlen: 112 }],
      { title: vscode.l10n.t('New source file in {0}', n.library) });
    if (!pick) { return; }
    const name = pick.label.startsWith('$(') ? await askName('Source file name', 'Name of the new source file') : pick.label;
    if (!name) { return; }
    const r = await conn.runCL(`CRTSRCPF FILE(${n.library}/${name}) RCDLEN(${pick.rcdlen}) TEXT(${clString(pick.description || 'Source file')})`);
    if (!r.ok) { throw new Error(vscode.l10n.t('Could not create {0}/{1}: {2}', n.library, name, (r.stderr || r.stdout).trim())); }
    libraries.refresh();
    vscode.window.showInformationMessage(vscode.l10n.t('Created source file {0}/{1}.', n.library, name));
  });

  reg('vanthrex.newMember', async (n: SrcFile) => {
    const conn = manager.require();
    const guess = n.file.includes('CL') ? 'CLLE' : n.file.includes('DDS') ? 'PF' : n.file.includes('SQL') ? 'SQL' : 'RPGLE';
    const typePick = await vscode.window.showQuickPick(
      [...MEMBER_TYPES].sort((a, b) => (a.label === guess ? -1 : b.label === guess ? 1 : 0)),
      { title: vscode.l10n.t('New member in {0}/{1}', n.library, n.file), placeHolder: vscode.l10n.t('Source type') });
    if (!typePick) { return; }
    const name = await askName('Member name', `Name of the new ${typePick.label} member`);
    if (!name) { return; }
    const text = await vscode.window.showInputBox({ title: vscode.l10n.t('Description (optional)'), prompt: vscode.l10n.t('Member text'), ignoreFocusOut: true });
    if (text === undefined) { return; }
    const r = await conn.runCL(`ADDPFM FILE(${n.library}/${n.file}) MBR(${name}) SRCTYPE(${typePick.label}) TEXT(${clString(text || ' ')})`);
    if (!r.ok) { throw new Error(vscode.l10n.t('Could not add member {0}: {1}', name, (r.stderr || r.stdout).trim())); }
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
      { label: vscode.l10n.t('Changed today'), days: 1 }, { label: vscode.l10n.t('Changed in the last 7 days'), days: 7 },
      { label: vscode.l10n.t('Changed in the last 30 days'), days: 30 }, { label: vscode.l10n.t('Changed in the last 90 days'), days: 90 },
      { label: vscode.l10n.t('Other number of days…'), days: -1 }, { label: vscode.l10n.t('$(clear-all) Show all members'), days: 0 },
    ], { title: vscode.l10n.t('Filter {0} by last change', key) });
    if (!pick) { return; }
    let days = pick.days;
    if (days < 0) {
      const v = await vscode.window.showInputBox({ title: vscode.l10n.t('Days'), validateInput: x => /^\d+$/.test(x.trim()) && Number(x) > 0 ? undefined : 'Enter a number of days' });
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
    const ok = await vscode.window.showWarningMessage(vscode.l10n.t('Delete member {0}/{1}({2})? This cannot be undone.', n.library, n.file, n.member),
      { modal: true }, vscode.l10n.t('Delete'));
    if (ok !== vscode.l10n.t('Delete')) { return; }
    const r = await manager.require().runCL(`RMVM FILE(${n.library}/${n.file}) MBR(${n.member})`);
    if (!r.ok) { throw new Error((r.stderr || r.stdout).trim()); }
    libraries.refresh();
  });

  // vanthrex.findMember lives in memberToolsView.ts (library list or all user libraries, PDM and built-from buttons).

  // ------------------------------------------------------------ objects
  reg('vanthrex.objectCall', async (n: ObjectNode) => {
    const parms = await vscode.window.showInputBox({
      title: vscode.l10n.t('Call {0}/{1}', n.library, n.name), prompt: vscode.l10n.t('Parameters (optional), e.g. \'ABC\' \'X\''), ignoreFocusOut: true });
    if (parms === undefined) { return; }
    await vscode.commands.executeCommand('vanthrex.runCl',
      `CALL PGM(${n.library}/${n.name})${parms.trim() ? ` PARM(${parms.trim()})` : ''}`);
  });
  reg('vanthrex.objectQuery', (n: ObjectNode) =>
    runSqlAndShow(manager, context.globalState, `SELECT * FROM ${n.library}/${n.name} FETCH FIRST 100 ROWS ONLY`));
  reg('vanthrex.objectDelete', async (n: ObjectNode) => {
    const ok = await vscode.window.showWarningMessage(vscode.l10n.t('Delete {0} {1}/{2}? This cannot be undone.', n.type, n.library, n.name),
      { modal: true }, vscode.l10n.t('Delete'));
    if (ok !== vscode.l10n.t('Delete')) { return; }
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
  reg('vanthrex.ifsChangeRoot', async (to?: unknown) => {
    manager.require();
    if (typeof to === 'string' && to.startsWith('/')) { ifs.setRoot(to); return; }
    const path = await vscode.window.showInputBox({ title: vscode.l10n.t('Go to IFS directory'), value: ifs.rootPath ?? '/home', ignoreFocusOut: true });
    if (path?.trim()) { ifs.setRoot(path.trim()); }
  });
  reg('vanthrex.ifsNewFile', async (n: IfsNode) => {
    const name = await vscode.window.showInputBox({ title: vscode.l10n.t('New file in {0}', n.path), placeHolder: vscode.l10n.t('hello.rpgle'), ignoreFocusOut: true });
    if (!name?.trim()) { return; }
    const uri = ifsUri(`${n.path.replace(/\/$/, '')}/${name.trim()}`);
    await vscode.workspace.fs.writeFile(uri, new Uint8Array());
    ifs.refresh(n);
    await vscode.window.showTextDocument(uri);
  });
  reg('vanthrex.ifsNewFolder', async (n: IfsNode) => {
    const name = await vscode.window.showInputBox({ title: vscode.l10n.t('New folder in {0}', n.path), ignoreFocusOut: true });
    if (!name?.trim()) { return; }
    await manager.require().mkdir(`${n.path.replace(/\/$/, '')}/${name.trim()}`);
    ifs.refresh(n);
  });
  reg('vanthrex.ifsDelete', async (n: IfsNode) => {
    const ok = await vscode.window.showWarningMessage(
      vscode.l10n.t('Delete {0} {1}?', n.isDirectory ? 'folder (and everything in it)' : 'file', n.path), { modal: true }, vscode.l10n.t('Delete'));
    if (ok !== vscode.l10n.t('Delete')) { return; }
    await manager.require().removePath(n.path, n.isDirectory);
    ifs.refresh();
  });
}
