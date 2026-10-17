import * as vscode from 'vscode';
import { ConnectionManager } from '../core/manager';
import { IbmiConnection } from '../core/connection';
import { errorMessage, logError } from '../core/log';
import { assertSystemName, parseMemberPath, sqlString } from '../core/util';
import { compareSets, CompareItem } from '../core/compareSets';
import { compareRows } from '../core/diagrams';
import { MEMBER_SCHEME } from './fileSystems';
import { reportProgress, showReport } from './reportPanel';

type Row = Record<string, unknown>;
const s = (r: Row | undefined, k: string) => String(r?.[k] ?? '').trim();
const XSYS = 'vanthrex-xsys';
const contents = new Map<string, string>();
const ALLOWED = new Set(['vanthrex.compareSystems']);
const progress = <T>(title: string, fn: () => Promise<T>) => vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title }, fn);

async function pickOther(manager: ConnectionManager): Promise<[IbmiConnection, IbmiConnection] | undefined> {
  const a = manager.require();
  const others = manager.openConnections.filter(c => c !== a);
  if (!others.length) {
    throw new Error(vscode.l10n.t('Connect to a second system first (Connections view → connect another system; {0} stays connected).', a.profile.name));
  }
  if (others.length === 1) { return [a, others[0]]; }
  const p = await vscode.window.showQuickPick(others.map(c => ({ label: c.profile.name, description: `${c.user}@${c.profile.host}`, c })), { title: vscode.l10n.t('Compare {0} with…', a.profile.name) });
  return p ? [a, p.c] : undefined;
}

async function askName(title: string, value: string): Promise<string | undefined> {
  return (await vscode.window.showInputBox({ title, value, ignoreFocusOut: true }))?.trim().toUpperCase();
}

async function compareMember(a: IbmiConnection, b: IbmiConnection): Promise<void> {
  const ed = vscode.window.activeTextEditor;
  let def = '';
  if (ed?.document.uri.scheme === MEMBER_SCHEME) { const p = parseMemberPath(ed.document.uri.path); def = `${p.library}/${p.file}(${p.member})`; }
  const left = await askName(vscode.l10n.t('Member on {0}: LIBRARY/FILE(MEMBER)', a.profile.name), def);
  if (!left) { return; }
  const right = await askName(vscode.l10n.t('Member on {0}: LIBRARY/FILE(MEMBER)', b.profile.name), left);
  if (!right) { return; }
  const parse = (v: string) => { const m = /^([^/]+)\/([^(]+)\(([^)]+)\)$/.exec(v); if (!m) { throw new Error(vscode.l10n.t('Write it as LIBRARY/FILE(MEMBER).')); } return m.slice(1, 4) as [string, string, string]; };
  const [la, fa, ma] = parse(left); const [lb, fb, mb] = parse(right);
  const [ta, tb] = await progress(vscode.l10n.t('Reading both members…'), () => Promise.all([a.readMember(la, fa, ma), b.readMember(lb, fb, mb)]));
  const ua = vscode.Uri.from({ scheme: XSYS, path: `/${a.profile.name}/${la}/${fa}/${ma}.txt`, query: String(Date.now()) });
  const ub = vscode.Uri.from({ scheme: XSYS, path: `/${b.profile.name}/${lb}/${fb}/${mb}.txt`, query: String(Date.now()) });
  contents.set(ua.toString(), ta); contents.set(ub.toString(), tb);
  await vscode.commands.executeCommand('vscode.diff', ua, ub, `${ma}: ${a.profile.name} ↔ ${b.profile.name}`);
  if (ta === tb) { vscode.window.showInformationMessage(vscode.l10n.t('The two members are identical.')); }
}

