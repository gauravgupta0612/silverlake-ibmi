const test = require('node:test');
const assert = require('node:assert');
const g = require('../out/core/greenScreen');

const opts = (o = {}) => ({ client: 'auto', host: 'pub400.com', platform: 'win32', home: 'C:\\Users\\me', exists: () => false, onPath: () => false, ...o });

test('5250 session: ACS found, jar, mac app, tn5250, custom command', () => {
  const exe = 'C:\\Users\\me\\IBM\\ClientSolutions\\Start_Programs\\Windows_x86-64\\acslaunch_win-64.exe';
  assert.deepStrictEqual(g.launchPlan(opts({ exists: p => p === exe })), { kind: 'spawn', command: exe, args: ['/plugin=5250', '/system=pub400.com'], label: 'IBM i Access Client Solutions' });
  assert.deepStrictEqual(g.launchPlan(opts({ client: 'acs', acsPath: '/x/acsbundle.jar', exists: () => true })).args, ['-jar', '/x/acsbundle.jar', '/plugin=5250', '/system=pub400.com']);
  assert.strictEqual(g.launchPlan(opts({ platform: 'darwin', home: '/Users/me', exists: p => p.endsWith('.app') })).command, 'open');
  assert.deepStrictEqual(g.launchPlan(opts({ platform: 'linux', home: '/home/me', onPath: () => true, ssl: true, device: 'dev01', user: 'bob' })),
    { kind: 'terminal', command: 'tn5250', args: ['ssl:pub400.com', 'env.DEVNAME=DEV01', 'env.USER=BOB'], label: 'tn5250' });
  assert.match(g.launchPlan(opts()).error, /No 5250 emulator/);
  assert.match(g.launchPlan(opts({ client: 'acs' })).error, /not found/);
  const c = g.launchPlan(opts({ client: 'command', command: '"C:\\Program Files\\pcsws.exe" /h=${host} /u=${user}', user: 'ME' }));
  assert.deepStrictEqual([c.command, c.args], ['C:\\Program Files\\pcsws.exe', ['/h=pub400.com', '/u=ME']]);
  assert.match(g.launchPlan(opts({ host: 'x; rm -rf /' })).error, /not a valid host/);
  assert.match(g.launchPlan(opts({ device: 'TOO-LONG-NAME!' })).error, /device/);
});

test('interactive commands open the matching screen', () => {
  const e = (c, u) => { const r = g.interactiveEquivalent(c, u); return r && [r.command, r.args]; };
  assert.deepStrictEqual(e('WRKACTJOB SBS(QBATCH)'), ['vanthrex.wrkactjob', [{ subsystem: 'QBATCH', job: undefined }]]);
  assert.deepStrictEqual(e('wrkobjlck obj(app/custf) objtype(*file)'), ['vanthrex.objectLocks', [{ library: 'APP', name: 'CUSTF', type: '*FILE' }]]);
  assert.deepStrictEqual(e('DSPJOBLOG JOB(123456/QUSER/QZDASOINIT)'), ['vanthrex.jobLog', [{ job: '123456/QUSER/QZDASOINIT' }]]);
  assert.deepStrictEqual(e('DSPMSG', 'bob'), ['vanthrex.messageQueue', ['QUSRSYS/BOB']]);
  assert.deepStrictEqual(e('WRKMSGQ QSYSOPR'), ['vanthrex.messageQueue', ['QSYS/QSYSOPR']]);
  assert.deepStrictEqual(e('WRKOUTQ QGPL/PRT01'), ['vanthrex.wrkOutputQueue', ['QGPL', 'PRT01']]);
  assert.deepStrictEqual(e('WRKOUTQ'), ['vanthrex.wrkOutputQueues', []]);
  assert.deepStrictEqual(e('STRSEU SRCFILE(APP/QRPGLESRC) SRCMBR(ORD01)'), ['vanthrex.openMemberSource', ['APP', 'QRPGLESRC', 'ORD01']]);
  assert.deepStrictEqual(e('DSPOBJD OBJ(ORDPGM) OBJTYPE(*PGM)'), ['vanthrex.objectInfo', [{ library: '*LIBL', name: 'ORDPGM', type: '*PGM' }]]);
  assert.strictEqual(e('WRKACTJOB OUTPUT(*PRINT)'), undefined);
  assert.strictEqual(e('CRTLIB X'), undefined);
});

test('display commands print, display-only commands are recognised', () => {
  assert.deepStrictEqual(g.withPrintOutput('DSPLIBL'), { text: 'DSPLIBL OUTPUT(*PRINT)', added: true });
  assert.deepStrictEqual(g.withPrintOutput('DSPFFD FILE(APP/CUST) OUTPUT(*OUTFILE) OUTFILE(QTEMP/X)'), { text: 'DSPFFD FILE(APP/CUST) OUTPUT(*OUTFILE) OUTFILE(QTEMP/X)', added: false });
  assert.strictEqual(g.withPrintOutput('CRTLIB X').added, false);
  assert.ok(g.needsDisplay('STRSDA')); assert.ok(!g.needsDisplay('DSPLIBL'));
  const m = g.commandMessages([{ id: 'SQL7985', type: 'COMPLETION', severity: 0, text: 'x' }, { id: 'CPF2110', type: 'ESCAPE', severity: 40, text: 'Library X not found.' }, { id: '', type: 'REQUEST', severity: 0, text: 'CRTLIB' }]);
  assert.deepStrictEqual(m.map(x => x.id), ['CPF2110']);
  assert.strictEqual(g.worstSeverity(m), 40);
});
