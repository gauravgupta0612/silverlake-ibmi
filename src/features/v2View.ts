import * as vscode from 'vscode';
import { ConnectionManager } from '../core/manager';
import { IbmiConnection } from '../core/connection';
import { errorMessage, log, logError } from '../core/log';
import { assertSystemName, parseMemberPath, sqlString, substituteVariables } from '../core/util';
import { Column, insertStatements } from '../core/dataTransfer';
import { formatBytes } from '../core/extras';
import { cpysrcfCommand, crtdupobjCommand, duplicatesSql, ifsGrepCommand, layoutPrtf, moveCommand, parseGrep, renameCommand, testRows } from '../core/v2';
import { ifsUri, memberUri } from './fileSystems';
import { showReport } from './reportPanel';
import { escapeHtml, nonce } from './webviewUtil';

type Row = Record<string, unknown>;
type Obj = { library: string; name: string; type?: string };
const s = (r: Row | undefined, k: string) => String(r?.[k] ?? '').trim();
const progress = <T>(title: string, fn: () => Promise<T>) => vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title }, fn);
const ALLOWED = new Set(['vscode.open', 'vanthrex.jobLog', 'vanthrex.analyzeJobLog', 'vanthrex.codeMetrics.open', 'vanthrex.compile', 'vanthrex.generateTestData.run',
  'vanthrex.batchCompile', 'vanthrex.tableStatistics', 'vanthrex.myRecentJobs', 'vanthrex.searchIfs', 'vanthrex.findDuplicates', 'vanthrex.editData', 'vanthrex.objectInfo']);

async function askTable(title: string, o?: Obj): Promise<Obj | undefined> {
  if (o?.library && o?.name) { return o; }
  const v = await vscode.window.showInputBox({ title, prompt: 'LIBRARY/TABLE', ignoreFocusOut: true });
  if (!v?.includes('/')) { return undefined; }
  const [l, t] = v.trim().toUpperCase().split('/');
  return { library: assertSystemName(l, 'library'), name: assertSystemName(t, 'table') };
}

async function columnsOf(conn: IbmiConnection, t: Obj): Promise<(Column & { pk: boolean })[]> {
  const [cols, pk] = await Promise.all([
    conn.rows<Row>(`SELECT COLUMN_NAME AS N, DATA_TYPE AS T, LENGTH AS L, COALESCE(NUMERIC_SCALE, 0) AS S, IS_NULLABLE AS NL, HAS_DEFAULT AS D, COALESCE(IS_IDENTITY, 'NO') AS ID FROM QSYS2.SYSCOLUMNS ` +
      `WHERE SYSTEM_TABLE_SCHEMA = ${sqlString(t.library)} AND SYSTEM_TABLE_NAME = ${sqlString(t.name)} ORDER BY ORDINAL_POSITION`, 2000),
    conn.rows<Row>(`SELECT K.COLUMN_NAME AS C FROM QSYS2.SYSCST C JOIN QSYS2.SYSKEYCST K ON K.CONSTRAINT_SCHEMA = C.CONSTRAINT_SCHEMA AND K.CONSTRAINT_NAME = C.CONSTRAINT_NAME ` +
      `WHERE C.SYSTEM_TABLE_SCHEMA = ${sqlString(t.library)} AND C.SYSTEM_TABLE_NAME = ${sqlString(t.name)} AND C.CONSTRAINT_TYPE IN ('PRIMARY KEY', 'UNIQUE') ORDER BY C.CONSTRAINT_TYPE DESC, K.ORDINAL_POSITION`, 50).catch(() => []),
  ]);
  if (!cols.length) { throw new Error(vscode.l10n.t('{0}/{1} was not found.', t.library, t.name)); }
  const pks = new Set(pk.map(p => s(p, 'C')));
  return cols.filter(c => s(c, 'ID') !== 'YES').map(c => ({ name: s(c, 'N'), type: s(c, 'T'), length: Number(c.L), scale: Number(c.S), nullable: s(c, 'NL') === 'Y', pk: pks.has(s(c, 'N')) }));
}

// ================================================================ 1. printer file preview