async function compareObjects(a: IbmiConnection, b: IbmiConnection): Promise<void> {
  const lib = await askName(vscode.l10n.t('Library to compare on both systems'), a.profile.currentLibrary ?? '');
  if (!lib) { return; }
  const libB = await askName(vscode.l10n.t('Library on {0}', b.profile.name), lib);
  if (!libB) { return; }
  const q = (l: string) => `SELECT OBJNAME AS N, OBJTYPE AS T, COALESCE(OBJATTRIBUTE, '') AS A, COALESCE(OBJSIZE, 0) AS SZ, VARCHAR_FORMAT(CHANGE_TIMESTAMP, 'YYYY-MM-DD HH24:MI:SS') AS CHG, ` +
    `COALESCE(VARCHAR_FORMAT(SOURCE_TIMESTAMP, 'YYYY-MM-DD HH24:MI:SS'), '') AS SRC, VARCHAR_FORMAT(OBJCREATED, 'YYYY-MM-DD HH24:MI:SS') AS CRT FROM TABLE(QSYS2.OBJECT_STATISTICS(${sqlString(l)}, '*ALL')) X`;
  const [ra, rb] = await reportProgress('xsysobj', vscode.l10n.t('Reading both libraries…'), () => Promise.all([a.rows<Row>(q(assertSystemName(lib, 'library')), 50000), b.rows<Row>(q(assertSystemName(libB, 'library')), 50000)]));
  const item = (r: Row): CompareItem => ({ key: `${s(r, 'N')} ${s(r, 'T')}`, fingerprint: `${s(r, 'A')}|${s(r, 'SRC') || s(r, 'CRT')}`, changed: s(r, 'CHG'),
    detail: `${s(r, 'A')} · ${Math.round(Number(r.SZ) / 1024)} KB · changed ${s(r, 'CHG')}${s(r, 'SRC') ? ` · source ${s(r, 'SRC')}` : ''}` });
  const rows = compareSets(ra.map(item), rb.map(item));
  const count = (st: string) => rows.filter(r => r.status === st).length;
  showReport('xsysobj', {
    title: `${lib} on ${a.profile.name} ↔ ${libB} on ${b.profile.name}`,
    subtitle: vscode.l10n.t('{0} different, {1} only on {2}, {3} only on {4}, {5} the same.', count('different'), count('onlyA'), a.profile.name, count('onlyB'), b.profile.name, count('same')),
    actions: [{ label: vscode.l10n.t('Compare something else'), command: 'vanthrex.compareSystems' }],
    tables: [{ title: vscode.l10n.t('Objects'), filter: true, columns: ['Object', 'Status', `${a.profile.name}`, `${b.profile.name}`, 'Newer on'],
      rows: rows.filter(r => r.status !== 'same').map(r => [r.key, r.status === 'onlyA' ? `only on ${a.profile.name}` : r.status === 'onlyB' ? `only on ${b.profile.name}` : 'different',
        r.a?.detail ?? '', r.b?.detail ?? '', r.newer === 'A' ? a.profile.name : r.newer === 'B' ? b.profile.name : '']),
      rowClass: rows.filter(r => r.status !== 'same').map(r => (r.status === 'onlyA' ? 'onlyA' : r.status === 'onlyB' ? 'onlyB' : 'different')), empty: vscode.l10n.t('Both libraries have the same objects.') }],
    note: vscode.l10n.t('Objects are "different" when their attribute or source date (or creation date when there is no source) differ. Sizes are shown but not compared, because the same object can have a different size on another system.'),
  }, ALLOWED);
}

