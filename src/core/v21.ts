// Pure helpers for the second 2.1 batch: objects out of sync with their source, change reports,
// member templates, binding directories, exit points and bulk ownership / authority.
// No vscode import, unit tested.

import { isValidSystemName } from './util';

const NAME = (v: string, what: string): string => {
  const u = v.trim().toUpperCase();
  if (!isValidSystemName(u)) { throw new Error(`"${v}" is not a valid ${what} name.`); }
  return u;
};

// ---------------------------------------------------------------- objects out of sync with source

export type SyncStatus = 'source newer' | 'source missing' | 'no source info' | 'in sync';

/** Compare the source date recorded in an object at compile time with the member's current date. */
export function syncStatus(o: { sourceFile?: string; sourceMember?: string; compiledFrom?: string; memberChanged?: string; memberExists: boolean }, toleranceSeconds = 2): SyncStatus {
  if (!o.sourceFile || !o.sourceMember) { return 'no source info'; }
  if (!o.memberExists) { return 'source missing'; }
  if (!o.compiledFrom || !o.memberChanged) { return 'no source info'; }
  const a = Date.parse(o.compiledFrom.replace(' ', 'T')); const b = Date.parse(o.memberChanged.replace(' ', 'T'));
  if (isNaN(a) || isNaN(b)) { return 'no source info'; }
  return b - a > toleranceSeconds * 1000 ? 'source newer' : 'in sync';
}

// ---------------------------------------------------------------- change report

export interface ChangeItem { kind: 'object' | 'member'; name: string; type: string; where: string; changed: string; text?: string }

/** Markdown release notes from what changed in a library. */
export function changeReportMarkdown(library: string, sinceDays: number, items: ChangeItem[], today = new Date()): string {
  const day = today.toISOString().slice(0, 10);
  const out = [`# Changes in ${library} — last ${sinceDays} day(s)`, '', `*Generated ${day} by Vanthrex for IBM i.*`, ''];
  const members = items.filter(i => i.kind === 'member'); const objects = items.filter(i => i.kind === 'object');
  out.push(`## Source members (${members.length})`, '');
  if (members.length) { out.push('| Member | Type | Source file | Changed | Description |', '|---|---|---|---|---|', ...members.map(m => `| ${m.name} | ${m.type} | ${m.where} | ${m.changed} | ${(m.text ?? '').replace(/\|/g, '\\|')} |`)); } else { out.push('None.'); }
  out.push('', `## Objects (${objects.length})`, '');
  if (objects.length) { out.push('| Object | Type | Changed | Description |', '|---|---|---|---|', ...objects.map(o => `| ${o.name} | ${o.type} | ${o.changed} | ${(o.text ?? '').replace(/\|/g, '\\|')} |`)); } else { out.push('None.'); }
  return out.join('\n') + '\n';
}

// ---------------------------------------------------------------- member templates

export interface Template { name: string; type: string; description: string; text: string }