function previewPrtf(doc: vscode.TextDocument, panelRef: { p?: vscode.WebviewPanel }): void {
  const { lines, items, records } = layoutPrtf(doc.getText());
  if (!panelRef.p) {
    panelRef.p = vscode.window.createWebviewPanel('vanthrex.prtf', vscode.l10n.t('Print preview'), { viewColumn: vscode.ViewColumn.Beside, preserveFocus: true }, { enableScripts: true });
    panelRef.p.onDidDispose(() => { panelRef.p = undefined; });
    panelRef.p.webview.onDidReceiveMessage(m => { if (typeof m?.line === 'number') { void vscode.window.showTextDocument(doc, { viewColumn: vscode.ViewColumn.One, selection: new vscode.Range(m.line, 0, m.line, 0) }); } });
  }
  const n = nonce();
  const ruler = Array.from({ length: 13 }, (_, i) => String((i + 1) % 10).padStart(10, '.')).join('').slice(0, 132);
  const rows = lines.map((l, i) => `<div><span class="ln">${String(i + 1).padStart(2)}</span>${escapeHtml(l)}</div>`).join('');
  const table = items.map(it => `<tr data-l="${it.srcLine}"><td>${escapeHtml(it.record)}</td><td>${escapeHtml(it.name || '(constant)')}</td><td>${it.line}</td><td>${it.col}</td><td>${escapeHtml(it.text.slice(0, 40))}</td></tr>`).join('');
  panelRef.p.webview.html = `<!DOCTYPE html><html><head><meta charset="UTF-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${n}';">
<style>body{font-family:var(--vscode-font-family);color:var(--vscode-foreground);padding:8px 12px}.page{background:#fffef7;color:#222;font-family:Consolas,'Courier New',monospace;font-size:12px;line-height:1.3;white-space:pre;padding:10px;overflow:auto;border-radius:4px;box-shadow:0 1px 4px #0004}
.ruler{color:#999}.ln{color:#aaa;margin-right:8px}.dim{color:var(--vscode-descriptionForeground)}table{border-collapse:collapse;margin-top:12px;font-size:12px}th,td{border:1px solid var(--vscode-editorWidget-border,#8883);padding:2px 6px}tr[data-l]{cursor:pointer}tr[data-l]:hover td{background:var(--vscode-list-hoverBackground)}</style></head><body>
<p class="dim">${escapeHtml(vscode.l10n.t('Record formats printed once each, in source order: {0}. SKIPB / SPACEB / SKIPA / SPACEA move the line; numeric fields show 9s.', records.join(', ')))}</p>
<div class="page"><div class="ruler"><span class="ln">  </span>${ruler}</div>${rows}</div>
<table><thead><tr><th>Record</th><th>Field</th><th>Line</th><th>Col</th><th>Sample</th></tr></thead><tbody>${table}</tbody></table>
<script nonce="${n}">const vscode=acquireVsCodeApi();document.addEventListener('click',e=>{const t=e.target.closest('[data-l]');if(t)vscode.postMessage({line:Number(t.dataset.l)});});</script></body></html>`;
  panelRef.p.reveal(vscode.ViewColumn.Beside, true);
}

// ================================================================ 2. batch compile

