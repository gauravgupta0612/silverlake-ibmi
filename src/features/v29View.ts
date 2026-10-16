// 2.3 batch 4: data structure layout (with hover), expanded /COPY view, service program signature check
// and failed batch jobs.

import * as vscode from 'vscode';
import { ConnectionManager } from '../core/manager';
import { IbmiConnection } from '../core/connection';
import { errorMessage, logError } from '../core/log';
import { parseMemberPath, sqlString } from '../core/util';
import {
  DsLayout, ExtColumn, dataStructures, endCodeMeaning, externalFiles, externalLibrary, failedJobs, failuresByName, mergeIncludes, rebindCommand, signatureState, splitSignatures,
} from '../core/v29';
import { parseRpg, isFullyFreeSource } from '../rpg/parser';
import { CopyResolver } from '../rpg/navigation';
import { MEMBER_SCHEME } from './fileSystems';
import { spoolUri } from './spool';
import { showReport } from './reportPanel';

type Row = Record<string, unknown>;
const s = (r: Row | undefined, k: string) => String(r?.[k] ?? '').trim();
const progress = <T>(title: string, fn: () => Promise<T>) => vscode.window.withProgress({ location: vscode.ProgressLocation.Window, title }, fn);

// ================================================================ data structure layout

function libraryList(conn: IbmiConnection, uri?: vscode.Uri): string[] {
  const own = uri?.scheme === MEMBER_SCHEME ? parseMemberPath(uri.path).library : undefined;
  return [...new Set([own, conn.profile.currentLibrary, ...(conn.profile.libraries ?? [])].filter(Boolean).map(x => x!.toUpperCase()))];
}

async function externalColumns(manager: ConnectionManager, text: string, uri?: vscode.Uri): Promise<Record<string, ExtColumn[]>> {
  const conn = manager.connection; const files = externalFiles(text); const out: Record<string, ExtColumn[]> = {};
  if (!conn || !files.length) { return out; }
  const alias = /\bALIAS\b/i.test(text);
  for (const f of files.slice(0, 20)) {
    const fixed = externalLibrary(text, f);
    const libs = fixed ? [fixed] : libraryList(conn, uri);
    if (!libs.length) { continue; }
    try {
      const rows = await conn.rows<Row>(`SELECT SYSTEM_TABLE_SCHEMA AS L, ${alias ? 'COLUMN_NAME' : 'SYSTEM_COLUMN_NAME'} AS N, DATA_TYPE AS T, LENGTH AS LEN, COALESCE(NUMERIC_SCALE, 0) AS SC ` +
        `FROM QSYS2.SYSCOLUMNS WHERE SYSTEM_TABLE_NAME = ${sqlString(f)} AND SYSTEM_TABLE_SCHEMA IN (${libs.map(sqlString).join(', ')}) ORDER BY ORDINAL_POSITION`, 5000);
      const lib = libs.find(l => rows.some(r => s(r, 'L') === l));
      if (lib) { out[f] = rows.filter(r => s(r, 'L') === lib).map(r => ({ name: s(r, 'N'), dataType: s(r, 'T'), length: Number(r.LEN), scale: Number(r.SC) })); }
    } catch (e) { logError(e); }
  }
  return out;
}

const fmt = (n: number | undefined) => (n === undefined ? '?' : n);