export const TEMPLATES: Template[] = [
  { name: 'RPG program (free form)', type: 'RPGLE', description: 'Main procedure with parameters, error handling and *INLR-free ending', text: `**FREE
// &NAME — &TEXT
// Created &DATE by &USER
ctl-opt main(main) dftactgrp(*no) actgrp(*caller) option(*srcstmt: *nodebugio);

dcl-proc main;
  dcl-pi *n;
    // parm1 char(10) const;
  end-pi;

  monitor;
    // Your code here
  on-error;
    // Handle the error: log it, set a return code…
  endmon;
end-proc;
` },
  { name: 'RPG service program module (NOMAIN)', type: 'RPGLE', description: 'Exported procedure; put its prototype in a copybook', text: `**FREE
// &NAME — &TEXT
// Created &DATE by &USER
ctl-opt nomain option(*srcstmt: *nodebugio);

// /copy QPROTOSRC,&NAME_P

dcl-proc doSomething export;
  dcl-pi *n varchar(100);
    input varchar(100) const;
  end-pi;

  return %trim(input);
end-proc;
` },
  { name: 'SQLRPGLE with a cursor', type: 'SQLRPGLE', description: 'Reads rows with embedded SQL and checks SQLSTATE', text: `**FREE
// &NAME — &TEXT
// Created &DATE by &USER
ctl-opt main(main) dftactgrp(*no) actgrp(*caller) option(*srcstmt: *nodebugio);

exec sql set option commit = *none, naming = *sys, closqlcsr = *endmod;

dcl-proc main;
  dcl-s id int(10);
  dcl-s name varchar(50);

  exec sql declare c1 cursor for
           select id, name from mylib/mytable order by id;
  exec sql open c1;
  dow *on;
    exec sql fetch next from c1 into :id, :name;
    if sqlstate <> '00000';
      leave;
    endif;
    // Use id and name
  enddo;
  exec sql close c1;
end-proc;
` },
  { name: 'CL program with error handling', type: 'CLLE', description: 'Global MONMSG that forwards the error to the caller', text: `/* &NAME — &TEXT                                              */
/* Created &DATE by &USER                                       */
PGM        PARM(&PARM1)
  DCL        VAR(&PARM1) TYPE(*CHAR) LEN(10)
  DCL        VAR(&MSGID) TYPE(*CHAR) LEN(7)
  DCL        VAR(&MSGDTA) TYPE(*CHAR) LEN(256)
  DCL        VAR(&MSGF) TYPE(*CHAR) LEN(10)
  DCL        VAR(&MSGFLIB) TYPE(*CHAR) LEN(10)
  MONMSG     MSGID(CPF0000) EXEC(GOTO CMDLBL(ERROR))

  /* Your commands here */

  RETURN

ERROR:
  RCVMSG     MSGTYPE(*EXCP) MSGDTA(&MSGDTA) MSGID(&MSGID) +
               MSGF(&MSGF) MSGFLIB(&MSGFLIB)
  MONMSG     MSGID(CPF0000)
  SNDPGMMSG  MSGID(&MSGID) MSGF(&MSGFLIB/&MSGF) MSGDTA(&MSGDTA) +
               MSGTYPE(*ESCAPE)
  MONMSG     MSGID(CPF0000)
ENDPGM
` },
  { name: 'Binder source', type: 'BND', description: 'Export list with a named signature', text: `/* &NAME — &TEXT */
/* Add new exports at the END of the list to keep the signature compatible. */
STRPGMEXP  PGMLVL(*CURRENT) SIGNATURE('&NAME V1')
  EXPORT     SYMBOL('doSomething')
ENDPGMEXP
` },
  { name: 'SQL table', type: 'SQL', description: 'CREATE OR REPLACE TABLE with a key, audit columns and labels', text: `-- &NAME — &TEXT
-- Created &DATE by &USER
CREATE OR REPLACE TABLE MYLIB/&NAME FOR SYSTEM NAME &NAME (
  ID            INTEGER GENERATED ALWAYS AS IDENTITY,
  CODE          CHAR(10)      NOT NULL,
  DESCRIPTION   VARCHAR(100)  NOT NULL DEFAULT '',
  CREATED_AT    TIMESTAMP     NOT NULL DEFAULT CURRENT TIMESTAMP,
  CHANGED_AT    TIMESTAMP     NOT NULL FOR EACH ROW ON UPDATE AS ROW CHANGE TIMESTAMP,
  PRIMARY KEY (ID),
  UNIQUE (CODE)
) RCDFMT &NAME.R;

LABEL ON TABLE MYLIB/&NAME IS '&TEXT';
LABEL ON COLUMN MYLIB/&NAME (CODE TEXT IS 'Code', DESCRIPTION TEXT IS 'Description');
` },
  { name: 'Display file (DSPF)', type: 'DSPF', description: 'One screen with a title, an input field and F3=Exit', text: `     A* &NAME — &TEXT
     A                                      DSPSIZ(24 80 *DS3)
     A                                      CA03(03 'Exit')
     A          R SCREEN1
     A                                  1 30'&TEXT'
     A                                      COLOR(WHT)
     A                                  4  2'Value . . . :'
     A            VALUE         10A  B  4 17
     A                                 23  2'F3=Exit'
     A                                      COLOR(BLU)
` },
  { name: 'Physical file (DDS)', type: 'PF', description: 'Keyed physical file', text: `     A* &NAME — &TEXT
     A                                      UNIQUE
     A          R &NAME.R
     A            CODE          10A         TEXT('Code')
     A            DESC          50A         TEXT('Description')
     A            AMOUNT         9P 2       TEXT('Amount')
     A          K CODE
` },
];