async function batchCompile(manager: ConnectionManager, n?: { library?: string; file?: string }): Promise<void> {
  const conn = manager.require();
  if (!n?.library || !n.file) { throw new Error(vscode.l10n.t('Right-click a source file in the Libraries view.')); }
  const lib = n.library; const file = n.file;
  const when = await vscode.window.showQuickPick([
    { label: vscode.l10n.t('Changed today'), days: 1 }, { label: vscode.l10n.t('Changed in the last 7 days'), days: 7 }, { label: vscode.l10n.t('Changed in the last 30 days'), days: 30 },
    { label: vscode.l10n.t('Pick members…'), days: 0 },
  ], { title: vscode.l10n.t('Compile members of {0}/{1}', lib, file) });
  if (!when) { return; }
  const all = await conn.rows<Row>(`SELECT SYSTEM_TABLE_MEMBER AS M, COALESCE(SOURCE_TYPE, '') AS T, VARCHAR_FORMAT(LAST_SOURCE_UPDATE_TIMESTAMP, 'YYYY-MM-DD HH24:MI') AS C FROM QSYS2.SYSPARTITIONSTAT ` +
    `WHERE SYSTEM_TABLE_SCHEMA = ${sqlString(lib)} AND SYSTEM_TABLE_NAME = ${sqlString(file)}` +
    `${when.days ? ` AND LAST_SOURCE_UPDATE_TIMESTAMP > CURRENT TIMESTAMP - ${when.days} DAYS` : ''} ORDER BY LAST_SOURCE_UPDATE_TIMESTAMP`, 5000);
  let members = all;
  if (!when.days) {
    const p = await vscode.window.showQuickPick(all.map(r => ({ label: s(r, 'M'), description: `${s(r, 'T')} · ${s(r, 'C')}`, r })), { canPickMany: true, title: vscode.l10n.t('Members to compile') });
    if (!p?.length) { return; }
    members = p.map(x => x.r);
  }
  if (!members.length) { vscode.window.showInformationMessage(vscode.l10n.t('No member changed in that period.')); return; }
  const actions = vscode.workspace.getConfiguration('vanthrex').get<{ name: string; extensions: string[]; source?: string; command: string }[]>('compileActions', []);
  const results: { m: Row; ok: boolean | undefined; cmd: string; msgs: string }[] = [];
  await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: vscode.l10n.t('Compiling {0} member(s)…', members.length), cancellable: true }, async (p, token) => {
    for (const m of members) {
      if (token.isCancellationRequested) { break; }
      p.report({ message: s(m, 'M'), increment: 100 / members.length });
      const ext = s(m, 'T').toLowerCase();
      const action = actions.find(a => a.extensions.map(x => x.toLowerCase()).includes(ext) && (a.source ?? 'member') !== 'ifs');
      if (!action) { results.push({ m, ok: undefined, cmd: '', msgs: vscode.l10n.t('No compile action for .{0}', ext) }); continue; }
      const cmd = substituteVariables(action.command, { LIB: lib, SRCFILE: file, NAME: s(m, 'M'), EXT: ext, OBJLIB: conn.profile.objectLibrary || lib, CURLIB: conn.profile.currentLibrary || 'QGPL', USER: conn.user });
      try {
        const r = await conn.runCL(cmd);
        results.push({ m, ok: r.ok, cmd, msgs: r.messages.filter(x => !/^CPC/.test(x)).join(' ') || (r.ok ? '' : (r.stderr || r.stdout).trim().split('\n').pop() ?? '') });
      } catch (e) { results.push({ m, ok: false, cmd, msgs: errorMessage(e).split('\n')[0] }); }
    }
  });
  const failed = results.filter(r => r.ok === false).length;
  showReport('batchCompile', {
    title: vscode.l10n.t('Compile {0}/{1}', lib, file), subtitle: vscode.l10n.t('{0} compiled, {1} failed, {2} skipped. Click a member to open it; compile it there (Ctrl+Alt+C) to see the errors inline.', results.filter(r => r.ok).length, failed, results.filter(r => r.ok === undefined).length),
    actions: [{ label: vscode.l10n.t('Compile again'), command: 'vanthrex.batchCompile', args: [{ library: lib, file }] }],
    tables: [{ title: vscode.l10n.t('Members'), filter: true, columns: ['Member', 'Type', 'Changed', 'Result', 'Messages', 'Command'],
      rows: results.sort((a, b) => Number(a.ok ?? 2) - Number(b.ok ?? 2)).map(r => [s(r.m, 'M'), s(r.m, 'T'), s(r.m, 'C'), r.ok === undefined ? 'skipped' : r.ok ? '✔ compiled' : '✘ failed', r.msgs, r.cmd]),
      rowActions: results.map(r => ({ label: vscode.l10n.t('Open'), command: 'vanthrex.codeMetrics.open', args: [lib, file, s(r.m, 'M'), s(r.m, 'T')] })),
      rowClass: results.map(r => (r.ok === false ? 'bad' : r.ok === undefined ? 'dim' : undefined)) }],
    note: vscode.l10n.t('Members are compiled one after the other with the first compile action that matches their type (setting vanthrex.compileActions). Build order matters: compile modules and service programs before the programs that use them.'),
  }, ALLOWED);
}

// ================================================================ 3–5. copy objects, copy members, move / rename