function layoutReport(uri: vscode.Uri, d: DsLayout, others: DsLayout[]): void {
  const md = [`| Field | Type | From | To | Length |`, `|---|---|---:|---:|---:|`, ...d.fields.map(f => `| ${f.name} | ${f.type}${f.dim ? ` dim(${f.dim})` : ''} | ${fmt(f.from)} | ${fmt(f.to)} | ${fmt(f.length)} |`)].join('\n');
  showReport('dsLayout', {
    title: vscode.l10n.t('Layout of {0}', d.name),
    subtitle: `${uri.path.split('/').slice(-1)[0]} · ${vscode.l10n.t('line {0}', d.line + 1)}`,
    facts: [[vscode.l10n.t('Length'), d.length === undefined ? '?' : vscode.l10n.t('{0} bytes', d.length)], [vscode.l10n.t('Subfields'), d.fields.length], [vscode.l10n.t('Qualified'), d.qualified ? vscode.l10n.t('Yes') : vscode.l10n.t('No')],
      ...(d.dim ? [[vscode.l10n.t('Elements (DIM)'), d.dim] as [string, number]] : []), ...(d.external ? [[vscode.l10n.t('External file'), d.external] as [string, string]] : [])],
    actions: [{ label: vscode.l10n.t('Copy as a Markdown table'), command: 'vanthrex.dsLayout.copy', args: [md] },
      ...others.filter(o => o !== d).slice(0, 12).map(o => ({ label: o.name, command: 'vanthrex.dsLayout', args: [uri.toString(), o.line] }))],
    tables: [{
      title: vscode.l10n.t('Subfields'), filter: d.fields.length > 15,
      columns: [vscode.l10n.t('Field'), vscode.l10n.t('Type'), vscode.l10n.t('From'), vscode.l10n.t('To'), vscode.l10n.t('Length'), vscode.l10n.t('Note')],
      rows: d.fields.map(f => [f.name, `${f.type}${f.dim ? ` dim(${f.dim})` : ''}`, fmt(f.from), fmt(f.to), fmt(f.length), [f.overlay ? `overlay(${f.overlay})` : '', f.note ?? ''].filter(Boolean).join(' · ')]),
      rowClass: d.fields.map(f => (f.length === undefined ? 'bad' : f.overlay ? 'different' : undefined)),
      rowActions: d.fields.map(f => ({ label: vscode.l10n.t('Go to line'), command: 'vanthrex.v22.gotoLine', args: [uri.toString(), f.line] })),
      empty: vscode.l10n.t('No subfields.'),
    }],
    note: d.problems.join(' ') || vscode.l10n.t('Positions are 1-based, lengths in bytes (arrays: all elements). Click a row to go to its definition.'),
  }, new Set(['vanthrex.dsLayout', 'vanthrex.dsLayout.copy', 'vanthrex.v22.gotoLine']));
}

async function dsLayout(manager: ConnectionManager, uriArg?: string, lineArg?: number): Promise<void> {
  const ed = vscode.window.activeTextEditor;
  const uri = uriArg ? vscode.Uri.parse(uriArg) : ed?.document.uri;
  if (!uri) { throw new Error(vscode.l10n.t('Open an RPG source first.')); }
  const doc = await vscode.workspace.openTextDocument(uri);
  if (doc.languageId !== 'rpgle') { throw new Error(vscode.l10n.t('Open an RPG source first.')); }
  const text = doc.getText();
  const ext = await progress(vscode.l10n.t('Reading external field definitions…'), () => externalColumns(manager, text, uri));
  const all = dataStructures(text, ext);
  if (!all.length) { vscode.window.showInformationMessage(vscode.l10n.t('No data structures in this source.')); return; }
  const line = lineArg ?? ed?.selection.active.line ?? -1;
  let d = all.find(x => line >= x.line && line <= x.endLine);
  if (!d) {
    const p = await vscode.window.showQuickPick(all.map(x => ({ x, label: x.name, description: `${x.length === undefined ? '?' : x.length} bytes · ${x.fields.length} subfields`, detail: vscode.l10n.t('line {0}', x.line + 1) })), { title: vscode.l10n.t('Which data structure?') });
    if (!p) { return; }
    d = p.x;
  }
  layoutReport(uri, d, all);
}