/** Fill &NAME, &TEXT, &DATE and &USER in a template. */
export function renderTemplate(t: string, v: { name: string; text: string; user: string; date?: Date }): string {
  const d = (v.date ?? new Date()).toISOString().slice(0, 10);
  return t.replace(/&NAME/g, v.name.toUpperCase()).replace(/&TEXT/g, v.text.replace(/'/g, "''")).replace(/&DATE/g, d).replace(/&USER/g, v.user.toUpperCase());
}

// ---------------------------------------------------------------- binding directories

export function addBnddirEntryCommand(bnddir: string, objLib: string, obj: string, type: '*SRVPGM' | '*MODULE'): string {
  const [l, b] = bnddir.includes('/') ? bnddir.split('/') : ['*LIBL', bnddir];
  return `ADDBNDDIRE BNDDIR(${l === '*LIBL' ? '*LIBL' : NAME(l, 'library')}/${NAME(b, 'binding directory')}) OBJ((${objLib.toUpperCase() === '*LIBL' ? '*LIBL' : NAME(objLib, 'library')}/${NAME(obj, 'object')} ${type}))`;
}
export function removeBnddirEntryCommand(bnddir: string, objLib: string, obj: string, type: string): string {
  const [l, b] = bnddir.includes('/') ? bnddir.split('/') : ['*LIBL', bnddir];
  return `RMVBNDDIRE BNDDIR(${l === '*LIBL' ? '*LIBL' : NAME(l, 'library')}/${NAME(b, 'binding directory')}) OBJ((${objLib.toUpperCase() === '*LIBL' ? '*LIBL' : NAME(objLib, 'library')}/${NAME(obj, 'object')} ${type.toUpperCase()}))`;
}
export function rtvbndsrcCommand(srvLib: string, srv: string, srcLib: string, srcFile: string, member: string): string {
  return `RTVBNDSRC SRVPGM(${NAME(srvLib, 'library')}/${NAME(srv, 'service program')}) SRCFILE(${NAME(srcLib, 'library')}/${NAME(srcFile, 'source file')}) SRCMBR(${NAME(member, 'member')}) MBROPT(*REPLACE)`;
}

// ---------------------------------------------------------------- exit points

/** Network exit points worth protecting with an exit program (database, file, FTP, remote command…). */
export const NETWORK_EXIT_POINTS: Record<string, string> = {
  QIBM_QZDA_INIT: 'Database server — connect (ODBC / JDBC)', QIBM_QZDA_SQL1: 'Database server — SQL requests', QIBM_QZDA_SQL2: 'Database server — SQL requests',
  QIBM_QZDA_NDB1: 'Database server — native database', QIBM_QZDA_ROI1: 'Database server — catalog', QIBM_QPWFS_FILE_SERV: 'File server (IFS over NetServer / ACS)',
  QIBM_QTF_TRANSFER: 'FTP — file transfer', QIBM_QTF_SERVER_LOGON: 'FTP — sign-on', QIBM_QTMF_SERVER_REQ: 'FTP — server requests',
  QIBM_QZRC_RMT: 'Remote command / program call', QIBM_QZSO_SIGNONSRV: 'Sign-on server', QIBM_QTG_DEVINIT: 'Telnet — device initialization',
  QIBM_QRQ_SQL: 'DRDA / DDM — SQL', QIBM_QTMX_SERVER_REQ: 'REXEC server requests', QIBM_QZHQ_DATA_QUEUE: 'Data queue server', QIBM_QNPS_ENTRY: 'Network print server',
};

/** Which network exit points have no exit program registered. */
export function unprotectedExitPoints(registered: { point: string }[]): { point: string; what: string }[] {
  const have = new Set(registered.map(r => r.point.toUpperCase()));
  return Object.entries(NETWORK_EXIT_POINTS).filter(([p]) => !have.has(p)).map(([point, what]) => ({ point, what }));
}

// ---------------------------------------------------------------- ownership & authority in bulk

export function chgobjownCommand(lib: string, obj: string, type: string, newOwner: string, revokeOld: boolean): string {
  return `CHGOBJOWN OBJ(${NAME(lib, 'library')}/${NAME(obj, 'object')}) OBJTYPE(${type.toUpperCase()}) NEWOWN(${NAME(newOwner, 'user profile')}) CUROWNAUT(${revokeOld ? '*REVOKE' : '*SAME'})`;
}

/** GRTOBJAUT / RVKOBJAUT accept generic names and *ALL, so one command covers many objects. */
export function bulkAuthorityCommand(grant: boolean, lib: string, pattern: string, type: string, user: string, aut: string): string {
  const p = pattern.trim().toUpperCase();
  if (!/^(\*ALL|[A-Z$#@][A-Z0-9$#@_.]{0,9}\*?)$/.test(p)) { throw new Error('Use a name, a generic name like ORD* or *ALL.'); }
  const u = user.trim().toUpperCase() === '*PUBLIC' ? '*PUBLIC' : NAME(user, 'user profile');
  return `${grant ? 'GRTOBJAUT' : 'RVKOBJAUT'} OBJ(${NAME(lib, 'library')}/${p}) OBJTYPE(${type.toUpperCase()}) USER(${u}) AUT(${aut.toUpperCase()})`;
}

/** Generic name test like the IBM i one: "ORD*" matches ORDENT, "*ALL" matches everything. */
export function matchesGeneric(name: string, pattern: string): boolean {
  const p = pattern.trim().toUpperCase();
  if (p === '*ALL') { return true; }
  return p.endsWith('*') ? name.toUpperCase().startsWith(p.slice(0, -1)) : name.toUpperCase() === p;
}