async function copyObjects(manager: ConnectionManager, o?: Obj): Promise<void> {
  const conn = manager.require();
  const lib = o?.library ?? (await vscode.window.showInputBox({ title: vscode.l10n.t('Copy objects from library'), ignoreFocusOut: true }))?.trim().toUpperCase();
  if (!lib) { return; }
  let picked: { name: string; type: string }[];
  if (o?.name && o.type) { picked = [{ name: o.name, type: o.type }]; }
  else {
    const objs = await conn.rows<Row>(`SELECT OBJNAME AS N, OBJTYPE AS T, COALESCE(OBJATTRIBUTE, '') AS A, COALESCE(OBJTEXT, '') AS X FROM TABLE(QSYS2.OBJECT_STATISTICS(${sqlString(lib)}, '*ALL')) X ORDER BY OBJNAME`, 20000);
    const p = await vscode.window.showQuickPick(objs.map(r => ({ label: s(r, 'N'), description: `${s(r, 'T')} ${s(r, 'A')}`, detail: s(r, 'X'), r })), { canPickMany: true, title: vscode.l10n.t('Objects to copy from {0}', lib), matchOnDescription: true });
    if (!p?.length) { return; }
    picked = p.map(x => ({ name: s(x.r, 'N'), type: s(x.r, 'T') }));
  }
  const to = (await vscode.window.showInputBox({ title: vscode.l10n.t('Copy to library'), ignoreFocusOut: true }))?.trim().toUpperCase();
  if (!to) { return; }
  let newName: string | undefined;
  if (picked.length === 1) { newName = (await vscode.window.showInputBox({ title: vscode.l10n.t('New name (optional)'), value: picked[0].name, ignoreFocusOut: true }))?.trim().toUpperCase(); if (newName === undefined) { return; } }
  let data = false;
  if (picked.some(x => x.type === '*FILE')) {
    const d = await vscode.window.showQuickPick([{ label: vscode.l10n.t('Without data'), v: false }, { label: vscode.l10n.t('With data'), v: true }], { title: vscode.l10n.t('Copy the data of files too?') });
    if (!d) { return; } data = d.v;
  }
  const cmds = picked.map(x => crtdupobjCommand(lib, x.name, x.type, to, newName, data));
  const ok = await vscode.window.showWarningMessage(vscode.l10n.t('Copy {0} object(s) from {1} to {2}?', picked.length, lib, to), { modal: true, detail: cmds.slice(0, 15).join('\n') }, vscode.l10n.t('Copy'));
  if (ok !== vscode.l10n.t('Copy')) { return; }
  const fails: string[] = [];
  await progress(vscode.l10n.t('Copying…'), async () => { for (const c of cmds) { const r = await conn.runCL(c); if (!r.ok) { fails.push(`${c.split(' ')[1]}: ${(r.stderr || r.stdout).trim().split('\n').pop()}`); } } });
  if (fails.length) { vscode.window.showErrorMessage(vscode.l10n.t('{0} copied, {1} failed: {2}', cmds.length - fails.length, fails.length, fails.join('; '))); }
  else { vscode.window.showInformationMessage(vscode.l10n.t('Copied {0} object(s) to {1}.', cmds.length, to)); }
  void vscode.commands.executeCommand('vanthrex.refreshLibraries');
}

async function copyMembers(manager: ConnectionManager, n?: { library?: string; file?: string; member?: string }): Promise<void> {
  const conn = manager.require();
  if (!n?.library || !n.file) { throw new Error(vscode.l10n.t('Right-click a source file or member in the Libraries view.')); }
  let members: string[];
  if (n.member) { members = [n.member]; }
  else {
    const all = await conn.rows<Row>(`SELECT SYSTEM_TABLE_MEMBER AS M, COALESCE(SOURCE_TYPE, '') AS T, COALESCE(PARTITION_TEXT, '') AS X FROM QSYS2.SYSPARTITIONSTAT WHERE SYSTEM_TABLE_SCHEMA = ${sqlString(n.library)} AND SYSTEM_TABLE_NAME = ${sqlString(n.file)} ORDER BY 1`, 5000);
    const p = await vscode.window.showQuickPick(all.map(r => ({ label: s(r, 'M'), description: s(r, 'T'), detail: s(r, 'X') })), { canPickMany: true, title: vscode.l10n.t('Members to copy') });
    if (!p?.length) { return; }
    members = p.map(x => x.label);
  }
  const to = (await vscode.window.showInputBox({ title: vscode.l10n.t('Copy to source file'), prompt: 'LIBRARY/FILE', value: `${n.library}/${n.file}`, ignoreFocusOut: true }))?.trim().toUpperCase();
  if (!to?.includes('/')) { return; }
  const [tl, tf] = to.split('/');
  let newName: string | undefined;
  if (members.length === 1) { newName = (await vscode.window.showInputBox({ title: vscode.l10n.t('Member name in the target'), value: members[0], ignoreFocusOut: true }))?.trim().toUpperCase(); if (!newName) { return; } }
  if (tl === n.library && tf === n.file && (!newName || newName === members[0])) { throw new Error(vscode.l10n.t('Pick another source file or another name.')); }
  const rep = await vscode.window.showQuickPick([{ label: vscode.l10n.t('Keep existing members (skip them)'), v: false }, { label: vscode.l10n.t('Replace existing members'), v: true }], { title: vscode.l10n.t('If a member already exists in {0}', to) });
  if (!rep) { return; }
  const fails: string[] = [];
  await progress(vscode.l10n.t('Copying…'), async () => {
    for (const m of members) {
      const r = await conn.runCL(cpysrcfCommand(n.library!, n.file!, m, tl, tf, rep.v, members.length === 1 ? newName : undefined));
      if (!r.ok) { fails.push(`${m}: ${(r.stderr || r.stdout).trim().split('\n').pop()}`); }
    }
  });
  if (fails.length) { vscode.window.showWarningMessage(vscode.l10n.t('{0} copied, {1} not copied: {2}', members.length - fails.length, fails.length, fails.join('; '))); }
  else { vscode.window.showInformationMessage(vscode.l10n.t('Copied {0} member(s) to {1} — sequence numbers and dates kept.', members.length, to)); }
  void vscode.commands.executeCommand('vanthrex.refreshLibraries');
}