/** Hover on a subfield or DS definition line: position, length and type. */
class LayoutHover implements vscode.HoverProvider {
  private cache?: { key: string; all: DsLayout[] };
  provideHover(doc: vscode.TextDocument, pos: vscode.Position): vscode.Hover | undefined {
    if (!vscode.workspace.getConfiguration('vanthrex').get<boolean>('dsLayout.hover', true)) { return undefined; }
    const key = `${doc.uri}@${doc.version}`;
    if (this.cache?.key !== key) { try { this.cache = { key, all: dataStructures(doc.getText()) }; } catch { return undefined; } }
    const range = doc.getWordRangeAtPosition(pos, /[A-Za-z0-9$#@_]+/);
    if (!range) { return undefined; }
    const word = doc.getText(range).toUpperCase();
    for (const d of this.cache.all) {
      if (pos.line < d.line || pos.line > d.endLine) { continue; }
      if (d.name.toUpperCase() === word && pos.line === d.line) {
        const ms = new vscode.MarkdownString(`**${d.name}** — ${vscode.l10n.t('{0} bytes, {1} subfields', fmt(d.length), d.fields.length)}  \n[$(table) ${vscode.l10n.t('Show the layout')}](command:vanthrex.dsLayout?${encodeURIComponent(JSON.stringify([doc.uri.toString(), d.line]))})`, true);
        ms.isTrusted = { enabledCommands: ['vanthrex.dsLayout'] };
        return new vscode.Hover(ms, range);
      }
      const f = d.fields.find(x => x.line === pos.line && x.name.toUpperCase() === word);
      if (f) {
        const m = new vscode.MarkdownString(`\`${f.name}\` ${f.type}${f.dim ? ` dim(${f.dim})` : ''}  \n${vscode.l10n.t('Positions {0}–{1} of {2}, {3} bytes', fmt(f.from), fmt(f.to), d.name, fmt(f.length))}`);
        return new vscode.Hover(m, range);
      }
    }
    return undefined;
  }
}

// ================================================================ expanded /COPY view

async function expandCopies(manager: ConnectionManager): Promise<void> {
  const ed = vscode.window.activeTextEditor;
  if (!ed || ed.document.languageId !== 'rpgle') { throw new Error(vscode.l10n.t('Open an RPG source first.')); }
  manager.require();
  const resolver = new CopyResolver(manager);
  let count = 0; const missing: string[] = [];
  const expand = async (uri: vscode.Uri, text: string, depth: number, seen: Set<string>): Promise<string> => {
    const parse = parseRpg(text);
    if (!parse.copies.length) { return text; }
    const parts = new Map<number, { target: string; text: string | null }>();
    for (const c of parse.copies) {
      let body: string | null = null;
      try {
        const u = await resolver.resolve({ uri } as vscode.TextDocument, c);
        const k = u?.toString().toUpperCase();
        if (u && k && seen.has(k)) { body = `// (${c.target} is already included above: not repeated)`; }
        else if (u && depth < 6) {
          const t = Buffer.from(await vscode.workspace.fs.readFile(u)).toString('utf8');
          body = await expand(u, t, depth + 1, new Set([...seen, k!])); count++;
        }
      } catch { body = null; }
      if (body === null) { missing.push(c.target); }
      parts.set(c.line, { target: c.target, text: body });
    }
    return mergeIncludes(text, parts, isFullyFreeSource(text));
  };
  const out = await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: vscode.l10n.t('Expanding /COPY and /INCLUDE…') },
    () => expand(ed.document.uri, ed.document.getText(), 0, new Set([ed.document.uri.toString().toUpperCase()])));
  if (!count && !missing.length) { vscode.window.showInformationMessage(vscode.l10n.t('This source has no /COPY or /INCLUDE.')); return; }
  const doc = await vscode.workspace.openTextDocument({ content: out, language: 'rpgle' });
  await vscode.window.showTextDocument(doc, { viewColumn: vscode.ViewColumn.Beside, preview: true });
  vscode.window.setStatusBarMessage(missing.length ? vscode.l10n.t('{0} included, not found: {1}', count, [...new Set(missing)].join(', ')) : vscode.l10n.t('{0} member(s) included — read-only copy, not saved anywhere.', count), 8000);
}

// ================================================================ service program signatures

const SIG_ALLOWED = new Set(['vanthrex.signatureCheck', 'vanthrex.signatureCheck.rebind', 'vanthrex.signatureCheck.rebindAll']);
interface Bound { lib: string; name: string; type: string; srvLib: string; srv: string }

