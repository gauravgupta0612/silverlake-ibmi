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

test('2.6.1: more green-screen commands open the matching screen', () => {
  const e = (c, u) => { const r = g.interactiveEquivalent(c, u); return r && [r.command, r.args]; };
  assert.deepStrictEqual(e('DSPPFM FILE(APP/CUSTMAST)'), ['vanthrex.objectQuery', [{ library: 'APP', name: 'CUSTMAST' }]]);
  assert.deepStrictEqual(e('DSPPFM CUSTMAST'), ['vanthrex.editData', []]);
  assert.deepStrictEqual(e('UPDDTA APP/CUSTMAST'), ['vanthrex.editData', [{ library: 'APP', name: 'CUSTMAST' }]]);
  assert.deepStrictEqual(e('wrkdtaq dtaq(app/orders)'), ['vanthrex.dataQueue', [{ library: 'APP', name: 'ORDERS', type: '*DTAQ' }]]);
  assert.deepStrictEqual(e('WRKMSGF MSGF(APP/APPMSGF)'), ['vanthrex.messageFile', [{ library: 'APP', name: 'APPMSGF', type: '*MSGF' }]]);
  assert.deepStrictEqual(e('STRDBG PGM(APP/ORD01)'), ['vanthrex.debugProgram', [{ library: 'APP', name: 'ORD01', type: '*PGM' }]]);
  assert.deepStrictEqual(e('STRDBG ORD01'), ['vanthrex.debugProgram', []]);
  assert.deepStrictEqual(e('WRKJRN JRN(APP/QSQJRN)'), ['vanthrex.journals', ['APP']]);
  assert.deepStrictEqual(e('WRKLIB APP*'), ['vanthrex.pdm', ['WRKLIBPDM LIB(APP*)']]);
  assert.deepStrictEqual(e('WRKPGM PGM(APP/ORD*)'), ['vanthrex.pdm', ['WRKOBJPDM LIB(APP) OBJ(ORD*) OBJTYPE(*PGM)']]);
  assert.deepStrictEqual(e('WRKF CUST*'), ['vanthrex.searchObjects', []]);
  assert.deepStrictEqual(e('WRKLNK'), ['vanthrex.ifs.focus', []]);
  assert.deepStrictEqual(e('SIGNOFF'), ['vanthrex.disconnect', []]);
  assert.deepStrictEqual(e('GO PROGRAMMER'), ['vanthrex.goMenu', ['PROGRAMMER']]);
  assert.deepStrictEqual(e('GO MENU(TCPADM)'), ['vanthrex.goMenu', ['CMN']]);
  assert.strictEqual(e('GO MYOWNMNU'), undefined, 'a menu we do not have still needs a 5250 session');
  assert.strictEqual(g.needsDisplay('GO MYOWNMNU'), true);
});

test('2.6.1: GO menus and the selection line', () => {
  for (const m of g.GO_MENUS) {
    const ns = m.options.map(x => x.n);
    assert.strictEqual(new Set(ns).size, ns.length, `${m.id}: option numbers are unique`);
    for (const x of m.options) {
      const goes = /^GO\s+(\S+)/.exec(x.run);
      if (goes) { assert.ok(g.goMenu(goes[1]), `${m.id} option ${x.n} goes to a menu that exists`); }
      // Every 5250 command on a menu opens a screen, or is one the command line can run or prompt.
      if (!x.run.startsWith('vanthrex.') && !goes && x.run !== 'GO') { assert.ok(!g.needsDisplay(x.run) || g.interactiveEquivalent(x.run), `${m.id} option ${x.n}: ${x.run}`); }
    }
  }
  const main = g.goMenu('main');
  assert.strictEqual(main.id, 'MAIN');
  assert.strictEqual(g.goMenu('MANAGESYS').id, 'SYSTEM');
  assert.deepStrictEqual(g.menuSelection(main, '5'), { kind: 'option', option: main.options.find(x => x.n === 5) });
  assert.strictEqual(g.menuSelection(main, '55'), undefined);
  assert.deepStrictEqual(g.menuSelection(main, 'go security'), { kind: 'menu', id: 'SECURITY' });
  assert.deepStrictEqual(g.menuSelection(main, 'GO'), { kind: 'menu', id: undefined });
  assert.strictEqual(g.menuSelection(main, 'GO NOPE'), undefined);
  assert.deepStrictEqual(g.menuSelection(main, 'wrkactjob sbs(qbatch)'), { kind: 'command', text: 'wrkactjob sbs(qbatch)' });
});

test('2.6.1: the 5250 command list in the side bar', () => {
  const cmds = g.GREEN_SCREEN_COMMANDS.map(c => c.cmd);
  assert.strictEqual(new Set(cmds).size, cmds.length, 'no command twice');
  assert.deepStrictEqual([...cmds].sort(), cmds, 'A to Z');
  // With no parameters each one opens a screen, or is typed on the command line ready for F4.
  for (const c of cmds) { assert.ok(g.interactiveEquivalent(c, 'BOB') || !g.needsDisplay(c) || c === 'STRSEU', c); }
  for (const m of g.GO_MENUS) { assert.ok(g.MENU_ICONS[m.id], `${m.id} has an icon`); }
});