async function moveRename(manager: ConnectionManager, o: Obj): Promise<void> {
  const conn = manager.require();
  if (!o?.library || !o.name || !o.type) { throw new Error(vscode.l10n.t('Right-click an object in the Libraries view.')); }
  const what = await vscode.window.showQuickPick([{ label: vscode.l10n.t('$(edit) Rename'), v: 'rename' }, { label: vscode.l10n.t('$(arrow-right) Move to another library'), v: 'move' }], { title: `${o.library}/${o.name} ${o.type}` });
  if (!what) { return; }
  const v = (await vscode.window.showInputBox({ title: what.v === 'rename' ? vscode.l10n.t('New name') : vscode.l10n.t('Move to library'), value: what.v === 'rename' ? o.name : '', ignoreFocusOut: true }))?.trim().toUpperCase();
  if (!v) { return; }
  const cmd = what.v === 'rename' ? renameCommand(o.library, o.name, o.type, v) : moveCommand(o.library, o.name, o.type, v);
  const ok = await vscode.window.showWarningMessage(cmd, { modal: true, detail: vscode.l10n.t('Programs that refer to the old name or library will no longer find it.') }, vscode.l10n.t('Run'));
  if (ok !== vscode.l10n.t('Run')) { return; }
  const r = await conn.runCL(cmd);
  if (!r.ok) { throw new Error((r.stderr || r.stdout).trim()); }
  vscode.window.showInformationMessage(vscode.l10n.t('Done.'));
  void vscode.commands.executeCommand('vanthrex.refreshLibraries');
}

// ================================================================ 6. table statistics

async function tableStatistics(manager: ConnectionManager, lib?: string): Promise<void> {
  const conn = manager.require();
  const l = lib ?? (await vscode.window.showInputBox({ title: vscode.l10n.t('Table statistics'), prompt: vscode.l10n.t('Library'), value: conn.profile.currentLibrary ?? '', ignoreFocusOut: true }))?.trim().toUpperCase();
  if (!l) { return; }
  const rows = await progress(vscode.l10n.t('Reading table statistics of {0}…', l), () => conn.rows<Row>(`SELECT * FROM QSYS2.SYSTABLESTAT WHERE SYSTEM_TABLE_SCHEMA = ${sqlString(assertSystemName(l, 'library'))} ORDER BY DATA_SIZE DESC`, 5000));
  const n = (r: Row, k: string) => Number(r[k] ?? 0) || 0;
  const date = (r: Row, k: string) => s(r, k).replace(/\.\d+$/, '').slice(0, 16);
  showReport('tablestats', {
    title: vscode.l10n.t('Table statistics — {0}', l), subtitle: vscode.l10n.t('{0} table(s), {1} rows, {2}.', rows.length, rows.reduce((a, r) => a + n(r, 'NUMBER_ROWS'), 0).toLocaleString(), formatBytes(rows.reduce((a, r) => a + n(r, 'DATA_SIZE'), 0))),
    actions: [{ label: vscode.l10n.t('Refresh'), command: 'vanthrex.tableStatistics', args: [l] }],
    tables: [{ title: vscode.l10n.t('Tables (biggest first)'), filter: true, columns: ['Table', 'Rows', 'Deleted rows', 'Data size', 'Members', 'Last changed', 'Last used', 'Days used'],
      rows: rows.map(r => [s(r, 'SYSTEM_TABLE_NAME'), n(r, 'NUMBER_ROWS').toLocaleString(), n(r, 'NUMBER_DELETED_ROWS').toLocaleString(), formatBytes(n(r, 'DATA_SIZE')),
        n(r, 'NUMBER_PARTITIONS') || '', date(r, 'LAST_CHANGE_TIMESTAMP'), date(r, 'LAST_USED_TIMESTAMP'), n(r, 'DAYS_USED_COUNT') || '']),
      rowActions: rows.map(r => ({ label: vscode.l10n.t('Edit data'), command: 'vanthrex.editData', args: [{ library: l, name: s(r, 'SYSTEM_TABLE_NAME') }] })),
      rowClass: rows.map(r => (n(r, 'NUMBER_DELETED_ROWS') > n(r, 'NUMBER_ROWS') * 0.2 && n(r, 'NUMBER_DELETED_ROWS') > 1000 ? 'different' : undefined)) }],
    note: vscode.l10n.t('Highlighted tables have more than 20 % deleted rows — the Storage & cleanup advisor can reorganize them.'),
  }, ALLOWED);
}

// ================================================================ 7. my recent jobs

