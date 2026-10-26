const test = require('node:test');
const assert = require('node:assert');
const ms = require('../out/core/multiSystem');
const bob = require('../out/core/bobProject');
const doc = require('../out/core/libraryDoc');
const sk = require('../out/core/dspfSkeleton');
const { parseDspf } = require('../out/core/dspf');
const tt = require('../out/core/textTools');
const jh = require('../out/core/jobHistory');

test('results of several systems lined up', () => {
  const m = ms.mergeResults([
    { system: 'DEV', columns: ['NAME', 'VAL'], rows: [{ NAME: 'QCCSID', VAL: 37 }, { NAME: 'QDATFMT', VAL: 'DMY' }] },
    { system: 'PROD', columns: ['NAME', 'VAL'], rows: [{ NAME: 'QCCSID', VAL: 37 }, { NAME: 'QDATFMT', VAL: 'MDY' }] },
    { system: 'TEST', columns: [], rows: [], error: 'down' },
  ]);
  assert.deepStrictEqual(m.systems, ['DEV', 'PROD']); assert.strictEqual(m.differ, 2);
  assert.deepStrictEqual(m.rows.map(r => [r.values.VAL, r.on.join('+')]), [['DMY', 'DEV'], ['MDY', 'PROD'], [37, 'DEV+PROD']]);
});

test('IBM i project files (Bob)', () => {
  assert.strictEqual(bob.targetOf('src/ord01.pgm.rpgle'), 'ORD01.PGM');
  assert.strictEqual(bob.targetOf('src/util.rpgle'), 'UTIL.MODULE');
  assert.strictEqual(bob.targetOf('qddssrc/custf.pf'), 'CUSTF.FILE');
  assert.strictEqual(bob.targetOf('qsrvsrc/util.bnd'), 'UTIL.SRVPGM');
  assert.strictEqual(bob.targetOf('qcpysrc/cust.rpgleinc'), undefined);
  assert.deepStrictEqual(bob.copiesIn("**free\n/copy qcpysrc,custpr\n/include 'qcpysrc/datepr.rpgleinc'\n     /COPY QRPGLESRC,OLDCPY"), ['CUSTPR', 'DATEPR', 'OLDCPY']);
  const files = [{ rel: 'qrpglesrc/ord01.pgm.rpgle', text: '/copy qcpysrc,custpr' }, { rel: 'qcpysrc/custpr.rpgleinc' }, { rel: 'qddssrc/custf.pf' }, { rel: 'README.md' }];
  const t = bob.projectTargets(files);
  assert.deepStrictEqual(t.map(x => [x.dir, x.target, x.deps]), [['qddssrc', 'CUSTF.FILE', []], ['qrpglesrc', 'ORD01.PGM', ['qcpysrc/custpr.rpgleinc']]]);
  assert.match(bob.rulesMk('qrpglesrc', t), /^ORD01\.PGM: ord01\.pgm\.rpgle \.\.\/qcpysrc\/custpr\.rpgleinc$/m);
  assert.deepStrictEqual(bob.includeDirs(files), ['qcpysrc']);
  const ip = JSON.parse(bob.iprojJson({ name: 'app', curlib: 'APPDEV', libl: ['UTIL'] }, ['qcpysrc']));
  assert.deepStrictEqual([ip.curlib, ip.objlib, ip.includePath, ip.preUsrlibl], ['APPDEV', '&CURLIB', ['qcpysrc'], ['UTIL']]);
  assert.strictEqual(JSON.parse(bob.ibmiJson({ name: 'x', tgtCcsid: 37 })).build.tgtCcsid, 37);
});

