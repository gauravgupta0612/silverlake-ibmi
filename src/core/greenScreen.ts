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
  }
  return undefined;
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