async function myRecentJobs(manager: ConnectionManager): Promise<void> {
  const conn = manager.require();
  const rows = await progress(vscode.l10n.t('Reading your recent jobs…'), () => conn.rows<Row>(
    `SELECT * FROM TABLE(QSYS2.JOB_INFO(JOB_USER_FILTER => ${sqlString(conn.user)}, JOB_STATUS_FILTER => '*ALL')) X WHERE JOB_TYPE <> 'INT' OR JOB_TYPE IS NULL ORDER BY JOB_ENTERED_SYSTEM_TIME DESC FETCH FIRST 300 ROWS ONLY`, 300));
  const status = (r: Row) => s(r, 'COMPLETION_STATUS') || s(r, 'JOB_STATUS');
  showReport('recentjobs', {
    title: vscode.l10n.t('Recent jobs of {0}', conn.user), subtitle: vscode.l10n.t('{0} job(s), newest first; {1} ended abnormally. Click a job for its job log.', rows.length, rows.filter(r => /ABNORMAL/i.test(status(r))).length),
    actions: [{ label: vscode.l10n.t('Refresh'), command: 'vanthrex.myRecentJobs' }],
    tables: [{ title: vscode.l10n.t('Jobs'), filter: true, columns: ['Job', 'Type', 'Status', 'Entered', 'Started', 'Ended', 'Job queue'],
      rows: rows.map(r => [s(r, 'JOB_NAME'), s(r, 'JOB_TYPE'), status(r), s(r, 'JOB_ENTERED_SYSTEM_TIME').slice(0, 19), s(r, 'JOB_ACTIVE_TIME').slice(0, 19), s(r, 'JOB_END_TIME').slice(0, 19), s(r, 'JOB_QUEUE_NAME')]),
      rowActions: rows.map(r => (/ABNORMAL/i.test(status(r)) ? { label: vscode.l10n.t('Analyze job log'), command: 'vanthrex.analyzeJobLog', args: [s(r, 'JOB_NAME')] } : { label: vscode.l10n.t('Job log'), command: 'vanthrex.jobLog', args: [{ job: s(r, 'JOB_NAME') }] })),
      rowClass: rows.map(r => (/ABNORMAL/i.test(status(r)) ? 'bad' : undefined)) }],
  }, ALLOWED);
}

// ================================================================ 8. search the IFS

async function searchIfs(manager: ConnectionManager, n?: { path?: string; isDirectory?: boolean }): Promise<void> {
  const conn = manager.require();
  const folder = n?.path && n.isDirectory ? n.path : (await vscode.window.showInputBox({ title: vscode.l10n.t('Search text in IFS files'), prompt: vscode.l10n.t('Folder'), value: conn.profile.ifsHome ?? '/home', ignoreFocusOut: true }))?.trim();
  if (!folder) { return; }
  const text = await vscode.window.showInputBox({ title: vscode.l10n.t('Find in {0}', folder), ignoreFocusOut: true });
  if (!text) { return; }
  const include = await vscode.window.showInputBox({ title: vscode.l10n.t('Only files named (optional)'), placeHolder: vscode.l10n.t('*.rpgle'), ignoreFocusOut: true });
  if (include === undefined) { return; }
  const r = await progress(vscode.l10n.t('Searching {0}…', folder), () => conn.exec(ifsGrepCommand(folder, text, { include, max: 2000 })));
  const hits = parseGrep(r.stdout);
  showReport('ifsSearch', {
    title: `"${text}" in ${folder}`, subtitle: vscode.l10n.t('{0} match(es) in {1} file(s){2}. Click one to open it at that line.', hits.length, new Set(hits.map(h => h.file)).size, hits.length >= 2000 ? ' (first 2000)' : ''),
    tables: [{ title: vscode.l10n.t('Matches'), filter: true, columns: ['File', 'Line', 'Text'], rows: hits.map(h => [h.file, h.line, h.text.trim().slice(0, 200)]),
      rowActions: hits.map(h => ({ label: vscode.l10n.t('Open'), command: 'vscode.open', args: [ifsUri(h.file), { selection: new vscode.Range(h.line - 1, 0, h.line - 1, 0) }] })), empty: vscode.l10n.t('No match.') }],
  }, ALLOWED);
}

// ================================================================ 9. test data

let pendingTest: { t: Obj; cols: (Column & { pk: boolean })[]; rows: (string | null)[][] } | undefined;

