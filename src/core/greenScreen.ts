// Green-screen helpers: how to open a 5250 session on this computer, which Vanthrex screen replaces an interactive
// 5250 command, and which display commands can print their output instead. Pure functions (no vscode import), unit tested.

import { parseClCommand } from './clCommand';

// ================================================================ 5250 session

export type Client5250 = 'auto' | 'acs' | 'tn5250' | 'command';
export interface Launch { kind: 'spawn' | 'terminal'; command: string; args: string[]; label: string }
export interface LaunchOptions {
  client: Client5250; host: string; user?: string; device?: string; ssl?: boolean; port?: number;
  acsPath?: string; command?: string; platform: string; home: string;
  exists: (path: string) => boolean; onPath: (exe: string) => boolean;
}

const HOST = /^[A-Za-z0-9][A-Za-z0-9.\-]*$|^\[[0-9A-Fa-f:]+\]$|^[0-9A-Fa-f:]+$/;
const DEVICE = /^[A-Za-z$#@][A-Za-z0-9$#@_]{0,9}$/;
const USER = /^[A-Za-z$#@][A-Za-z0-9$#@_]{0,9}$/;

/** Where IBM i Access Client Solutions is usually installed. */
export function acsCandidates(platform: string, home: string): string[] {
  const h = home.replace(/[\\/]$/, '');
  if (platform === 'win32') {
    return [
      `${h}\\IBM\\ClientSolutions\\Start_Programs\\Windows_x86-64\\acslaunch_win-64.exe`,
      'C:\\Users\\Public\\IBM\\ClientSolutions\\Start_Programs\\Windows_x86-64\\acslaunch_win-64.exe',
      'C:\\Program Files\\IBM\\ClientSolutions\\Start_Programs\\Windows_x86-64\\acslaunch_win-64.exe',
      `${h}\\IBM\\ClientSolutions\\acsbundle.jar`, 'C:\\Users\\Public\\IBM\\ClientSolutions\\acsbundle.jar',
    ];
  }
  if (platform === 'darwin') {
    return ['/Applications/IBM i Access Client Solutions.app', `${h}/Applications/IBM i Access Client Solutions.app`, `${h}/IBM/ClientSolutions/acsbundle.jar`];
  }
  return [`${h}/IBM/ClientSolutions/Start_Programs/Linux_x86-64/acslaunch_linux-64`, `${h}/IBM/ClientSolutions/acsbundle.jar`, '/opt/ibm/ClientSolutions/acsbundle.jar'];
}

/** Split a command template into words, keeping "quoted parts" together. */
export function splitWords(s: string): string[] {
  const out: string[] = []; const re = /"([^"]*)"|'([^']*)'|(\S+)/g; let m: RegExpExecArray | null;
  while ((m = re.exec(s))) { out.push(m[1] ?? m[2] ?? m[3]); }
  return out;
}

function acsLaunch(path: string, o: LaunchOptions): Launch {
  const args = ['/plugin=5250', `/system=${o.host}`];
  if (/\.jar$/i.test(path)) { return { kind: 'spawn', command: 'java', args: ['-jar', path, ...args], label: 'IBM i Access Client Solutions' }; }
  if (/\.app$/i.test(path)) { return { kind: 'spawn', command: 'open', args: ['-a', path, '--args', ...args], label: 'IBM i Access Client Solutions' }; }
  return { kind: 'spawn', command: path, args, label: 'IBM i Access Client Solutions' };
}

/** How to open a 5250 session for this system, or why it cannot be opened. */
export function launchPlan(o: LaunchOptions): Launch | { error: string } {
  if (!HOST.test(o.host)) { return { error: `"${o.host}" is not a valid host name.` }; }
  if (o.device && !DEVICE.test(o.device)) { return { error: `"${o.device}" is not a valid device name (1-10 characters).` }; }
  if (o.user && !USER.test(o.user)) { return { error: `"${o.user}" is not a valid user profile.` }; }
  if (o.client === 'command') {
    const t = (o.command ?? '').trim();
    if (!t) { return { error: 'Set vanthrex.5250.command, for example: "C:\\Tools\\pcomm.exe" /host=${host}' }; }
    const words = splitWords(t).map(w => w.replace(/\$\{host\}/g, o.host).replace(/\$\{user\}/g, o.user ?? '').replace(/\$\{device\}/g, o.device ?? '')
      .replace(/\$\{port\}/g, String(o.port ?? (o.ssl ? 992 : 23))));
    return { kind: 'spawn', command: words[0], args: words.slice(1).filter(w => w !== ''), label: words[0].split(/[\\/]/).pop() ?? words[0] };
  }
  const acs = o.acsPath?.trim() ? (o.exists(o.acsPath.trim()) ? o.acsPath.trim() : undefined) : acsCandidates(o.platform, o.home).find(p => o.exists(p));
  if (o.client === 'acs' || (o.client === 'auto' && acs)) {
    if (!acs) { return { error: o.acsPath?.trim() ? `IBM i Access Client Solutions was not found at ${o.acsPath}.` : 'IBM i Access Client Solutions was not found. Install it, or set vanthrex.5250.acsPath.' }; }
    return acsLaunch(acs, o);
  }
  if (o.client === 'tn5250' || o.client === 'auto') {
    if (!o.onPath('tn5250')) {
      return { error: o.client === 'auto'
        ? 'No 5250 emulator was found. Install IBM i Access Client Solutions (or tn5250), or set vanthrex.5250.client to "command" with your own emulator.'
        : 'tn5250 is not installed (for example: brew install tn5250, or apt install tn5250).' };
    }
    const target = `${o.ssl ? 'ssl:' : ''}${o.host}${o.port ? `:${o.port}` : ''}`;
    const args = [target, ...(o.device ? [`env.DEVNAME=${o.device.toUpperCase()}`] : []), ...(o.user ? [`env.USER=${o.user.toUpperCase()}`] : [])];
    return { kind: 'terminal', command: 'tn5250', args, label: 'tn5250' };
  }
  return { error: `Unknown 5250 client "${o.client}".` };
}