async function signatureCheck(manager: ConnectionManager, a?: unknown, scopeArg?: string): Promise<void> {
  const conn = manager.require();
  const n = a as { library?: string; name?: string } | string | undefined;
  let lib = typeof n === 'object' ? n?.library?.toUpperCase() : undefined; let srv = typeof n === 'object' ? n?.name?.toUpperCase() : undefined;
  if (typeof n === 'string' && n.includes('/')) { [lib, srv] = n.toUpperCase().split('/'); }
  if (!srv) {
    const v = (await vscode.window.showInputBox({ title: vscode.l10n.t('Check service program signatures'), prompt: 'LIBRARY/SRVPGM', ignoreFocusOut: true, validateInput: x => (/^[A-Z$#@][A-Z0-9$#@_.]{0,9}\/[A-Z$#@][A-Z0-9$#@_.]{0,9}$/i.test(x.trim()) ? undefined : 'LIBRARY/SRVPGM') }))?.trim().toUpperCase();
    if (!v) { return; }
    [lib, srv] = v.split('/');
  }
  let scope = scopeArg;
  if (!scope) {
    const p = await vscode.window.showQuickPick([
      { label: vscode.l10n.t('$(library) Library list and {0}', lib!), k: 'libl' },
      { label: vscode.l10n.t('$(globe) All libraries'), description: vscode.l10n.t('can take a few minutes'), k: 'all' },
    ], { title: vscode.l10n.t('Look for programs bound to {0}/{1} in…', lib!, srv!) });
    if (!p) { return; }
    scope = p.k;
  }
  const libs = [...new Set([lib!, ...libraryList(conn)])];
  const [info, bound] = await progress(vscode.l10n.t('Checking who is bound to {0}…', srv!), () => Promise.all([
    conn.rows<Row>(`SELECT HEX(CAST(SUBSTR(EXPORT_SIGNATURES, 1, 3400) AS VARBINARY(3400))) AS SIGS FROM QSYS2.PROGRAM_INFO WHERE PROGRAM_LIBRARY = ${sqlString(lib!)} AND PROGRAM_NAME = ${sqlString(srv!)} AND OBJECT_TYPE = '*SRVPGM'`, 1),
    conn.rows<Row>(`SELECT PROGRAM_LIBRARY AS L, PROGRAM_NAME AS N, OBJECT_TYPE AS T, BOUND_SERVICE_PROGRAM_LIBRARY AS BL, HEX(BOUND_SERVICE_PROGRAM_SIGNATURE) AS SIG ` +
      `FROM QSYS2.BOUND_SRVPGM_INFO WHERE BOUND_SERVICE_PROGRAM = ${sqlString(srv!)} AND BOUND_SERVICE_PROGRAM_LIBRARY IN (${sqlString(lib!)}, '*LIBL')` +
      (scope === 'all' ? '' : ` AND PROGRAM_LIBRARY IN (${libs.map(sqlString).join(', ')})`) + ' ORDER BY PROGRAM_LIBRARY, PROGRAM_NAME', 20000),
  ]).catch(e => { throw new Error(vscode.l10n.t('The signature check needs QSYS2.PROGRAM_INFO and QSYS2.BOUND_SRVPGM_INFO (IBM i 7.3 or later with a recent Db2 PTF group): {0}', errorMessage(e).split('\n')[0])); }));
  if (!info.length) { throw new Error(vscode.l10n.t('{0}/{1} is not a service program.', lib!, srv!)); }
  const sigs = splitSignatures(s(info[0], 'SIGS'));
  const list = bound.map(r => ({ b: { lib: s(r, 'L'), name: s(r, 'N'), type: s(r, 'T'), srvLib: s(r, 'BL') || lib!, srv: srv! } as Bound, state: signatureState(s(r, 'SIG'), sigs), sig: s(r, 'SIG') }))
    .sort((x, y) => ['mismatch', 'unknown', 'older', 'current'].indexOf(x.state) - ['mismatch', 'unknown', 'older', 'current'].indexOf(y.state));
  const bad = list.filter(x => x.state === 'mismatch');
  const label = { current: vscode.l10n.t('OK — current signature'), older: vscode.l10n.t('OK — older signature still exported'), mismatch: vscode.l10n.t('Signature violation: fails when called'), unknown: vscode.l10n.t('Unknown') };
  showReport('signatureCheck', {
    title: vscode.l10n.t('Signatures of {0}/{1}', lib!, srv!),
    subtitle: bad.length ? vscode.l10n.t('{0} of {1} bound object(s) would fail with a signature violation.', bad.length, list.length) : vscode.l10n.t('All {0} bound object(s) are fine.', list.length),
    facts: [[vscode.l10n.t('Current signature'), sigs[0] ?? '?'], [vscode.l10n.t('Valid signatures'), sigs.length], [vscode.l10n.t('Bound objects'), list.length], [vscode.l10n.t('Searched'), scope === 'all' ? vscode.l10n.t('All libraries') : libs.join(' ')]],
    actions: [{ label: vscode.l10n.t('Refresh'), command: 'vanthrex.signatureCheck', args: [`${lib}/${srv}`, scope] },
      ...(bad.length ? [{ label: vscode.l10n.t('Re-bind all {0} failing object(s)…', bad.length), command: 'vanthrex.signatureCheck.rebindAll', args: [bad.map(x => x.b), `${lib}/${srv}`, scope] }] : [])],
    tables: [
      { title: vscode.l10n.t('Bound programs and service programs'), filter: list.length > 20, columns: [vscode.l10n.t('Object'), vscode.l10n.t('Type'), vscode.l10n.t('Bound to'), vscode.l10n.t('State')],
        rows: list.map(x => [`${x.b.lib}/${x.b.name}`, x.b.type, `${x.b.srvLib}/${srv}`, label[x.state]]),
        rowClass: list.map(x => (x.state === 'mismatch' ? 'bad' : x.state === 'older' ? 'different' : undefined)),
        rowActions: list.map(x => (x.state === 'mismatch' || x.state === 'older' ? { label: vscode.l10n.t('Re-bind…'), command: 'vanthrex.signatureCheck.rebind', args: [x.b, `${lib}/${srv}`, scope] } : undefined)),
        empty: vscode.l10n.t('Nothing is bound to this service program in the libraries searched.') },
      { title: vscode.l10n.t('Signatures exported'), columns: ['#', vscode.l10n.t('Signature')], rows: sigs.map((x, i) => [i === 0 ? vscode.l10n.t('1 (current)') : String(i + 1), x]) },
    ],
    note: vscode.l10n.t('Re-binding runs UPDPGM / UPDSRVPGM with MODULE(*NONE): no module changes, the object just picks up the current signature. Recompile instead when procedures were removed or their parameters changed.'),
  }, SIG_ALLOWED);
}

async function rebind(manager: ConnectionManager, items: Bound[], again: [string, string]): Promise<void> {
  const conn = manager.require();
  const cmds = items.map(b => rebindCommand(b.type, b.lib, b.name, b.srvLib, b.srv));
  const yes = vscode.l10n.t('Re-bind');
  if (await vscode.window.showWarningMessage(items.length === 1 ? vscode.l10n.t('Re-bind {0}/{1}?', items[0].lib, items[0].name) : vscode.l10n.t('Re-bind {0} objects?', items.length),
    { modal: true, detail: cmds.slice(0, 15).join('\n') + (cmds.length > 15 ? '\n…' : '') }, yes) !== yes) { return; }
  const failed: string[] = [];
  await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: vscode.l10n.t('Re-binding…'), cancellable: true }, async (p, tok) => {
    for (let i = 0; i < cmds.length && !tok.isCancellationRequested; i++) {
      p.report({ message: `${items[i].lib}/${items[i].name}`, increment: 100 / cmds.length });
      try { const r = await conn.runCL(cmds[i]); if (!r.ok) { failed.push(`${items[i].lib}/${items[i].name}: ${(r.stderr || r.stdout).trim().split('\n').pop()}`); } } catch (e) { failed.push(`${items[i].lib}/${items[i].name}: ${errorMessage(e)}`); }
    }
  });
  if (failed.length) { vscode.window.showErrorMessage(vscode.l10n.t('{0} could not be re-bound.', failed.length), { modal: true, detail: failed.join('\n') }); }
  else { vscode.window.setStatusBarMessage(vscode.l10n.t('✓ Re-bound {0} object(s)', cmds.length), 5000); }
  await signatureCheck(manager, again[0], again[1]);
}

// ================================================================ failed jobs

const FAILED_ALLOWED = new Set(['vanthrex.failedJobs', 'vanthrex.failedJobs.row']);

async function failedJobsReport(manager: ConnectionManager, hoursArg?: number, minArg?: number): Promise<void> {
  const conn = manager.require();
  let hours = hoursArg; let min = minArg ?? 20;
  if (!hours) {
    const p = await vscode.window.showQuickPick([
      { label: vscode.l10n.t('Last hour'), h: 1 }, { label: vscode.l10n.t('Last 8 hours'), h: 8 }, { label: vscode.l10n.t('Last 24 hours'), h: 24 }, { label: vscode.l10n.t('Last 3 days'), h: 72 }, { label: vscode.l10n.t('Last 7 days'), h: 168 },
    ], { title: vscode.l10n.t('Jobs that ended abnormally — since when?') });
    if (!p) { return; }
    hours = p.h;
  }
  const rows = await progress(vscode.l10n.t('Reading the history log…'), () => conn.rows<Row>(
    `SELECT VARCHAR_FORMAT(MESSAGE_TIMESTAMP, 'YYYY-MM-DD HH24:MI:SS') AS TS, COALESCE(FROM_JOB, '') AS J, COALESCE(MESSAGE_TEXT, '') AS T ` +
    `FROM TABLE(QSYS2.HISTORY_LOG_INFO(START_TIME => CURRENT TIMESTAMP - ${Math.floor(hours!)} HOURS)) X ` +
    `WHERE MESSAGE_ID = 'CPF1164' AND RTRIM(MESSAGE_TEXT) NOT LIKE '% 0 .' AND RTRIM(MESSAGE_TEXT) NOT LIKE '% 0.' ORDER BY MESSAGE_TIMESTAMP DESC`, 20000));
  const jobs = failedJobs(rows.map(r => ({ at: s(r, 'TS'), text: s(r, 'T'), fromJob: s(r, 'J') })), min);
  const byName = failuresByName(jobs);
  showReport('failedJobs', {
    title: vscode.l10n.t('Failed jobs — {0}', conn.profile.name),
    subtitle: vscode.l10n.t('{0} job(s) ended with end code {1} or higher in the last {2} hour(s).', jobs.length, min, hours!),
    facts: [[vscode.l10n.t('Failed jobs'), jobs.length], [vscode.l10n.t('Different job names'), byName.length], [vscode.l10n.t('Most failures'), byName[0] ? `${byName[0].name} (${byName[0].count})` : '—']],
    actions: [{ label: vscode.l10n.t('Refresh'), command: 'vanthrex.failedJobs', args: [hours, min] },
      min > 10 ? { label: vscode.l10n.t('Include end code 10 (controlled end)'), command: 'vanthrex.failedJobs', args: [hours, 10] } : { label: vscode.l10n.t('Only real failures (20+)'), command: 'vanthrex.failedJobs', args: [hours, 20] },
      ...[1, 24, 168].filter(h => h !== hours).map(h => ({ label: h === 1 ? vscode.l10n.t('Last hour') : h === 24 ? vscode.l10n.t('Last 24 hours') : vscode.l10n.t('Last 7 days'), command: 'vanthrex.failedJobs', args: [h, min] }))],
    tables: [
      { title: vscode.l10n.t('Jobs'), filter: jobs.length > 15, columns: [vscode.l10n.t('Ended'), vscode.l10n.t('Job'), vscode.l10n.t('User'), vscode.l10n.t('End code'), vscode.l10n.t('Meaning')],
        rows: jobs.map(j => [j.at, j.job, j.user, j.code ?? '?', endCodeMeaning(j.code)]), rowClass: jobs.map(j => ((j.code ?? 99) >= 20 ? 'bad' : undefined)),
        rowActions: jobs.map(j => ({ label: vscode.l10n.t('Job log…'), command: 'vanthrex.failedJobs.row', args: [j.job] })), empty: vscode.l10n.t('No job failed in this period.') },
      { title: vscode.l10n.t('By job name'), columns: [vscode.l10n.t('Job name'), vscode.l10n.t('Failures'), vscode.l10n.t('Last'), vscode.l10n.t('End codes')], rows: byName.map(b => [b.name, b.count, b.last, b.codes]) },
    ],
    note: vscode.l10n.t('From the CPF1164 messages in the history log (QHST). Click a job to open its job log.'),
  }, FAILED_ALLOWED);
}

async function failedJobRow(manager: ConnectionManager, job: string): Promise<void> {
  const conn = manager.require();
  const spools = await conn.rows<Row>(`SELECT FILE_NUMBER AS N FROM QSYS2.OUTPUT_QUEUE_ENTRIES_BASIC WHERE JOB_NAME = ${sqlString(job)} AND SPOOLED_FILE_NAME = 'QPJOBLOG' ORDER BY FILE_NUMBER DESC`, 1).catch(() => [] as Row[]);
  const o = await vscode.window.showQuickPick([
    { label: vscode.l10n.t('$(output) Open the job log'), description: spools.length ? 'QPJOBLOG' : vscode.l10n.t('pending job log'), k: 'log' },
    { label: vscode.l10n.t('$(list-unordered) All spooled files of the job'), k: 'spool' },
    ...(vscode.workspace.getConfiguration('vanthrex').get<boolean>('ai.enabled', true) ? [{ label: vscode.l10n.t('$(sparkle) Ask AI why it failed and how to fix it'), description: vscode.l10n.t('job log + failing source statement'), k: 'ai' }] : []),
    { label: vscode.l10n.t('$(copy) Copy the job name'), k: 'copy' },
  ], { title: job });
  if (o?.k === 'ai') { await vscode.commands.executeCommand('vanthrex.ai.jobLog', job); return; }
  if (!o) { return; }
  if (o.k === 'copy') { await vscode.env.clipboard.writeText(job); return; }
  if (o.k === 'log') {
    if (spools.length) { await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(spoolUri({ job, name: 'QPJOBLOG', number: Number(spools[0].N) })), { preview: true }); }
    else { await vscode.commands.executeCommand('vanthrex.jobLog', { job }); }
    return;
  }
  const all = await conn.rows<Row>(`SELECT SPOOLED_FILE_NAME AS F, FILE_NUMBER AS N, TOTAL_PAGES AS P, COALESCE(USER_DATA, '') AS UD FROM QSYS2.OUTPUT_QUEUE_ENTRIES_BASIC WHERE JOB_NAME = ${sqlString(job)} ORDER BY FILE_NUMBER`, 500);
  if (!all.length) { vscode.window.showInformationMessage(vscode.l10n.t('{0} has no spooled files left.', job)); return; }
  const p = await vscode.window.showQuickPick(all.map(r => ({ r, label: s(r, 'F'), description: `#${s(r, 'N')} · ${s(r, 'P')} p · ${s(r, 'UD')}` })), { title: job });
  if (p) { await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(spoolUri({ job, name: s(p.r, 'F'), number: Number(p.r.N) })), { preview: true }); }
}

// ================================================================ registration

export function registerV29(context: vscode.ExtensionContext, manager: ConnectionManager): void {
  const guard = <A extends unknown[]>(fn: (...a: A) => Promise<unknown>) => async (...a: A) => {
    try { await fn(...a); } catch (e) { logError(e); vscode.window.showErrorMessage(errorMessage(e)); }
  };
  context.subscriptions.push(
    vscode.languages.registerHoverProvider({ language: 'rpgle' }, new LayoutHover()),
    vscode.commands.registerCommand('vanthrex.dsLayout', guard((uri?: string, line?: number) => dsLayout(manager, typeof uri === 'string' ? uri : undefined, typeof line === 'number' ? line : undefined))),
    vscode.commands.registerCommand('vanthrex.dsLayout.copy', guard(async (md: string) => { await vscode.env.clipboard.writeText(md); vscode.window.setStatusBarMessage(vscode.l10n.t('✓ Copied'), 3000); })),
    vscode.commands.registerCommand('vanthrex.expandCopies', guard(() => expandCopies(manager))),
    vscode.commands.registerCommand('vanthrex.signatureCheck', guard((a?: unknown, scope?: string) => signatureCheck(manager, a, scope))),
    vscode.commands.registerCommand('vanthrex.signatureCheck.rebind', guard((b: Bound, srv: string, scope: string) => rebind(manager, [b], [srv, scope]))),
    vscode.commands.registerCommand('vanthrex.signatureCheck.rebindAll', guard((b: Bound[], srv: string, scope: string) => rebind(manager, b, [srv, scope]))),
    vscode.commands.registerCommand('vanthrex.failedJobs', guard((h?: number, m?: number) => failedJobsReport(manager, typeof h === 'number' ? h : undefined, typeof m === 'number' ? m : undefined))),
    vscode.commands.registerCommand('vanthrex.failedJobs.row', guard((job: string) => failedJobRow(manager, job))),
  );
}