async function generateTestData(manager: ConnectionManager, o?: Obj): Promise<void> {
  const conn = manager.require();
  const t = await askTable(vscode.l10n.t('Generate test data'), o);
  if (!t) { return; }
  const cols = await columnsOf(conn, t);
  const count = Number(await vscode.window.showInputBox({ title: vscode.l10n.t('How many rows?'), value: '100', validateInput: v => (/^\d+$/.test(v) && Number(v) > 0 && Number(v) <= 100000 ? undefined : '1–100000') }));
  if (!count) { return; }
  const pk = cols.filter(c => c.pk);
  let start = 0;
  if (pk.length === 1 && /DEC|NUM|INT/i.test(pk[0].type)) {
    const m = await conn.rows<Row>(`SELECT COALESCE(MAX("${pk[0].name}"), 0) AS M FROM ${t.library}/${t.name}`, 1).catch(() => []);
    start = Number(m[0]?.M ?? 0) || 0;
  }
  const rows = testRows(cols, count, start, Date.now() % 100000);
  pendingTest = { t, cols, rows };
  const names = cols.map(c => c.name);
  showReport('testdata', {
    title: vscode.l10n.t('Test data for {0}/{1}', t.library, t.name), subtitle: `${count} row(s) ready${pk.length ? `, keys ${pk.map(p => p.name).join(', ')} continue after ${start}` : ''}. Nothing is written until you click Insert.`,
    actions: [{ label: vscode.l10n.t('Insert {0} row(s)…', count), command: 'vanthrex.generateTestData.run' }],
    tables: [{ title: vscode.l10n.t('Preview (first 20 rows)'), columns: names, rows: rows.slice(0, 20).map(r => r.map(v => v ?? '∅')) }],
    note: vscode.l10n.t('Values follow each column\'s type and length; numeric keys continue after the highest existing key. Identity columns are left to Db2. Use this only on test systems.'),
  }, ALLOWED);
}

async function insertTestData(manager: ConnectionManager): Promise<void> {
  const conn = manager.require();
  const p = pendingTest;
  if (!p) { throw new Error(vscode.l10n.t('Generate test data first.')); }
  const ok = await vscode.window.showWarningMessage(vscode.l10n.t('Insert {0} test row(s) into {1}/{2}?', p.rows.length, p.t.library, p.t.name), { modal: true }, vscode.l10n.t('Insert'));
  if (ok !== vscode.l10n.t('Insert')) { return; }
  const { sql, errors } = insertStatements(p.t.library, p.t.name, p.cols, p.cols.map((_, i) => i), p.rows);
  await progress(vscode.l10n.t('Inserting…'), async () => { for (const st of sql) { await conn.sql(st, 1); } });
  pendingTest = undefined;
  const c = await vscode.window.showInformationMessage(vscode.l10n.t('Inserted {0} row(s).{1}', p.rows.length - errors.length, errors.length ? ` ${errors.length} skipped.` : ''), vscode.l10n.t('Open the Data'));
  if (c) { await vscode.commands.executeCommand('vanthrex.editData', p.t); }
}

// ================================================================ 10. CL command finder

async function findCommand(manager: ConnectionManager): Promise<void> {
  const conn = manager.require();
  const q = await vscode.window.showInputBox({ title: vscode.l10n.t('Find a CL command'), prompt: vscode.l10n.t('A word from its name or description, e.g. "journal", "spool", "user"'), ignoreFocusOut: true });
  if (!q?.trim()) { return; }
  const like = sqlString(`%${q.trim().toUpperCase().replace(/[%_]/g, '')}%`);
  const rows = await progress(vscode.l10n.t('Searching commands…'), () => conn.rows<Row>(
    `SELECT OBJNAME AS N, OBJLIB AS L, COALESCE(OBJTEXT, '') AS T FROM TABLE(QSYS2.OBJECT_STATISTICS('*LIBL', '*CMD')) X ` +
    `WHERE OBJNAME LIKE ${like} OR UPPER(OBJTEXT) LIKE ${like} ORDER BY CASE WHEN OBJNAME LIKE ${like} THEN 0 ELSE 1 END, OBJNAME FETCH FIRST 300 ROWS ONLY`, 300));
  if (!rows.length) { vscode.window.showInformationMessage(vscode.l10n.t('No command matches "{0}".', q)); return; }
  const pick = await vscode.window.showQuickPick(rows.map(r => ({ label: s(r, 'N'), description: s(r, 'L'), detail: s(r, 'T') })), { title: vscode.l10n.t('{0} command(s) — pick one to prompt it (F4)', rows.length), matchOnDetail: true });
  if (pick) { await vscode.commands.executeCommand('vanthrex.promptCl', pick.label); }
}

// ================================================================ 12. duplicates

