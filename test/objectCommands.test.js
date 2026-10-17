const test = require('node:test');
const assert = require('node:assert');
const v = {
  ...require('../out/core/objectCommands'),
  ...require('../out/core/testData'),
};

test('SQL helpers and commands', () => {
  const cols = [{ name: 'ID', type: 'INTEGER', length: 4, scale: 0, nullable: false }, { name: 'NAME', type: 'CHARACTER', length: 10, scale: 0, nullable: true }];
  assert.strictEqual(v.insertScript('APP', 'T', cols, [{ ID: 1, NAME: "O'Hara    " }, { ID: 2, NAME: null }]).split('\n').slice(1, 3).join('\n'),
    `INSERT INTO APP/T ("ID", "NAME") VALUES (1, 'O''Hara');\nINSERT INTO APP/T ("ID", "NAME") VALUES (2, NULL);`);
  assert.strictEqual(v.duplicatesSql('app', 'cust', ['EMAIL']), 'SELECT "EMAIL", COUNT(*) AS "COPIES" FROM APP/CUST GROUP BY "EMAIL" HAVING COUNT(*) > 1 ORDER BY COUNT(*) DESC FETCH FIRST 500 ROWS ONLY');
  assert.strictEqual(v.crtdupobjCommand('dev', 'cust', '*file', 'test', undefined, true), 'CRTDUPOBJ OBJ(CUST) FROMLIB(DEV) OBJTYPE(*FILE) TOLIB(TEST) DATA(*YES)');
  assert.strictEqual(v.crtdupobjCommand('DEV', 'PGM1', '*PGM', 'DEV', 'PGM1OLD'), 'CRTDUPOBJ OBJ(PGM1) FROMLIB(DEV) OBJTYPE(*PGM) TOLIB(DEV) NEWOBJ(PGM1OLD)');
  assert.strictEqual(v.moveCommand('DEV', 'X', '*PGM', 'OLD'), 'MOVOBJ OBJ(DEV/X) OBJTYPE(*PGM) TOLIB(OLD)');
  assert.strictEqual(v.renameCommand('DEV', 'X', '*PGM', 'Y'), 'RNMOBJ OBJ(DEV/X) OBJTYPE(*PGM) NEWOBJ(Y)');
  assert.strictEqual(v.cpysrcfCommand('DEV', 'QRPGLESRC', 'A', 'TEST', 'QRPGLESRC', false), 'CPYSRCF FROMFILE(DEV/QRPGLESRC) TOFILE(TEST/QRPGLESRC) FROMMBR(A) TOMBR(*FROMMBR) MBROPT(*ADD)');
  assert.throws(() => v.renameCommand('DEV', 'X', '*PGM', '1BAD'), /valid/);
});