async function compareTable(a: IbmiConnection, b: IbmiConnection): Promise<void> {
  const v = await askName(vscode.l10n.t('Table to compare: LIBRARY/TABLE'), '');
  if (!v?.includes('/')) { return; }
  const [lib, tbl] = v.split('/').map(x => assertSystemName(x, 'name'));
  const libB = await askName(vscode.l10n.t('Library of the table on {0}', b.profile.name), lib);
  if (!libB) { return; }
  const cols = await a.rows<Row>(`SELECT COLUMN_NAME AS C, DATA_TYPE AS T FROM QSYS2.SYSCOLUMNS WHERE SYSTEM_TABLE_SCHEMA = ${sqlString(lib)} AND SYSTEM_TABLE_NAME = ${sqlString(tbl)} ORDER BY ORDINAL_POSITION`, 2000);
  if (!cols.length) { throw new Error(vscode.l10n.t('{0}/{1} was not found.', lib, tbl)); }
  const names = cols.filter(c => !/LOB|XML|DATALINK/i.test(s(c, 'T'))).map(c => s(c, 'C'));
  const pk = await a.rows<Row>(`SELECT K.COLUMN_NAME AS C FROM QSYS2.SYSCST C JOIN QSYS2.SYSKEYCST K ON K.CONSTRAINT_SCHEMA = C.CONSTRAINT_SCHEMA AND K.CONSTRAINT_NAME = C.CONSTRAINT_NAME ` +
    `WHERE C.SYSTEM_TABLE_SCHEMA = ${sqlString(lib)} AND C.SYSTEM_TABLE_NAME = ${sqlString(tbl)} AND C.CONSTRAINT_TYPE IN ('PRIMARY KEY', 'UNIQUE') ORDER BY K.ORDINAL_POSITION`, 50).catch(() => []);
  const picked = await vscode.window.showQuickPick(names.map(c => ({ label: c, picked: pk.some(p => s(p, 'C') === c) })), { canPickMany: true, title: vscode.l10n.t('Key columns that identify a row') });
  if (!picked?.length) { return; }
  const keys = picked.map(p => p.label);
  const max = vscode.workspace.getConfiguration('vanthrex.compare').get<number>('maxRows', 50000);
  const sel = (l: string) => `SELECT ${names.map(c => `"${c}"`).join(', ')} FROM ${l}/${tbl} ORDER BY ${keys.map(c => `"${c}"`).join(', ')} FETCH FIRST ${max} ROWS ONLY`;
  const [ra, rb] = await reportProgress('xsystbl', vscode.l10n.t('Reading {0} from both systems…', tbl), () => Promise.all([a.rows<Row>(sel(lib), max), b.rows<Row>(sel(libB), max)]));
  const r = compareRows(keys, ra, rb, names);
  const keyOf = (x: Row) => keys.map(k => String(x[k] ?? '').trimEnd()).join(' · ');
  const show = names.filter(c => !keys.includes(c)).slice(0, 4);
  showReport('xsystbl', {
    title: `${tbl}: ${a.profile.name} ↔ ${b.profile.name}`,
    subtitle: `${ra.length} rows on ${a.profile.name}, ${rb.length} on ${b.profile.name}${ra.length >= max || rb.length >= max ? ` (first ${max} by key — setting vanthrex.compare.maxRows)` : ''}. Keys: ${keys.join(', ')}.`,
    facts: [[`Only on ${a.profile.name}`, r.onlyA.length], [`Only on ${b.profile.name}`, r.onlyB.length], ['Changed', r.changed.length], ['Same', r.same]],
    actions: [{ label: vscode.l10n.t('Compare something else'), command: 'vanthrex.compareSystems' }],
    tables: [
      { title: vscode.l10n.t('Changed rows'), filter: true, columns: ['Key', 'Changed fields'], rows: r.changed.slice(0, 1000).map(c => [c.key, c.diffs.map(d => `${d.col}: ${d.a} → ${d.b}`).join('\n')]), rowClass: r.changed.slice(0, 1000).map(() => 'different'), empty: vscode.l10n.t('None.') },
      { title: vscode.l10n.t('Only on {0}', a.profile.name), filter: true, columns: ['Key', ...show], rows: r.onlyA.slice(0, 500).map(x => [keyOf(x), ...show.map(c => String(x[c] ?? ''))]), rowClass: r.onlyA.slice(0, 500).map(() => 'onlyA'), empty: vscode.l10n.t('None.') },
      { title: vscode.l10n.t('Only on {0}', b.profile.name), filter: true, columns: ['Key', ...show], rows: r.onlyB.slice(0, 500).map(x => [keyOf(x), ...show.map(c => String(x[c] ?? ''))]), rowClass: r.onlyB.slice(0, 500).map(() => 'onlyB'), empty: vscode.l10n.t('None.') },
    ],
    note: vscode.l10n.t('Rows are read from each system and compared in VS Code, so the two systems never need to reach each other. Trailing blanks are ignored; LOB and XML columns are skipped.'),
  }, ALLOWED);
}

