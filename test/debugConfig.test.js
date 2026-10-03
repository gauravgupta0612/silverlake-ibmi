const test = require('node:test');
const assert = require('node:assert');
const d = require('../out/core/debugConfig');

test('parses the Debug Service env file', () => {
  const env = d.parseEnvFile('# comment\nDBGSRV_SECURED_PORT=8015\nexport DBGSRV_WRK_DIR="/QIBM/UserData/MyDbg"\n\nBAD LINE\n');
  assert.strictEqual(env.get('DBGSRV_SECURED_PORT'), '8015');
  assert.strictEqual(env.get('DBGSRV_WRK_DIR'), '/QIBM/UserData/MyDbg');
  const info = d.debugServiceInfo(env);
  assert.strictEqual(info.port, 8015);
  assert.strictEqual(info.serviceCertificate, '/QIBM/UserData/MyDbg/certs/debug_service.pfx');
  assert.strictEqual(info.clientCertificate, '/QIBM/UserData/MyDbg/certs/debug_service.crt');
});

test('defaults when the env file has no values', () => {
  const info = d.debugServiceInfo(new Map());
  assert.strictEqual(info.port, 8005);
  assert.strictEqual(info.sepPort, 8008);
  assert.strictEqual(info.root, '/QIBM/ProdData/IBMiDebugService');
  assert.strictEqual(info.clientCertificate, '/QIBM/UserData/IBMiDebugService/certs/debug_service.crt');
});

test('builds the IBM i Debug batch launch configuration', () => {
  const c = d.batchLaunchConfig({
    host: 'dev400', user: 'me', password: 'x', port: 8005, library: 'mylib', program: 'ordentry',
    callCommand: d.defaultCallCommand('mylib', 'ordentry', "'A' 42"), libraries: ['MYLIB', 'QGPL'], currentLibrary: 'MYLIB',
    ignoreCertificateErrors: false, updateProductionFiles: false, trace: false,
  });
  assert.strictEqual(c.type, 'IBMiDebug');
  assert.strictEqual(c.subType, 'batch');
  assert.strictEqual(c.user, 'ME');
  assert.strictEqual(c.program, 'ORDENTRY');
  assert.strictEqual(c.startBatchJobCommand,
    "SBMJOB CMD(CALL PGM(MYLIB/ORDENTRY) PARM('A' 42)) INLLIBL(MYLIB QGPL) CURLIB(MYLIB) JOBQ(QSYSNOMAX) MSGQ(*USRPRF) CPYENVVAR(*YES)");
});
