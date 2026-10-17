// Templates for new source members. Pure functions (no vscode import), unit tested.

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