async function findDuplicates(manager: ConnectionManager, o?: Obj): Promise<void> {
  const conn = manager.require();
  const t = await askTable(vscode.l10n.t('Find duplicate rows'), o);
  if (!t) { return; }
  const cols = await columnsOf(conn, t);
  const picked = await vscode.window.showQuickPick(cols.map(c => ({ label: c.name, description: c.type, picked: c.pk })), { canPickMany: true, title: vscode.l10n.t('Rows count as duplicates when these columns are equal') });
  if (!picked?.length) { return; }
  const keys = picked.map(p => p.label);
  const rows = await progress(vscode.l10n.t('Looking for duplicates…'), () => conn.rows<Row>(duplicatesSql(t.library, t.name, keys), 500));
  showReport('dups', {
    title: vscode.l10n.t('Duplicates in {0}/{1}', t.library, t.name), subtitle: rows.length ? `${rows.length} value(s) appear more than once (by ${keys.join(', ')}), most copies first.` : `No duplicates by ${keys.join(', ')}.`,
    actions: [{ label: vscode.l10n.t('Check other columns'), command: 'vanthrex.findDuplicates', args: [t] }, { label: vscode.l10n.t('Edit data'), command: 'vanthrex.editData', args: [t] }],
    tables: [{ title: vscode.l10n.t('Duplicated values'), filter: true, columns: [...keys, 'Copies'], rows: rows.map(r => [...keys.map(k => String(r[k] ?? '')), String(r.COPIES ?? '')]), empty: vscode.l10n.t('None.') }],
  }, ALLOWED);
}

// ================================================================ registration

export function registerV2(context: vscode.ExtensionContext, manager: ConnectionManager): void {
  const guard = <A extends unknown[]>(fn: (...a: A) => Promise<unknown> | unknown) => async (...a: A) => {
    try { await fn(...a); } catch (e) { logError(e); vscode.window.showErrorMessage(errorMessage(e)); }
  };
  const obj = (x: unknown): Obj | undefined => { const o = x as Partial<Obj> | undefined; return o?.library && o?.name ? { library: o.library, name: o.name, type: o.type } : undefined; };
  const prtf: { p?: vscode.WebviewPanel; doc?: vscode.TextDocument } = {};
  let timer: NodeJS.Timeout | undefined;
  context.subscriptions.push(
    vscode.commands.registerCommand('vanthrex.previewPrtf', guard(() => {
      const ed = vscode.window.activeTextEditor;
      if (!ed) { throw new Error(vscode.l10n.t('Open a printer file (PRTF) source first.')); }
      prtf.doc = ed.document; previewPrtf(ed.document, prtf);
    })),
    vscode.workspace.onDidChangeTextDocument(e => {
      if (prtf.p && e.document === prtf.doc) { if (timer) { clearTimeout(timer); } timer = setTimeout(() => previewPrtf(e.document, prtf), 400); }
    }),
    vscode.commands.registerCommand('vanthrex.batchCompile', guard((n?: { library?: string; file?: string }) => batchCompile(manager, n))),
    vscode.commands.registerCommand('vanthrex.copyObjects', guard((x?: unknown) => {
      const o = x as Partial<Obj> | undefined; return copyObjects(manager, o?.library ? { library: o.library, name: o.name ?? '', type: o.type } : undefined);
    })),
    vscode.commands.registerCommand('vanthrex.copyMembers', guard((n?: { library?: string; file?: string; member?: string }) => {
      const doc = vscode.window.activeTextEditor?.document;
      if (!n && doc?.uri.scheme === 'vanthrex-member') { const p = parseMemberPath(doc.uri.path); return copyMembers(manager, { library: p.library, file: p.file, member: p.member }); }
      return copyMembers(manager, n);
    })),
    vscode.commands.registerCommand('vanthrex.moveRenameObject', guard((x: unknown) => moveRename(manager, obj(x)!))),
    vscode.commands.registerCommand('vanthrex.tableStatistics', guard((x?: unknown) => tableStatistics(manager, typeof x === 'string' ? x : (x as { library?: string } | undefined)?.library))),
    vscode.commands.registerCommand('vanthrex.myRecentJobs', guard(() => myRecentJobs(manager))),
    vscode.commands.registerCommand('vanthrex.searchIfs', guard((n?: { path?: string; isDirectory?: boolean }) => searchIfs(manager, n))),
    vscode.commands.registerCommand('vanthrex.generateTestData', guard((x?: unknown) => generateTestData(manager, obj(x)))),
    vscode.commands.registerCommand('vanthrex.generateTestData.run', guard(() => insertTestData(manager))),
    vscode.commands.registerCommand('vanthrex.findCommand', guard(() => findCommand(manager))),
    vscode.commands.registerCommand('vanthrex.findDuplicates', guard((x?: unknown) => findDuplicates(manager, obj(x)))),
  );
  void memberUri; void log;
}
