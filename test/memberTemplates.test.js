const test = require('node:test');
const assert = require('node:assert');
const v = {
  ...require('../out/core/memberTemplates'),
  ...require('../out/core/changeTracking'),
};

test('change report and templates', () => {
  const md = v.changeReportMarkdown('APP', 7, [
    { kind: 'member', name: 'ORDENT', type: 'RPGLE', where: 'QRPGLESRC', changed: '2026-10-10 09:00', text: 'Order | entry' },
    { kind: 'object', name: 'ORDENT', type: '*PGM', where: 'APP', changed: '2026-10-10 09:05' },
  ], new Date('2026-10-12T00:00:00Z'));
  assert.match(md, /^# Changes in APP — last 7 day\(s\)/);
  assert.match(md, /\| ORDENT \| RPGLE \| QRPGLESRC \| 2026-10-10 09:00 \| Order \\\| entry \|/);
  assert.match(md, /## Objects \(1\)/);
  assert.ok(v.TEMPLATES.length >= 8 && v.TEMPLATES.every(t => t.name && t.type && t.text));
  const t = v.renderTemplate(v.TEMPLATES.find(x => x.type === 'SQL').text, { name: 'orders', text: "Client's orders", user: 'bob', date: new Date('2026-10-12T00:00:00Z') });
  assert.match(t, /CREATE OR REPLACE TABLE MYLIB\/ORDERS FOR SYSTEM NAME ORDERS/);
  assert.match(t, /LABEL ON TABLE MYLIB\/ORDERS IS 'Client''s orders';/);
  assert.match(t, /Created 2026-10-12 by BOB/);
});