test('library documentation and CRUD matrix', () => {
  assert.strictEqual(doc.crud(1), 'R'); assert.strictEqual(doc.crud(3), 'CR'); assert.strictEqual(doc.crud(7), 'CRUD'); assert.strictEqual(doc.crud(8), '?'); assert.strictEqual(doc.crud(0), '');
  const refs = [
    { lib: 'APP', pgm: 'ORD01', refLib: 'APP', refName: 'ORDERS', refType: '*FILE', usage: 1 },
    { lib: 'APP', pgm: 'ORD01', refLib: 'APP', refName: 'ORDERS', refType: '*FILE', usage: 4 },
    { lib: 'APP', pgm: 'ORD01', refLib: '*LIBL', refName: 'UTIL', refType: '*SRVPGM' },
    { lib: 'APP', pgm: 'INV01', refLib: 'APP', refName: 'ORDERS', refType: '*FILE', usage: 2 },
  ];
  const m = doc.crudMatrix(refs);
  assert.deepStrictEqual(m.programs, ['APP/INV01', 'APP/ORD01']); assert.deepStrictEqual(m.files, ['APP/ORDERS']);
  assert.strictEqual(m.cells['APP/ORD01']['APP/ORDERS'], 'RUD'); assert.strictEqual(m.cells['APP/INV01']['APP/ORDERS'], 'C');
  assert.strictEqual(doc.crudCsv(m), 'Program,APP/ORDERS\nAPP/INV01,C\nAPP/ORD01,RUD\n');
  const md = doc.libraryMarkdown('APP', 'DEV', [{ name: 'ORD01', type: '*PGM', attribute: 'RPGLE', text: 'Order | entry' }, { name: 'INV01', type: '*PGM', attribute: 'RPGLE', text: '' }, { name: 'ORDERS', type: '*FILE', attribute: 'PF', text: 'Orders' }, { name: 'CFG', type: '*DTAARA', attribute: '', text: 'Config' }],
    [{ file: 'ORDERS', name: 'ORDNO', type: 'DECIMAL', length: 7, scale: 0, text: 'Order number' }], refs, new Date('2026-10-26'));
  assert.match(md, /^# Library APP/); assert.match(md, /Order \\\| entry/); assert.match(md, /- \*\*Files:\*\* ORDERS \(R\), ORDERS \(UD\)/);
  assert.match(md, /\| ORDNO \| DECIMAL\(7\) \| Order number \|/); assert.match(md, /## CRUD matrix/); assert.match(md, /```mermaid\nflowchart LR/); assert.match(md, /ORD01 -->\|R\| ORDERS_FILE/);
  assert.match(md, /\| CFG \| \*DTAARA \| Config \|/);
});

test('RPG skeleton from a display file', () => {
  const src = [
    '     A                                      DSPSIZ(24 80 *DS3)',
    '     A                                      CA03(03 \'Exit\')',
    '     A                                      INDARA',
    '     A          R SFL01                     SFL',
    '     A            OPT            1A  B  6  2',
    '     A            CUSNO          7S 0O  6  6',
    '     A          R CTL01                     SFLCTL(SFL01)',
    '     A                                      SFLPAG(15) SFLSIZ(16)',
    '     A                                      CF05(05 \'Refresh\')',
    '     A  31                                  SFLDSP',
    '     A                                      SFLDSPCTL',
    '     A  30                                  SFLCLR',
    '     A  32                                  SFLEND(*MORE)',
    '     A                                  1  2\'Customers\'',
  ].join('\n');
  assert.deepStrictEqual(sk.functionKeys("CA03(03 'Exit') CF05(05) CF12"), [{ kind: 'CA', key: 'F3', indicator: '03', text: 'Exit' }, { kind: 'CF', key: 'F5', indicator: '05', text: '' }, { kind: 'CF', key: 'F12', indicator: '', text: '' }]);
  const rpg = sk.rpgForDspf('custd', parseDspf(src), src);
  assert.match(rpg, /dcl-f custd workstn sfile\(SFL01: rrn_sfl01\) indds\(ind\);/);
  assert.match(rpg, /in03 ind pos\(3\); \/\/ F3 Exit/);
  assert.match(rpg, /  loadsfl01\(\);\n  exfmt CTL01;/);
  assert.match(rpg, /if ind\.in03; \/\/ F3 Exit\n    done = \*on;/);
  assert.match(rpg, /ind\.in30 = \*on;  \/\/ SFLCLR/); assert.match(rpg, /ind\.in31 = \(rrn_sfl01 > 0\)/); assert.match(rpg, /ind\.in32 = \*on;  \/\/ SFLEND/);
  assert.match(rpg, /readc SFL01;/); assert.match(rpg, /input fields: OPT/);
});

test('report to CSV, bad characters, notes', () => {
  const rep = [
    '  CUSTOMER LIST                        PAGE  1',
    '',
    '  NUMBER   NAME              BALANCE',
    '  -------  ----------------  ----------',
    '  0000123  Smith & Sons        1,234.50',
    '  0000124  Jones             12,000.00-',
    '  0000125  O"Brien Ltd            5.00',
    '                     * * * END OF REPORT * * *',
  ].join('\n');
  const t = tt.reportToTable(rep);
  assert.deepStrictEqual(t.header, ['NUMBER', 'NAME', 'BALANCE']);
  assert.deepStrictEqual(t.rows, [['0000123', 'Smith & Sons', '1,234.50'], ['0000124', 'Jones', '12,000.00-'], ['0000125', 'O"Brien Ltd', '5.00']]);
  assert.strictEqual(tt.toCsvText(t.header, t.rows), 'NUMBER,NAME,BALANCE\n0000123,Smith & Sons,1234.50\n0000124,Jones,-12000.00\n0000125,"O""Brien Ltd",5.00\n');
  assert.strictEqual(tt.toCsvText(['A'], [['1.234,50-']], ';'), 'A\n-1234.50\n');
  const bad = tt.badCharacters('a\tb\nc d ’x\u0000');
  assert.deepStrictEqual(bad.map(b => [b.line, b.column, b.what]), [[0, 1, 'tab'], [1, 1, 'no-break space'], [1, 4, 'curly quote'], [1, 6, 'NUL']]);
  assert.strictEqual(tt.fixCharacters('a\tb\r\nc d ’x\u0000'), "a b\r\nc d 'x ");
  const notes = tt.notesIn(["**FREE", "x = 'TODO not a comment';", "// TODO: check the total", "     C* FIXME old code", "  CHGVAR &A 1 /* HACK speed */", "SELECT 1 -- bug: wrong join"].join('\n'));
  assert.deepStrictEqual(notes.map(n => [n.line, n.tag, n.text]), [[2, 'TODO', 'check the total'], [3, 'FIXME', 'old code'], [4, 'HACK', 'speed'], [5, 'BUG', 'wrong join']]);
});

test('job run history and message search', () => {
  assert.match(jh.jobHistorySql('nightly', 30), /FROM_JOB LIKE '%\/%\/NIGHTLY'/);
  assert.match(jh.jobHistorySql('ord*', 7, 'batch'), /LIKE '%\/BATCH\/ORD%'/);
  assert.throws(() => jh.jobHistorySql("x'", 1), /not a valid job/);
  const runs = jh.jobRuns([
    { ID: 'CPF1124', TS: '2026-10-20 01:00:00', JOB: '100001/BATCH/NIGHTLY', TEXT: 'Job started' },
    { ID: 'CPF1164', TS: '2026-10-20 01:10:00', JOB: '100001/BATCH/NIGHTLY', TEXT: 'Job 100001/BATCH/NIGHTLY completed on 10/20/26 at 01:10:00; 12.5 seconds used; end code 0 .' },
    { ID: 'CPF1124', TS: '2026-10-21 01:00:00', JOB: '100002/BATCH/NIGHTLY', TEXT: 'Job started' },
    { ID: 'CPF1164', TS: '2026-10-21 01:45:00', JOB: '100002/BATCH/NIGHTLY', TEXT: 'Job 100002/BATCH/NIGHTLY ended abnormally on 10/21/26; 1,250.3 seconds used; end code 30 .' },
    { ID: 'CPF1124', TS: '2026-10-22 01:00:00', JOB: '100003/BATCH/NIGHTLY', TEXT: 'Job started' },
    { ID: 'CPF1164', TS: '2026-10-22 01:09:00', JOB: '100003/BATCH/NIGHTLY', TEXT: 'Job ... completed; 11 seconds used; end code 0 .' },
  ]);
  assert.deepStrictEqual(runs.map(r => [r.seconds, r.cpuSeconds, r.endCode, r.ok]), [[600, 12.5, 0, true], [2700, 1250.3, 30, false], [540, 11, 0, true]]);
  const st = jh.runStats(runs);
  assert.deepStrictEqual([st.runs, st.failed, st.avg, st.max, st.last, st.slow.length], [3, 1, 1280, 2700, 540, 1]);
  assert.strictEqual(jh.formatSeconds(3725), '1h 2m');
  assert.match(jh.recentJobsSql({ user: 'bob', jobName: 'ord*', days: 3, max: 50 }), /JOB_USER_FILTER => 'BOB'.*JOB_NAME LIKE '%\/%\/ORD%'.*FETCH FIRST 50/);
  assert.match(jh.messageInJobSql('123456/BOB/ORD', 'cpf4131'), /MESSAGE_ID = 'CPF4131'/);
  assert.match(jh.messageInJobSql('123456/BOB/ORD', 'CPF41*'), /MESSAGE_ID LIKE 'CPF41%'/);
  assert.match(jh.messageInJobSql('123456/BOB/ORD', "level check"), /LIKE '%LEVEL CHECK%'/);
  assert.throws(() => jh.messageInJobSql('bad', 'X'));
});
