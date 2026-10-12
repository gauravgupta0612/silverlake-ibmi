// Pure helpers for the Security Admin center (users with *SECADM): user profile commands,
// password redaction, inactive-profile rules and authorization lists. No vscode import.

import { isValidSystemName } from './util';

const NAME = (v: string, what: string): string => {
  const u = v.trim().toUpperCase();
  if (!isValidSystemName(u)) { throw new Error(`"${v}" is not a valid ${what} name.`); }
  return u;
};
const q = (s: string) => `'${s.replace(/'/g, "''")}'`;

export const SPECIAL_AUTHORITIES = ['*ALLOBJ', '*AUDIT', '*IOSYSCFG', '*JOBCTL', '*SAVSYS', '*SECADM', '*SERVICE', '*SPLCTL'] as const;
export const USER_CLASSES = ['*USER', '*SYSOPR', '*PGMR', '*SECADM', '*SECOFR'] as const;
export const LIMIT_CAPABILITIES = ['*NO', '*PARTIAL', '*YES'] as const;

/** True when the user (or one of its groups) has *SECADM. */
export function hasSecadm(own: string, groupSpecials: string[] = []): boolean {
  return [own, ...groupSpecials].some(s => /\*SECADM\b/i.test(s));
}

/** Never write a password into a log, a confirmation or an error. */
export function redactPasswords(text: string): string {
  return text.replace(/\b(PASSWORD|PWD|NEWPWD|PWDVAL)\s*\(\s*('(?:[^']|'')*'|[^)\s]*)\s*\)/gi, (_m, k) => `${k}(*****)`);
}

export interface ProfileSpec {
  user: string;
  password?: string;            // undefined / '' = *NONE (no sign-on with a password)
  passwordExpired?: boolean;    // PWDEXP(*YES): change it at first sign-on
  status?: '*ENABLED' | '*DISABLED';
  userClass?: string;
  specialAuthorities?: string[]; // [] = *NONE, undefined = *USRCLS
  groupProfile?: string;         // '' = *NONE
  supplementalGroups?: string[];
  owner?: '*USRPRF' | '*GRPPRF';
  currentLibrary?: string;
  initialProgram?: string;       // LIB/PGM or *NONE
  initialMenu?: string;          // LIB/MENU, MAIN or *SIGNOFF
  limitCapabilities?: string;
  jobDescription?: string;       // LIB/JOBD
  homeDirectory?: string;
  text?: string;
  passwordExpirationInterval?: number; // 0 = *SYSVAL, -1 = *NOMAX
}

function qualified(v: string, what: string): string {
  const t = v.trim().toUpperCase();
  if (t.startsWith('*')) { return t; }
  const [a, b] = t.includes('/') ? t.split('/') : ['*LIBL', t];
  return `${a === '*LIBL' ? '*LIBL' : NAME(a, 'library')}/${NAME(b, what)}`;
}

function validatePassword(p: string): void {
  if (p.length > 128) { throw new Error('A password is at most 128 characters.'); }
  if (/'/.test(p)) { throw new Error('Quotes are not allowed in a password here.'); }
}

function parts(s: ProfileSpec, create: boolean): string[] {
  const out: string[] = [];
  if (s.password !== undefined) {
    if (s.password === '') { out.push('PASSWORD(*NONE)'); } else { validatePassword(s.password); out.push(`PASSWORD(${q(s.password)})`); }
  }
  if (s.passwordExpired !== undefined) { out.push(`PWDEXP(${s.passwordExpired ? '*YES' : '*NO'})`); }
  if (s.status) { out.push(`STATUS(${s.status})`); }
  if (s.userClass) {
    if (!(USER_CLASSES as readonly string[]).includes(s.userClass.toUpperCase())) { throw new Error(`Unknown user class ${s.userClass}.`); }
    out.push(`USRCLS(${s.userClass.toUpperCase()})`);
  }
  if (s.specialAuthorities !== undefined) {
    const bad = s.specialAuthorities.filter(a => !(SPECIAL_AUTHORITIES as readonly string[]).includes(a.toUpperCase()));
    if (bad.length) { throw new Error(`Unknown special authority: ${bad.join(', ')}`); }
    out.push(`SPCAUT(${s.specialAuthorities.length ? s.specialAuthorities.map(a => a.toUpperCase()).join(' ') : '*NONE'})`);
  }
  if (s.groupProfile !== undefined) { out.push(`GRPPRF(${s.groupProfile.trim() ? NAME(s.groupProfile, 'group profile') : '*NONE'})`); }
  if (s.owner && s.groupProfile?.trim()) { out.push(`OWNER(${s.owner})`); }
  if (s.supplementalGroups !== undefined) {
    if (s.supplementalGroups.length > 15) { throw new Error('At most 15 supplemental groups.'); }
    out.push(`SUPGRPPRF(${s.supplementalGroups.length ? s.supplementalGroups.map(g => NAME(g, 'group profile')).join(' ') : '*NONE'})`);
  }
  if (s.currentLibrary !== undefined) { out.push(`CURLIB(${s.currentLibrary.trim() ? (s.currentLibrary.trim().startsWith('*') ? s.currentLibrary.trim().toUpperCase() : NAME(s.currentLibrary, 'library')) : '*CRTDFT'})`); }
  if (s.initialProgram !== undefined) { out.push(`INLPGM(${s.initialProgram.trim() ? qualified(s.initialProgram, 'program') : '*NONE'})`); }
  if (s.initialMenu !== undefined) { out.push(`INLMNU(${s.initialMenu.trim() ? qualified(s.initialMenu, 'menu') : 'MAIN'})`); }
  if (s.limitCapabilities) {
    if (!(LIMIT_CAPABILITIES as readonly string[]).includes(s.limitCapabilities.toUpperCase())) { throw new Error('Limit capabilities is *NO, *PARTIAL or *YES.'); }
    out.push(`LMTCPB(${s.limitCapabilities.toUpperCase()})`);
  }
  if (s.jobDescription?.trim()) { out.push(`JOBD(${qualified(s.jobDescription, 'job description')})`); }
  if (s.homeDirectory !== undefined && (s.homeDirectory.trim() || !create)) { out.push(`HOMEDIR(${s.homeDirectory.trim() ? q(s.homeDirectory.trim()) : '*USRPRF'})`); }
  if (s.passwordExpirationInterval !== undefined) {
    const v = s.passwordExpirationInterval;
    if (v !== -1 && (v < 0 || v > 366)) { throw new Error('Password expiration interval is 1–366 days, 0 for the system value, or no maximum.'); }
    out.push(`PWDEXPITV(${v === 0 ? '*SYSVAL' : v === -1 ? '*NOMAX' : v})`);
  }
  if (s.text !== undefined) { out.push(`TEXT(${q(s.text.slice(0, 50) || ' ')})`); }
  return out;
}

export function createProfileCommand(s: ProfileSpec): string {
  const user = NAME(s.user, 'user profile');
  if (/^Q/.test(user)) { throw new Error('Names starting with Q are reserved for IBM profiles.'); }
  return [`CRTUSRPRF USRPRF(${user})`, ...parts(s, true)].join(' ');
}

export function changeProfileCommand(s: ProfileSpec): string {
  const p = parts(s, false);
  if (!p.length) { throw new Error('Nothing to change.'); }
  return [`CHGUSRPRF USRPRF(${NAME(s.user, 'user profile')})`, ...p].join(' ');
}

export function deleteProfileCommand(user: string, ownedObjects: '*NODLT' | '*DLT' | { newOwner: string }, primaryGroupObjects: '*NOCHG' | { newGroup: string } = '*NOCHG'): string {
  const u = NAME(user, 'user profile');
  const own = typeof ownedObjects === 'string' ? ownedObjects : `*CHGOWN ${NAME(ownedObjects.newOwner, 'user profile')}`;
  const pg = typeof primaryGroupObjects === 'string' ? primaryGroupObjects : `*CHGPGP ${NAME(primaryGroupObjects.newGroup, 'group profile')}`;
  return `DLTUSRPRF USRPRF(${u}) OWNOBJOPT(${own}) PGPOPT(${pg})`;
}

/** A new profile like an existing one (from QSYS2.USER_INFO): everything but the name, password and text. */
export function specFromExisting(row: Record<string, unknown>, newUser: string): ProfileSpec {
  const v = (k: string) => String(row[k] ?? '').trim();
  const spc = v('SPECIAL_AUTHORITIES');
  const groups = v('SUPPLEMENTAL_GROUP_LIST').split(/\s+/).filter(g => g && g !== '*NONE');
  const lib = (l: string, n: string) => (n && !n.startsWith('*') ? `${l || '*LIBL'}/${n}` : n || undefined);
  return {
    user: newUser, userClass: v('USER_CLASS_NAME') || undefined,
    specialAuthorities: !spc || spc === '*NONE' ? [] : spc.split(/\s+/).filter(Boolean),
    groupProfile: v('GROUP_PROFILE_NAME') === '*NONE' ? '' : v('GROUP_PROFILE_NAME'),
    supplementalGroups: groups,
    owner: v('OWNER') === '*GRPPRF' ? '*GRPPRF' : undefined,
    currentLibrary: v('CURRENT_LIBRARY_NAME') && v('CURRENT_LIBRARY_NAME') !== '*CRTDFT' ? v('CURRENT_LIBRARY_NAME') : undefined,
    initialProgram: lib(v('INITIAL_PROGRAM_LIBRARY_NAME'), v('INITIAL_PROGRAM_NAME')),
    initialMenu: lib(v('INITIAL_MENU_LIBRARY_NAME'), v('INITIAL_MENU_NAME')),
    limitCapabilities: v('LIMIT_CAPABILITIES') || undefined,
    jobDescription: lib(v('JOB_DESCRIPTION_LIBRARY_NAME'), v('JOB_DESCRIPTION_NAME')),
  };
}

/** Enabled profiles that have not signed on for `days` (or never, and are older than that). */
export function inactiveProfiles<T extends { user: string; status: string; lastSignon?: string; created?: string }>(rows: T[], now: Date, days: number): (T & { idleDays: number })[] {
  const cut = now.getTime() - days * 86400000;
  const out: (T & { idleDays: number })[] = [];
  for (const r of rows) {
    if (r.status !== '*ENABLED' || /^Q/.test(r.user)) { continue; }
    const last = r.lastSignon ? Date.parse(r.lastSignon.replace(' ', 'T')) : NaN;
    const created = r.created ? Date.parse(r.created.replace(' ', 'T')) : NaN;
    const ref = isNaN(last) ? created : last;
    if (isNaN(ref) || ref > cut) { continue; }
    out.push({ ...r, idleDays: Math.floor((now.getTime() - ref) / 86400000) });
  }
  return out.sort((a, b) => b.idleDays - a.idleDays);
}

// ---------------------------------------------------------------- authorization lists

export function createAutlCommand(name: string, text: string): string {
  return `CRTAUTL AUTL(${NAME(name, 'authorization list')}) TEXT(${q(text.slice(0, 50) || ' ')}) AUT(*EXCLUDE)`;
}
export function addAutlEntryCommand(autl: string, user: string, aut: string): string {
  return `ADDAUTLE AUTL(${NAME(autl, 'authorization list')}) USER(${NAME(user, 'user profile')}) AUT(${aut.toUpperCase()})`;
}
export function changeAutlEntryCommand(autl: string, user: string, aut: string): string {
  return `CHGAUTLE AUTL(${NAME(autl, 'authorization list')}) USER(${user.toUpperCase() === '*PUBLIC' ? '*PUBLIC' : NAME(user, 'user profile')}) AUT(${aut.toUpperCase()})`;
}
export function removeAutlEntryCommand(autl: string, user: string): string {
  return `RMVAUTLE AUTL(${NAME(autl, 'authorization list')}) USER(${NAME(user, 'user profile')})`;
}
