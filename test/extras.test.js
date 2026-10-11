const test = require('node:test');
const assert = require('node:assert');
const x = require('../out/core/extras');

test('storage advisor helpers', () => {
  assert.strictEqual(x.formatBytes(0), '0 B');
  assert.strictEqual(x.formatBytes(1536), '1.5 KB');
  assert.strictEqual(x.formatBytes(5 * 1024 ** 3), '5.0 GB');
  const r = x.reorgCandidates([{ n: 'A', rows: 100, deleted: 50000 }, { n: 'B', rows: 1e7, deleted: 20000 }, { n: 'C', rows: 10, deleted: 100 }]);
  assert.deepStrictEqual(r.map(t => t.n), ['A']);
  assert.strictEqual(x.reorgCommand('app', 'ordhist'), 'RGZPFM FILE(APP/ORDHIST) REUSEDLT(*NO)');
  assert.strictEqual(x.deleteCommand('APP', 'OLDPGM', '*PGM'), 'DLTPGM PGM(APP/OLDPGM)');
  assert.strictEqual(x.deleteCommand('APP', 'X', '*SQLPKG'), 'DLTOBJ OBJ(APP/X) OBJTYPE(*SQLPKG)');
  const adv = x.receiverAdvice([
    { library: 'J', name: 'R1', status: 'SAVED', detached: '2026-01-01 10:00:00', size: 10 },
    { library: 'J', name: 'R2', status: 'ONLINE', detached: '2026-01-01 10:00:00', size: 20 },
    { library: 'J', name: 'R3', status: 'ATTACHED', size: 99 },
    { library: 'J', name: 'R4', status: 'SAVED', detached: '2026-10-01 10:00:00', size: 5 },
  ], new Date('2026-10-11T00:00:00'), 30);
  assert.deepStrictEqual(adv.map(a => [a.name, a.advice]), [['R2', 'save first'], ['R1', 'delete']]);
});

test('live alert helpers', () => {
  assert.strictEqual(x.endCode('Job 123456/BOB/NIGHT completed on 10/11/26 at 02:00:00 after 3 minutes; end code 20 .'), 20);
  assert.ok(x.isAbnormalEnd('…; end code 30 .') && !x.isAbnormalEnd('…; end code 0 .') && !x.isAbnormalEnd('no code'));
  const m = new x.AlertMemory();
  const a = { kind: 'msgw', key: 'k1', title: 't', detail: '', time: '' };
  assert.strictEqual(m.fresh([a]).length, 1);
  assert.strictEqual(m.fresh([a]).length, 0);
  m.forget('k1');
  assert.strictEqual(m.fresh([a]).length, 1);
  assert.strictEqual(x.replyCommand('0000abcd', 'QSYS', 'QSYSOPR', "C"), "SNDRPY MSGKEY(X'0000ABCD') MSGQ(QSYS/QSYSOPR) RPY('C') RMV(*NO)");
  assert.throws(() => x.replyCommand('zz', 'QSYS', 'QSYSOPR', 'C'), /key/);
  assert.deepStrictEqual(x.validReplies('Error message CPF4131 appeared during OPEN (C G).'), ['C', 'G']);
  assert.deepStrictEqual(x.validReplies('No choices here.'), []);
});

test('message file and field finder helpers', () => {
  assert.strictEqual(x.addMessageCommand('app', 'appmsgf', { id: 'app0001', text: "Customer &1 not found", help: "Check the number.", severity: 30 }),
    "ADDMSGD MSGID(APP0001) MSGF(APP/APPMSGF) MSG('Customer &1 not found') SECLVL('Check the number.') SEV(30)");
  assert.match(x.changeMessageCommand('APP', 'M', { id: 'APP0002', text: "It's", severity: 0 }), /^CHGMSGD MSGID\(APP0002\) .*MSG\('It''s'\) SEV\(0\) SECLVL\(\*NONE\)$/);
  assert.throws(() => x.addMessageCommand('APP', 'M', { id: 'APP001', text: 'x' }), /4 hexadecimal/);
  assert.throws(() => x.addMessageCommand('APP', 'M', { id: 'APP0001', text: 'x', severity: 120 }), /0 to 99/);
  assert.strictEqual(x.removeMessageCommand('APP', 'M', 'APP0001'), 'RMVMSGD MSGID(APP0001) MSGF(APP/M)');
  assert.strictEqual(x.nextMessageId(['APP0009', 'APP000F', 'XYZ0100'], 'APP'), 'APP0010');
  assert.strictEqual(x.nextMessageId([], 'ORD'), 'ORD0001');
  assert.strictEqual(x.likePattern('custno'), '%CUSTNO%');
  assert.strictEqual(x.likePattern('CUST*'), 'CUST%');
  assert.strictEqual(x.likePattern("o'x"), "%O''X%");
});

test('object promotion plan', () => {
  assert.strictEqual(x.promoteStatus({ name: 'A', type: '*PGM', existsInTarget: false }), 'new');
  assert.strictEqual(x.promoteStatus({ name: 'A', type: '*PGM', existsInTarget: true, sourceChanged: '2026-10-02', targetChanged: '2026-10-01' }), 'newer in source');
  assert.strictEqual(x.promoteStatus({ name: 'A', type: '*PGM', existsInTarget: true, sourceChanged: '2026-09-02', targetChanged: '2026-10-01' }), 'NEWER IN TARGET');
  assert.ok(x.carriesData({ name: 'F', type: '*FILE', attribute: 'PF', existsInTarget: true }));
  assert.ok(!x.carriesData({ name: 'L', type: '*FILE', attribute: 'LF', existsInTarget: true }));
  assert.strictEqual(x.stampedName('VB', new Date(2026, 9, 11, 7, 5)), 'VB10110705');
  const plan = { source: 'DEV', target: 'PROD', backupLibrary: 'QGPL', when: new Date(2026, 9, 11, 7, 5).toISOString(), objects: [{ name: 'ORDENT', type: '*PGM' }, { name: 'PRICING', type: '*SRVPGM' }] };
  const c = x.promotionCommands(plan, [{ name: 'ORDENT', type: '*PGM' }]);
  assert.strictEqual(c.backupSavf, 'QGPL/VB10110705');
  assert.match(c.steps[1], /^SAVOBJ OBJ\(ORDENT\) LIB\(PROD\) DEV\(\*SAVF\) SAVF\(QGPL\/VB10110705\) OBJTYPE\(\*PGM\)$/);
  assert.match(c.steps[3], /^SAVOBJ OBJ\(ORDENT PRICING\) LIB\(DEV\).*OBJTYPE\(\*PGM \*SRVPGM\)$/);
  assert.match(c.steps[4], /^RSTOBJ OBJ\(ORDENT PRICING\) SAVLIB\(DEV\).*RSTLIB\(PROD\)$/);
  assert.strictEqual(c.steps[5], 'DLTF FILE(QGPL/VP10110705)');
  assert.strictEqual(x.promotionCommands(plan, []).steps.length, 4);
  assert.throws(() => x.promotionCommands({ ...plan, target: 'DEV' }, []), /same/);
  assert.strictEqual(x.undoPromotionCommand('PROD', 'QGPL/VB10110705'), 'RSTOBJ OBJ(*ALL) SAVLIB(PROD) DEV(*SAVF) SAVF(QGPL/VB10110705) MBROPT(*ALL) ALWOBJDIF(*COMPATIBLE)');
});