// ================================================================ interactive commands → Vanthrex screens

export interface Equivalent { command: string; args: unknown[]; screen: string }

function qualified(v: string | undefined, dflt = '*LIBL'): { library: string; name: string } | undefined {
  const s = (v ?? '').trim().toUpperCase();
  if (!s || s.startsWith('*') && !s.includes('/')) { return undefined; }
  const [a, b] = s.includes('/') ? s.split('/') : [dflt, s];
  return { library: a, name: b };
}

/**
 * The Vanthrex screen that does what an interactive (5250-only) command does, so it can be typed on the command line
 * as on a green screen. Commands asked to print (OUTPUT(*PRINT)) are left alone and run.
 */
export function interactiveEquivalent(text: string, user = ''): Equivalent | undefined {
  const p = parseClCommand(text);
  const cmd = p.command.replace(/^QSYS\//, '');
  const kw = (k: string, pos = -1) => p.params[k] ?? (pos >= 0 ? p.positional[pos] : undefined);
  if (/^\*PRINT/i.test(kw('OUTPUT') ?? '')) { return undefined; }
  const job = kw('JOB', 0)?.trim().toUpperCase();
  switch (cmd) {
    case 'WRKACTJOB': return { command: 'vanthrex.wrkactjob', args: [{ subsystem: kw('SBS')?.trim().toUpperCase(), job: kw('JOB')?.trim().toUpperCase() }], screen: 'Work with Active Jobs' };
    case 'WRKSPLF': return { command: 'vanthrex.spool.focus', args: [], screen: 'Spooled Files' };
    case 'WRKOBJLCK': { const o = qualified(kw('OBJ', 0)); const t = kw('OBJTYPE', 1)?.trim().toUpperCase(); return o ? { command: 'vanthrex.objectLocks', args: [{ ...o, type: t }], screen: 'Who has it locked' } : undefined; }
    case 'DSPJOBLOG': return job && job !== '*' ? { command: 'vanthrex.jobLog', args: [{ job }], screen: 'Job log' } : undefined;
    case 'WRKJOB': case 'DSPJOB': return job && job !== '*' ? { command: 'vanthrex.jobDetails', args: [job], screen: 'Job details' } : undefined;
    case 'WRKMSGQ': case 'DSPMSG': {
      const q = (kw('MSGQ', 0) ?? '').trim().toUpperCase();
      const name = !q || q === '*WRKUSR' || q === '*USRPRF' ? (user ? `QUSRSYS/${user.toUpperCase()}` : '') : q === '*SYSOPR' || q === 'QSYSOPR' ? 'QSYS/QSYSOPR' : q.includes('/') ? q : `*LIBL/${q}`;
      return name ? { command: 'vanthrex.messageQueue', args: [name], screen: 'Message queue' } : undefined;
    }
    case 'WRKSYSVAL': case 'DSPSYSVAL': return { command: 'vanthrex.wrkSystemValues', args: [], screen: 'System values' };
    case 'WRKUSRPRF': return { command: 'vanthrex.wrkUserProfiles', args: [], screen: 'User profiles' };
    case 'WRKOUTQ': { const q = qualified(kw('OUTQ', 0)); return q ? { command: 'vanthrex.wrkOutputQueue', args: [q.library, q.name], screen: 'Output queue' } : { command: 'vanthrex.wrkOutputQueues', args: [], screen: 'Output queues' }; }
    case 'WRKJOBQ': { const q = qualified(kw('JOBQ', 0)); return q ? { command: 'vanthrex.wrkJobQueue', args: [q.library, q.name], screen: 'Job queue' } : { command: 'vanthrex.wrkJobQueues', args: [], screen: 'Job queues' }; }
    case 'WRKSBS': return { command: 'vanthrex.wrkSubsystems', args: [], screen: 'Subsystems' };
    case 'WRKSBSJOB': { const s = kw('SBS', 0)?.trim().toUpperCase(); return s && !s.startsWith('*') ? { command: 'vanthrex.wrkSubsystemJobs', args: [s], screen: 'Subsystem jobs' } : { command: 'vanthrex.wrkSubsystems', args: [], screen: 'Subsystems' }; }
    case 'WRKJOBSCDE': return { command: 'vanthrex.wrkJobSchedule', args: [], screen: 'Job schedule' };
    case 'NETSTAT': case 'WRKTCPSTS': return { command: 'vanthrex.wrkConnections', args: [], screen: 'Network connections' };
    case 'WRKSYSSTS': case 'WRKDSKSTS': return { command: 'vanthrex.systemTracker', args: ['storage'], screen: 'System Tracker' };
    case 'DSPOBJD': case 'WRKOBJ': { const o = qualified(kw('OBJ', 0)); const t = kw('OBJTYPE', 1)?.trim().toUpperCase(); return o ? { command: 'vanthrex.objectInfo', args: [{ ...o, type: t && t !== '*ALL' ? t : undefined }], screen: 'Object information' } : undefined; }
    case 'DSPFD': case 'DSPFFD': { const o = qualified(kw('FILE', 0)); return o ? { command: 'vanthrex.objectInfo', args: [{ ...o, type: '*FILE' }], screen: 'Object information' } : undefined; }
    case 'STRSQL': case 'RUNSQL': return cmd === 'STRSQL' ? { command: 'vanthrex.newSqlScratchpad', args: [], screen: 'SQL scratchpad' } : undefined;
    case 'STRSEU': case 'EDTSRC': {
      const f = qualified(kw('SRCFILE', 0)); const m = kw('SRCMBR', 1)?.trim().toUpperCase();
      return f && m && !m.startsWith('*') ? { command: 'vanthrex.openMemberSource', args: [f.library, f.name, m], screen: 'Editor' } : undefined;
    }
    case 'WRKSAVF': { const o = qualified(kw('FILE', 0), '*ALL'); return { command: 'vanthrex.wrkSaveFiles', args: [o?.library ?? undefined], screen: 'Save files' }; }
    case 'WRKMBRPDM': case 'WRKOBJPDM': case 'WRKLIBPDM': case 'STRPDM': return { command: 'vanthrex.pdm', args: [text.trim()], screen: 'PDM' };
    // ---- 2.6.1: more of the commands people type every day on a green screen
    case 'GO': {
      const m = (kw('MENU', 0) ?? '').trim().toUpperCase();
      if (!m || m.startsWith('*')) { return { command: 'vanthrex.goMenu', args: [], screen: 'Menus' }; }
      const menu = goMenu(m);
      return menu ? { command: 'vanthrex.goMenu', args: [menu.id], screen: `Menu ${menu.id}` } : undefined;
    }
    case 'SIGNOFF': return { command: 'vanthrex.disconnect', args: [], screen: 'Sign off' };
    case 'DSPPFM': { const o = explicit(kw('FILE', 0)); return o ? { command: 'vanthrex.objectQuery', args: [o], screen: 'Data' } : { command: 'vanthrex.editData', args: [], screen: 'Table data' }; }
    case 'UPDDTA': case 'STRDFU': { const o = explicit(kw('FILE', 0)); return { command: 'vanthrex.editData', args: o ? [o] : [], screen: 'Table data' }; }
    case 'STRQRY': case 'WRKQRY': return { command: 'vanthrex.newSqlScratchpad', args: [], screen: 'SQL scratchpad' };
    case 'WRKDTAQ': case 'DSPDTAQ': { const o = explicit(kw('DTAQ', 0)); return { command: 'vanthrex.dataQueue', args: o ? [{ ...o, type: '*DTAQ' }] : [], screen: 'Data queue' }; }
    case 'WRKDTAARA': { const o = explicit(kw('DTAARA', 0)); return { command: 'vanthrex.dataArea', args: o ? [{ ...o, type: '*DTAARA' }] : [], screen: 'Data area' }; }
    case 'EDTDTAARA': { const o = explicit(kw('DTAARA', 0)); return { command: 'vanthrex.editDataArea', args: o ? [{ ...o, type: '*DTAARA' }] : [], screen: 'Data area' }; }
    case 'WRKMSGF': case 'WRKMSGD': { const o = explicit(kw('MSGF', cmd === 'WRKMSGF' ? 0 : 1)); return { command: 'vanthrex.messageFile', args: o ? [{ ...o, type: '*MSGF' }] : [], screen: 'Message file' }; }
    case 'WRKBNDDIR': case 'WRKBNDDIRE': { const o = explicit(kw('BNDDIR', 0)); return { command: 'vanthrex.bindingDirectory', args: o ? [{ ...o, type: '*BNDDIR' }] : [], screen: 'Binding directory' }; }
    case 'STRDBG': { const o = explicit(kw('PGM', 0)); return { command: 'vanthrex.debugProgram', args: o ? [{ ...o, type: '*PGM' }] : [], screen: 'Debugger' }; }
    case 'WRKJRN': { const o = explicit(kw('JRN', 0)); return { command: 'vanthrex.journals', args: o ? [o.library] : [], screen: 'Journals' }; }
    case 'DSPJRN': { const o = explicit(kw('FILE')); return o ? { command: 'vanthrex.journalExplorer', args: [{ ...o, type: '*FILE' }], screen: 'Journal explorer' } : { command: 'vanthrex.journals', args: [], screen: 'Journals' }; }
    case 'WRKAUTL': return { command: 'vanthrex.secadm.autl', args: [], screen: 'Authorization lists' };
    case 'EDTOBJAUT': case 'WRKAUT': { const o = explicit(kw('OBJ', 0)); const t = kw('OBJTYPE', 1)?.trim().toUpperCase(); return { command: 'vanthrex.checkAuthority', args: o ? [{ ...o, type: t }] : [], screen: 'Authority' }; }
    case 'DSPLOG': return { command: 'vanthrex.historyLog', args: [], screen: 'History log' };
    case 'WRKPTF': case 'WRKPTFGRP': return { command: 'vanthrex.systemHealth', args: [], screen: 'PTF & system health' };
    case 'WRKSYSACT': return { command: 'vanthrex.performanceMonitor', args: [], screen: 'Performance monitor' };
    case 'EDTLIBL': return { command: 'vanthrex.librarySets', args: [], screen: 'Library list' };
    case 'WRKLNK': case 'DSPLNK': return { command: 'vanthrex.ifs.focus', args: [], screen: 'IFS' };
    case 'WRKLIB': { const l = kw('LIB', 0)?.trim().toUpperCase(); return { command: 'vanthrex.pdm', args: [l && !/^\*(LIBL|USRLIBL|ALL)$/.test(l) ? `WRKLIBPDM LIB(${l})` : 'WRKLIBPDM'], screen: 'PDM' }; }
    case 'WRKF': case 'WRKPGM': case 'WRKSRVPGM': case 'WRKMOD': case 'WRKCMD': case 'WRKMNU': {
      const keys: Record<string, [string, string]> = { WRKF: ['FILE', '*FILE'], WRKPGM: ['PGM', '*PGM'], WRKSRVPGM: ['SRVPGM', '*SRVPGM'], WRKMOD: ['MODULE', '*MODULE'], WRKCMD: ['CMD', '*CMD'], WRKMNU: ['MENU', '*MENU'] };
      const [key, type] = keys[cmd];
      const o = explicit(kw(key, 0));
      return o ? { command: 'vanthrex.pdm', args: [`WRKOBJPDM LIB(${o.library}) OBJ(${o.name}) OBJTYPE(${type})`], screen: 'PDM' } : { command: 'vanthrex.searchObjects', args: [], screen: 'Search objects' };
    }
  }
  return undefined;
}

/** LIB/NAME only when the library is named (not *LIBL / *CURLIB): the screens read the object by library. */
function explicit(v: string | undefined): { library: string; name: string } | undefined {
  const o = qualified(v);
  return o && !o.library.startsWith('*') && !o.name.startsWith('*') ? o : undefined;
}

// ================================================================ GO menus

/**
 * One option of a menu: `run` is a command typed as on the menu's command line (WRKACTJOB, GO SYSTEM…) or a Vanthrex
 * command id (vanthrex.…) for the screens a green screen never had.
 */
/** needs: what must be open in the editor for the option to work (an RPG source, or any IBM i source). */
export interface MenuOption { n: number; text: string; run: string; needs?: Needs }
export type Needs = 'rpg' | 'source';
export interface Menu { id: string; title: string; options: MenuOption[] }

const o = (n: number, text: string, run: string, needs?: Needs): MenuOption => (needs ? { n, text, run, needs } : { n, text, run });

/** The IBM i menus people know (GO MAIN, GO PROGRAMMER…), each option opening the matching Vanthrex screen. */
export const GO_MENUS: Menu[] = [
  { id: 'MAIN', title: 'IBM i Main Menu', options: [
    o(1, 'User tasks', 'GO USER'), o(2, 'RPG development', 'GO RPG'), o(3, 'General system tasks', 'GO SYSTEM'), o(4, 'Files, libraries, and folders', 'GO FILE'),
    o(5, 'Programming', 'GO PROGRAMMER'), o(6, 'Communications', 'GO CMN'), o(7, 'Security', 'GO SECURITY'), o(8, 'Problem handling', 'GO PROBLEM'),
    o(9, 'Display a menu', 'GO'), o(10, 'Vanthrex quick menu (all tools)', 'vanthrex.showMenu'), o(11, 'Command line', 'vanthrex.commandLine'), o(90, 'Sign off', 'SIGNOFF'),
  ] },
  { id: 'RPG', title: 'RPG Development', options: [
    o(1, 'Find and open a source member', 'vanthrex.findMember'), o(2, 'Go to anything (members, objects, recent)', 'vanthrex.goToAnything'),
    o(3, 'Tools for this source (toolbox)', 'vanthrex.dev.toolbox', 'source'), o(4, 'Compile this source', 'vanthrex.compile', 'source'),
    o(5, 'Compile with… (pick the command)', 'vanthrex.compileWith', 'source'), o(6, 'My changes since the last compile', 'vanthrex.changedSinceCompile', 'source'),
    o(7, 'Copy the compile command', 'vanthrex.dev.copyCompile', 'source'), o(8, 'Compile history', 'vanthrex.compileHistory'),
    o(9, 'Compile changed members', 'vanthrex.batchCompile'), o(10, 'Run RPG code checks', 'vanthrex.lintCurrent', 'rpg'),
    o(11, 'Check /COPY usage', 'vanthrex.checkCopybooks', 'rpg'), o(12, 'Remove unused declarations', 'vanthrex.rpg.removeUnusedDeclarations', 'rpg'),
    o(13, 'Convert fixed format to free', 'vanthrex.convertToFree', 'rpg'), o(14, 'Convert a subroutine to a procedure', 'vanthrex.dev.subrToProc', 'rpg'),
    o(15, 'Convert IF / ELSEIF to SELECT', 'vanthrex.rpg.ifToSelect', 'rpg'), o(16, 'Insert a procedure skeleton', 'vanthrex.rpg.procedureHeader', 'rpg'),
    o(17, 'Generate the prototype of this procedure', 'vanthrex.generatePrototype', 'rpg'), o(18, 'Prototype copybook from the exports', 'vanthrex.rpg.prototypeCopybook', 'rpg'),
    o(19, 'Binder source from the exports', 'vanthrex.rpg.binderSource', 'rpg'), o(20, 'Who calls each exported procedure', 'vanthrex.procedureCallers'),
    o(21, 'Flowchart of this procedure', 'vanthrex.flowchart', 'rpg'), o(22, 'Data structure layout (positions, lengths)', 'vanthrex.dsLayout', 'rpg'),
    o(23, 'Generate RPG from a JSON sample', 'vanthrex.jsonToRpg'), o(24, 'Generate RPGUnit tests', 'vanthrex.rpgunit.generate', 'rpg'),
    o(25, 'Debug a program (STRDBG)', 'STRDBG'), o(26, 'Where used', 'vanthrex.whereUsed'), o(27, 'Search source code', 'vanthrex.searchSource'),
    o(28, 'Explain SQLCODE / SQLSTATE / RPG status', 'vanthrex.explainCode'),
  ] },
  { id: 'USER', title: 'User Tasks', options: [
    o(1, 'Display or change your job (library list, job log)', 'vanthrex.mySqlJob'), o(2, 'Display messages', 'DSPMSG'), o(3, 'Send a message', 'SNDMSG'),
    o(4, 'Submit a job', 'SBMJOB'), o(5, 'Work with your spooled output files', 'WRKSPLF'), o(6, 'Work with your jobs', 'vanthrex.myJobs'),
    o(7, 'Change your library list', 'EDTLIBL'), o(8, 'Job run history', 'vanthrex.jobRunHistory'), o(9, 'Who is signed on', 'vanthrex.signedOn'),
  ] },
  { id: 'SYSTEM', title: 'General System Tasks', options: [
    o(1, 'Work with active jobs', 'WRKACTJOB'), o(2, 'Work with system status', 'WRKSYSSTS'), o(3, 'Work with subsystems', 'WRKSBS'),
    o(4, 'Work with job queues', 'WRKJOBQ'), o(5, 'Work with output queues', 'WRKOUTQ'), o(6, 'Work with job schedule entries', 'WRKJOBSCDE'),
    o(7, 'Work with system values', 'WRKSYSVAL'), o(8, 'Display QSYSOPR messages', 'DSPMSG QSYSOPR'), o(9, 'Work with job descriptions', 'vanthrex.wrkJobDescriptions'),
    o(10, 'Work with system activity (performance)', 'WRKSYSACT'), o(11, 'System dashboard', 'vanthrex.openDashboard'), o(12, 'Work with PTFs', 'WRKPTF'),
    o(13, 'Storage and cleanup advisor', 'vanthrex.storageAdvisor'), o(14, 'System Tracker (everything in one place)', 'vanthrex.systemTracker'),
  ] },
  { id: 'FILE', title: 'Files, Libraries, and Folders', options: [
    o(1, 'Work with libraries (PDM)', 'WRKLIBPDM'), o(2, 'Work with objects (PDM)', 'vanthrex.pdm'), o(3, 'Work with members (PDM)', 'vanthrex.pdm'),
    o(4, 'Display physical file member', 'DSPPFM'), o(5, 'Update data (DFU)', 'UPDDTA'), o(6, 'Find an object', 'vanthrex.searchObjects'),
    o(7, 'Find and open a source member', 'vanthrex.findMember'), o(8, 'Work with save files', 'WRKSAVF'), o(9, 'Work with data queues', 'WRKDTAQ'),
    o(10, 'Work with data areas', 'WRKDTAARA'), o(11, 'Work with journals', 'WRKJRN'), o(12, 'Work with object links (IFS)', 'WRKLNK'),
    o(13, 'Find a value in table data', 'vanthrex.findInTable'), o(14, 'Compare two libraries', 'vanthrex.compareLibraries'),
  ] },
  { id: 'PROGRAMMER', title: 'Programming', options: [
    o(1, 'Start PDM', 'STRPDM'), o(2, 'Edit a source member (SEU)', 'vanthrex.findMember'), o(3, 'Compile the current source', 'vanthrex.compile'),
    o(4, 'Compile changed members', 'vanthrex.batchCompile'), o(5, 'Start SQL (STRSQL)', 'STRSQL'), o(6, 'Start debug (STRDBG)', 'STRDBG'),
    o(7, 'Call graph (DSPPGMREF)', 'vanthrex.callGraph'), o(8, 'Where used', 'vanthrex.whereUsed'), o(9, 'Search source code', 'vanthrex.searchSource'),
    o(10, 'Work with message files', 'WRKMSGF'), o(11, 'Work with binding directories', 'WRKBNDDIR'), o(12, 'Compile history', 'vanthrex.compileHistory'),
    o(13, 'Promote objects (DEV → TEST → PROD)', 'vanthrex.promoteObjects'), o(14, 'Call a program', 'CALL'), o(15, 'Tools for this source (toolbox)', 'vanthrex.dev.toolbox'),
  ] },
  { id: 'CMN', title: 'Communications', options: [
    o(1, 'Work with TCP/IP connections (NETSTAT)', 'NETSTAT'), o(2, 'Work with TCP/IP servers', 'vanthrex.wrkTcpServers'), o(3, 'IP interfaces and routes', 'vanthrex.wrkInterfaces'),
    o(4, 'NetServer shares', 'vanthrex.netServerShares'), o(5, 'Open a 5250 session', 'vanthrex.open5250'), o(6, 'PASE terminal (IBM i shell)', 'vanthrex.paseTerminal'),
  ] },
  { id: 'SECURITY', title: 'Security', options: [
    o(1, 'Work with user profiles', 'WRKUSRPRF'), o(2, 'Work with authorization lists', 'WRKAUTL'), o(3, 'Edit object authority', 'EDTOBJAUT'),
    o(4, '*PUBLIC authority scan', 'vanthrex.publicAuthorityScan'), o(5, 'Security audit journal (QAUDJRN)', 'vanthrex.auditJournal'),
    o(6, 'Security admin center (*SECADM)', 'vanthrex.securityCenter'), o(7, 'Work with system values', 'WRKSYSVAL'),
  ] },
  { id: 'PROBLEM', title: 'Problem Handling', options: [
    o(1, 'Display QSYSOPR messages', 'DSPMSG QSYSOPR'), o(2, 'Explain a message ID', 'vanthrex.explainMessage'), o(3, 'Analyze a job log', 'vanthrex.analyzeJobLog'),
    o(4, 'Failed jobs', 'vanthrex.failedJobs'), o(5, 'Display history log (QHST)', 'DSPLOG'), o(6, 'Who has an object locked', 'vanthrex.objectLocks'),
    o(7, 'Who is locking rows', 'vanthrex.rowLocks'), o(8, 'SQL error log', 'vanthrex.sqlErrorLog'), o(9, 'Self-check of this connection', 'vanthrex.selfCheck'),
  ] },
];

/** Codicon for each menu in the side bar. */
export const MENU_ICONS: Record<string, string> = {
  MAIN: 'home', RPG: 'symbol-method', USER: 'person', SYSTEM: 'server', FILE: 'library', PROGRAMMER: 'code', CMN: 'globe', SECURITY: 'shield', PROBLEM: 'warning',
};

/**
 * Every 5250 command that opens a Vanthrex screen (A to Z), so they can be browsed and clicked instead of remembered.
 * Group: the AS/400 area it belongs to.
 */
export const GREEN_SCREEN_COMMANDS: { cmd: string; text: string; group: string }[] = [
  { cmd: 'DSPJOB', text: 'Display job', group: 'Jobs' },
  { cmd: 'DSPJOBLOG', text: 'Display job log', group: 'Jobs' },
  { cmd: 'DSPJRN', text: 'Display journal (who changed a file)', group: 'Database' },
  { cmd: 'DSPLOG', text: 'Display history log (QHST)', group: 'System' },
  { cmd: 'DSPMSG', text: 'Display messages', group: 'Messages' },
  { cmd: 'DSPPFM', text: 'Display physical file member', group: 'Database' },
  { cmd: 'EDTDTAARA', text: 'Edit data area', group: 'Objects' },
  { cmd: 'EDTLIBL', text: 'Edit library list', group: 'Libraries' },
  { cmd: 'EDTOBJAUT', text: 'Edit object authority', group: 'Security' },
  { cmd: 'GO', text: 'Go to menu', group: 'Menus' },
  { cmd: 'NETSTAT', text: 'Network status', group: 'Communications' },
  { cmd: 'SIGNOFF', text: 'Sign off', group: 'Menus' },
  { cmd: 'STRDBG', text: 'Start debug', group: 'Programming' },
  { cmd: 'STRDFU', text: 'Start DFU (update data)', group: 'Database' },
  { cmd: 'STRPDM', text: 'Start PDM', group: 'Programming' },
  { cmd: 'STRQRY', text: 'Start Query (opens SQL)', group: 'Database' },
  { cmd: 'STRSEU', text: 'Start SEU (edit source)', group: 'Programming' },
  { cmd: 'STRSQL', text: 'Start SQL', group: 'Database' },
  { cmd: 'UPDDTA', text: 'Update data', group: 'Database' },
  { cmd: 'WRKACTJOB', text: 'Work with active jobs', group: 'Jobs' },
  { cmd: 'WRKAUTL', text: 'Work with authorization lists', group: 'Security' },
  { cmd: 'WRKBNDDIR', text: 'Work with binding directories', group: 'Programming' },
  { cmd: 'WRKCMD', text: 'Work with commands', group: 'Objects' },
  { cmd: 'WRKDTAARA', text: 'Work with data areas', group: 'Objects' },
  { cmd: 'WRKDTAQ', text: 'Work with data queues', group: 'Objects' },
  { cmd: 'WRKF', text: 'Work with files', group: 'Objects' },
  { cmd: 'WRKJOB', text: 'Work with job', group: 'Jobs' },
  { cmd: 'WRKJOBQ', text: 'Work with job queues', group: 'Jobs' },
  { cmd: 'WRKJOBSCDE', text: 'Work with job schedule entries', group: 'Jobs' },
  { cmd: 'WRKJRN', text: 'Work with journals', group: 'Database' },
  { cmd: 'WRKLIB', text: 'Work with libraries', group: 'Libraries' },
  { cmd: 'WRKLIBPDM', text: 'Work with libraries using PDM', group: 'Libraries' },
  { cmd: 'WRKLNK', text: 'Work with object links (IFS)', group: 'IFS' },
  { cmd: 'WRKMBRPDM', text: 'Work with members using PDM', group: 'Programming' },
  { cmd: 'WRKMOD', text: 'Work with modules', group: 'Objects' },
  { cmd: 'WRKMSGF', text: 'Work with message files', group: 'Messages' },
  { cmd: 'WRKMSGQ', text: 'Work with message queues', group: 'Messages' },
  { cmd: 'WRKOBJ', text: 'Work with objects', group: 'Objects' },
  { cmd: 'WRKOBJLCK', text: 'Work with object locks', group: 'Objects' },
  { cmd: 'WRKOBJPDM', text: 'Work with objects using PDM', group: 'Objects' },
  { cmd: 'WRKOUTQ', text: 'Work with output queues', group: 'Spool' },
  { cmd: 'WRKPGM', text: 'Work with programs', group: 'Objects' },
  { cmd: 'WRKPTF', text: 'Work with PTFs', group: 'System' },
  { cmd: 'WRKQRY', text: 'Work with queries (opens SQL)', group: 'Database' },
  { cmd: 'WRKSAVF', text: 'Work with save files', group: 'Save / restore' },
  { cmd: 'WRKSBS', text: 'Work with subsystems', group: 'System' },
  { cmd: 'WRKSBSJOB', text: 'Work with subsystem jobs', group: 'Jobs' },
  { cmd: 'WRKSPLF', text: 'Work with spooled files', group: 'Spool' },
  { cmd: 'WRKSRVPGM', text: 'Work with service programs', group: 'Objects' },
  { cmd: 'WRKSYSACT', text: 'Work with system activity', group: 'System' },
  { cmd: 'WRKSYSSTS', text: 'Work with system status', group: 'System' },
  { cmd: 'WRKSYSVAL', text: 'Work with system values', group: 'System' },
  { cmd: 'WRKTCPSTS', text: 'Work with TCP/IP status', group: 'Communications' },
  { cmd: 'WRKUSRPRF', text: 'Work with user profiles', group: 'Security' },
];

const MENU_ALIASES: Record<string, string> = {
  MAJOR: 'MAIN', ASSIST: 'MAIN', RPGDEV: 'RPG', RPGLE: 'RPG', ILE: 'RPG', ILERPG: 'RPG', USERTASK: 'USER', MANAGESYS: 'SYSTEM', RUNSYS: 'SYSTEM', SYSTEM: 'SYSTEM', FILES: 'FILE', LIBRARY: 'FILE', DATA: 'FILE',
  PROGRAM: 'PROGRAMMER', DEVELOP: 'PROGRAMMER', PGMR: 'PROGRAMMER', CMDPGM: 'PROGRAMMER', TCPADM: 'CMN', NETWORK: 'CMN', CMNCFG: 'CMN', SECTOOLS: 'SECURITY', PROBLEM2: 'PROBLEM',
};

/** The menu named on GO (aliases like GO TCPADM or GO MANAGESYS included), or undefined. */
export function goMenu(name: string): Menu | undefined {
  const n = name.trim().toUpperCase().replace(/^\*LIBL\/|^QSYS\//, '');
  const id = MENU_ALIASES[n] ?? n;
  return GO_MENUS.find(m => m.id === id);
}

/** What a menu command needs open in the editor (from the menus), if anything. */
export function needsOf(run: string): Needs | undefined {
  for (const m of GO_MENUS) { const x = m.options.find(opt => opt.run === run && opt.needs); if (x) { return x.needs; } }
  return undefined;
}

/** Why the option cannot run with this editor (languageId of the active editor, if any), or undefined when it can. */
export function editorProblem(needs: Needs | undefined, languageId: string | undefined): string | undefined {
  if (!needs) { return undefined; }
  if (needs === 'rpg') { return languageId === 'rpgle' ? undefined : 'Open an RPG source first (RPGLE, SQLRPGLE…), then pick this again.'; }
  return languageId && ['rpgle', 'cl', 'dds'].includes(languageId) ? undefined : 'Open an IBM i source first (RPG, CL or DDS), then pick this again.';
}

export interface MenuLink { run: string; text: string }
/** The recent list with this one first, without duplicates, at most max long. */
export function pushRecent(list: MenuLink[], link: MenuLink, max = 8): MenuLink[] {
  return [link, ...list.filter(l => l.run !== link.run)].slice(0, max);
}

export type MenuChoice = { kind: 'option'; option: MenuOption } | { kind: 'menu'; id?: string } | { kind: 'command'; text: string };

/** What the "Selection or command" line asks for: an option number, GO <menu>, or any command. */
export function menuSelection(menu: Menu, input: string): MenuChoice | undefined {
  const v = input.trim();
  if (!v) { return undefined; }
  if (/^\d{1,3}$/.test(v)) { const opt = menu.options.find(x => x.n === Number(v)); return opt ? { kind: 'option', option: opt } : undefined; }
  const go = /^GO(?:\s+(?:MENU\()?\s*([A-Z0-9$#@_/*]+)\s*\)?)?\s*$/i.exec(v);
  if (go) { const m = go[1] ? goMenu(go[1]) : undefined; return go[1] && !m ? undefined : { kind: 'menu', id: m?.id }; }
  return { kind: 'command', text: v };
}

/** Display commands that can print their output: run with OUTPUT(*PRINT) and the output is shown. */
const PRINTABLE = new Set(['DSPLIB', 'DSPLIBL', 'DSPOBJD', 'DSPFD', 'DSPFFD', 'DSPPGMREF', 'DSPUSRPRF', 'DSPSYSVAL', 'DSPJOB', 'DSPJOBLOG', 'DSPMSGD', 'DSPAUTUSR',
  'DSPOBJAUT', 'DSPDTAARA', 'DSPPTF', 'DSPSRVPGM', 'DSPPGM', 'DSPMOD', 'DSPNETA', 'DSPSYSSTS', 'WRKACTJOB', 'WRKSYSSTS', 'WRKSPLF', 'WRKOBJLCK', 'WRKDSKSTS',
  'DSPSBSD', 'DSPJOBD', 'DSPCMD', 'DSPDBR', 'DSPOBJLCK', 'DSPRCDLCK', 'DSPLIBD', 'DSPAUTL', 'DSPHDWRSC', 'DSPSFWRSC', 'DSPLICKEY', 'WRKUSRJOB', 'WRKSBMJOB', 'DSPBNDDIR']);

/** The command with OUTPUT(*PRINT) when it is a display command that can print and no output was asked for. */
export function withPrintOutput(text: string): { text: string; added: boolean } {
  const p = parseClCommand(text);
  const cmd = p.command.replace(/^QSYS\//, '');
  if (!PRINTABLE.has(cmd) || p.params.OUTPUT !== undefined) { return { text, added: false }; }
  return { text: `${text.trim()} OUTPUT(*PRINT)`, added: true };
}

/** Commands that only work on a 5250 display: they need a real session. */
export function needsDisplay(text: string): boolean {
  const cmd = parseClCommand(text).command.replace(/^QSYS\//, '');
  return /^(STRSDA|STRRLU|STRDFU|UPDDTA|STRSEU|EDTF|STRPDM|SIGNOFF|STRDBG|GO|STRQRY|WRKQRY|STRSST|STRASSIST|DSPKBDMAP)$/.test(cmd);
}

// ================================================================ messages of a command

export interface CmdMessage { id: string; type: string; severity: number; text: string; help?: string }
/** Keep what a 5250 command line shows: completion, diagnostic, escape and informational messages, not SQL noise. */
export function commandMessages(rows: CmdMessage[]): CmdMessage[] {
  return rows.filter(m => !/^SQL/.test(m.id) && !/^(REQUEST|REPLY)$/i.test(m.type) && !/^CPC2206$/.test(m.id) && (m.text ?? '').trim());
}
export function worstSeverity(rows: CmdMessage[]): number { return rows.reduce((a, m) => Math.max(a, m.severity || 0), 0); }