async function compareSettings(a: IbmiConnection, b: IbmiConnection, what: 'sysval' | 'ptf'): Promise<void> {
  const sql = what === 'sysval'
    ? `SELECT SYSTEM_VALUE_NAME AS K, COALESCE(VARCHAR(CURRENT_NUMERIC_VALUE), CURRENT_CHARACTER_VALUE, '') AS V FROM QSYS2.SYSTEM_VALUE_INFO`
    : `SELECT PTF_GROUP_NAME || ' ' || COALESCE(PTF_GROUP_DESCRIPTION, '') AS K, VARCHAR(PTF_GROUP_LEVEL) AS V FROM QSYS2.GROUP_PTF_INFO WHERE PTF_GROUP_STATUS = 'INSTALLED'`;
  const [ra, rb] = await reportProgress('xsysset', vscode.l10n.t('Reading both systems…'), () => Promise.all([a.rows<Row>(sql, 5000), b.rows<Row>(sql, 5000)]));
  const rows = compareSets(ra.map(r => ({ key: s(r, 'K'), fingerprint: s(r, 'V'), detail: s(r, 'V') })), rb.map(r => ({ key: s(r, 'K'), fingerprint: s(r, 'V'), detail: s(r, 'V') })));
  const diff = rows.filter(r => r.status !== 'same');
  showReport('xsysset', {
    title: `${what === 'sysval' ? 'System values' : 'PTF groups'}: ${a.profile.name} ↔ ${b.profile.name}`,
    subtitle: vscode.l10n.t('{0} difference(s), {1} the same.', diff.length, rows.length - diff.length),
    actions: [{ label: vscode.l10n.t('Compare something else'), command: 'vanthrex.compareSystems' }],
    tables: [{ title: vscode.l10n.t('Differences'), filter: true, columns: [what === 'sysval' ? 'System value' : 'PTF group', a.profile.name, b.profile.name],
      rows: diff.map(r => [r.key, r.a?.detail ?? '—', r.b?.detail ?? '—']), rowClass: diff.map(() => 'different'), empty: vscode.l10n.t('No differences.') }],
    note: what === 'ptf' ? 'A lower level on one system means it is missing fixes the other one has.' : 'Differences in security and date / language values often explain "it works on DEV but not on PROD".',
  }, ALLOWED);
}

export function registerCrossSystem(context: vscode.ExtensionContext, manager: ConnectionManager): void {
  context.subscriptions.push(
    vscode.workspace.registerTextDocumentContentProvider(XSYS, { provideTextDocumentContent: uri => contents.get(uri.toString()) ?? '' }),
    vscode.commands.registerCommand('vanthrex.compareSystems', async () => {
      try {
        const pair = await pickOther(manager);
        if (!pair) { return; }
        const [a, b] = pair;
        const what = await vscode.window.showQuickPick([
          { label: vscode.l10n.t('$(file-code) A source member'), value: 'member' }, { label: vscode.l10n.t('$(library) The objects of a library'), value: 'objects' },
          { label: vscode.l10n.t('$(table) The rows of a table'), value: 'table' }, { label: vscode.l10n.t('$(settings) System values'), value: 'sysval' },
          { label: vscode.l10n.t('$(package) PTF group levels'), value: 'ptf' },
        ], { title: vscode.l10n.t('Compare {0} with {1}', a.profile.name, b.profile.name) });
        if (!what) { return; }
        if (what.value === 'member') { await compareMember(a, b); }
        else if (what.value === 'objects') { await compareObjects(a, b); }
        else if (what.value === 'table') { await compareTable(a, b); }
        else { await compareSettings(a, b, what.value as 'sysval' | 'ptf'); }
      } catch (e) { logError(e); vscode.window.showErrorMessage(errorMessage(e)); }
    }),
  );
}
