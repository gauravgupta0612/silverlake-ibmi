// Source analysis: unused code, hard-coded libraries, indicator usage, the source quality report, data structure layout
// and the expanded /COPY view.
import * as vscode from 'vscode';
import { IbmiConnection } from '../core/connection';
import { dataStructures, DsLayout, ExtColumn, externalFiles, externalLibrary } from '../core/dataStructures';
import { mergeIncludes } from '../core/includes';
import { errorMessage, log, logError } from '../core/log';
import { ConnectionManager } from '../core/manager';
import {
  DEFAULT_ALLOWED_LIBRARIES, findHardcodedLibraries, grade, indicatorProblems, indicatorUsage, isRpgType, sourceHealth, SourceHealth,
  unusedRpg,
} from '../core/sourceAnalysis';
import { parseMemberPath, sqlString } from '../core/util';
import { CopyResolver } from '../rpg/navigation';
import { isFullyFreeSource, parseRpg } from '../rpg/parser';
import { MEMBER_SCHEME, memberUri } from './fileSystems';
import { showReport } from './reportPanel';

/** Commands the report pages may run (anything else posted by a webview is ignored). */
const ALLOWED = new Set([
  'vanthrex.unusedCode', 'vanthrex.hardcodedLibraries', 'vanthrex.codeMetrics.open', 'vanthrex.gotoLine', 'vanthrex.indicatorUsage',
  'vanthrex.compileHistory.open', 'vanthrex.sourceQuality',
]);

type Row = Record<string, unknown>;

const s = (r: Row | undefined, k: string) => String(r?.[k] ?? '').trim();

async function unusedCode(): Promise<void> {
  const ed = vscode.window.activeTextEditor;
  if (!ed) { throw new Error(vscode.l10n.t('Open an RPG source first.')); }
  const items = unusedRpg(ed.document.getText());
  const name = ed.document.uri.scheme === MEMBER_SCHEME ? parseMemberPath(ed.document.uri.path).member : ed.document.fileName.split(/[\\/]/).pop();
  showReport('unused', {
    title: vscode.l10n.t('Unused code — {0}', String(name)), subtitle: items.length ? `${items.length} definition(s) nothing refers to in this source. Click one to go to it.` : 'Everything defined in this source is used.',
    tables: [{ title: vscode.l10n.t('Unused definitions'), columns: ['Name', 'Kind', 'Line'], rows: items.map(i => [i.name, i.kind, i.line + 1]),
      rowActions: items.map(i => ({ label: 'Go to', command: 'vanthrex.gotoLine', args: [ed.document.uri.toString(), i.line] })), empty: vscode.l10n.t('None.') }],
    note: vscode.l10n.t('Only this source is checked: exported procedures are skipped, and something used only through a /COPY member or by another program can still show here. Removing dead code makes programs easier to read and to modernize.'),
  }, ALLOWED);
}

async function hardcodedLibraries(manager: ConnectionManager, n?: { library?: string; file?: string }): Promise<void> {
  const conn = manager.require();
  const allowed = [...DEFAULT_ALLOWED_LIBRARIES, ...vscode.workspace.getConfiguration('vanthrex').get<string[]>('scan.allowedLibraries', [])];
  if (!n?.library || !n.file) {
    const ed = vscode.window.activeTextEditor;
    if (!ed) { throw new Error(vscode.l10n.t('Open a source, or right-click a source file.')); }
    const hits = findHardcodedLibraries(ed.document.getText(), allowed);
    showReport('hardcoded', {
      title: vscode.l10n.t('Hard-coded libraries'), subtitle: vscode.l10n.t('{0} place(s) in this source name a library explicitly.', hits.length),
      tables: [{ title: vscode.l10n.t('Places'), columns: ['Line', 'Library', 'Object', 'Code'], rows: hits.map(h => [h.line + 1, h.library, h.object, h.text]),
        rowActions: hits.map(h => ({ label: 'Go to', command: 'vanthrex.gotoLine', args: [ed.document.uri.toString(), h.line] })), empty: vscode.l10n.t('None.') }],
    }, ALLOWED);
    return;
  }
  const members = await conn.rows<Row>(`SELECT SYSTEM_TABLE_MEMBER AS M, COALESCE(SOURCE_TYPE, '') AS T FROM QSYS2.SYSPARTITIONSTAT WHERE SYSTEM_TABLE_SCHEMA = ${sqlString(n.library)} AND SYSTEM_TABLE_NAME = ${sqlString(n.file)} ORDER BY 1`, 5000);
  const hits: (ReturnType<typeof findHardcodedLibraries>[number] & { member: string; type: string })[] = [];
  await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: vscode.l10n.t('Scanning {0}/{1}…', n.library, n.file), cancellable: true }, async (p, token) => {
    for (const m of members.slice(0, 1000)) {
      if (token.isCancellationRequested) { break; }
      p.report({ message: s(m, 'M'), increment: 100 / Math.min(1000, members.length) });
      try { findHardcodedLibraries(await conn.readMember(n.library!, n.file!, s(m, 'M')), allowed).forEach(h => hits.push({ ...h, member: s(m, 'M'), type: s(m, 'T') })); } catch (e) { log(`Scan ${s(m, 'M')}: ${errorMessage(e)}`); }
    }
  });
  const byLib = new Map<string, number>(); hits.forEach(h => byLib.set(h.library, (byLib.get(h.library) ?? 0) + 1));
  showReport('hardcoded', {
    title: vscode.l10n.t('Hard-coded libraries — {0}/{1}', n.library, n.file),
    subtitle: vscode.l10n.t('{0} place(s) in {1} member(s) name a library explicitly. These break when code moves from DEV to TEST to PROD.', hits.length, new Set(hits.map(h => h.member)).size),
    facts: [...byLib.entries()].sort((x, y) => y[1] - x[1]).slice(0, 10).map(([l, c]) => [l, c] as [string, number]),
    tables: [{ title: vscode.l10n.t('Places'), filter: true, columns: ['Member', 'Line', 'Library', 'Object', 'Code'], rows: hits.map(h => [h.member, h.line + 1, h.library, h.object, h.text]),
      rowActions: hits.map(h => ({ label: vscode.l10n.t('Open'), command: 'vanthrex.codeMetrics.open', args: [n.library, n.file, h.member, h.type || 'mbr'] })), empty: vscode.l10n.t('None — good.') }],
    note: vscode.l10n.t('IBM libraries (QSYS2, SYSTOOLS…) and QTEMP are ignored; add your own shared libraries to vanthrex.scan.allowedLibraries. Use the library list (*LIBL) or a variable instead.'),
  }, ALLOWED);
}

async function indicatorUsageCmd(): Promise<void> {
  const ed = vscode.window.activeTextEditor;
  if (!ed) { throw new Error(vscode.l10n.t('Open an RPG or DDS source first.')); }
  const u = indicatorUsage(ed.document.getText());
  const problems = indicatorProblems(u);
  const name = ed.document.uri.scheme === MEMBER_SCHEME ? parseMemberPath(ed.document.uri.path).member : ed.document.fileName.split(/[\\/]/).pop();
  const lines = (a: number[]) => a.slice(0, 15).map(l => l + 1).join(', ') + (a.length > 15 ? ` … (+${a.length - 15})` : '');
  showReport('indicators', {
    title: vscode.l10n.t('Indicators — {0}', String(name)), subtitle: vscode.l10n.t('{0} indicator(s) used; {1} look suspicious. Click one to go to its first use.', u.length, problems.length),
    tables: [
      { title: vscode.l10n.t('Indicators'), columns: ['Indicator', 'Set on lines', 'Tested on lines'], rows: u.map(x => [x.indicator, lines(x.set), lines(x.tested)]),
        rowActions: u.map(x => ({ label: 'Go to', command: 'vanthrex.gotoLine', args: [ed.document.uri.toString(), Math.min(...x.set, ...x.tested)] })), empty: vscode.l10n.t('No numbered indicators — nice.') },
      { title: vscode.l10n.t('Suspicious'), columns: ['Indicator', 'Why'], rows: problems.map(p => [p.indicator, p.problem]), empty: vscode.l10n.t('None.') },
    ],
    note: vscode.l10n.t('Indicators set by a display file (CA03, SFLEND…) and tested in the program show as "tested but never set here" in the program — compare with the display file. Named indicators (dcl-s x ind) are easier to read.'),
  }, ALLOWED);
}

async function sourceQuality(manager: ConnectionManager, a?: unknown): Promise<void> {
  const conn = manager.require();
  const n = a as { library?: string; file?: string } | undefined;
  let lib = n?.library?.toUpperCase(); let file = n?.file?.toUpperCase();
  if (!lib || !file) {
    const v = await vscode.window.showInputBox({ title: vscode.l10n.t('Source quality report'), prompt: 'LIBRARY/FILE', placeHolder: 'MYLIB/QRPGLESRC', ignoreFocusOut: true });
    if (!v?.includes('/')) { return; }
    [lib, file] = v.trim().toUpperCase().split('/');
  }
  const members = (await conn.rows<Row>(`SELECT SYSTEM_TABLE_MEMBER AS M, COALESCE(SOURCE_TYPE, '') AS T, COALESCE(PARTITION_TEXT, '') AS X FROM QSYS2.SYSPARTITIONSTAT ` +
    `WHERE SYSTEM_TABLE_SCHEMA = ${sqlString(lib)} AND SYSTEM_TABLE_NAME = ${sqlString(file)} ORDER BY 1`, 5000)).filter(r => isRpgType(s(r, 'T')));
  if (!members.length) { vscode.window.showInformationMessage(vscode.l10n.t('No RPG members in {0}/{1}.', lib, file)); return; }
  const results: { m: Row; h?: SourceHealth; error?: string }[] = [];
  await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: vscode.l10n.t('Checking {0} member(s)…', members.length), cancellable: true }, async (p, tok) => {
    let i = 0;
    const worker = async () => {
      while (i < members.length && !tok.isCancellationRequested) {
        const m = members[i++];
        p.report({ message: s(m, 'M'), increment: 100 / members.length });
        try { results.push({ m, h: sourceHealth(await conn.readMember(lib!, file!, s(m, 'M'))) }); } catch (e) { results.push({ m, error: errorMessage(e).split('\n')[0] }); }
      }
    };
    await Promise.all([worker(), worker(), worker()]);
  });
  const ok = results.filter(r => r.h).sort((x, y) => x.h!.score - y.h!.score);
  const avg = ok.length ? Math.round(ok.reduce((t, r) => t + r.h!.score, 0) / ok.length) : 0;
  const code = ok.reduce((t, r) => t + r.h!.code, 0); const fixed = ok.reduce((t, r) => t + r.h!.fixed, 0);
  const rules: Record<string, number> = {};
  for (const r of ok) { for (const [k, v] of Object.entries(r.h!.rules)) { rules[k] = (rules[k] ?? 0) + v; } }
  const grades = ['A', 'B', 'C', 'D', 'E'].map(g => `${g}: ${ok.filter(r => grade(r.h!.score) === g).length}`).join('  ');
  const open = (m: Row) => ({ label: vscode.l10n.t('Open'), command: 'vanthrex.compileHistory.open', args: [memberUri(lib!, file!, s(m, 'M'), s(m, 'T')).toString()] });
  showReport('sourceQuality', {
    title: vscode.l10n.t('Source quality — {0}/{1}', lib, file),
    subtitle: vscode.l10n.t('{0} RPG member(s) checked, average score {1} ({2}). Lowest scores first.', ok.length, avg, grade(avg)),
    facts: [[vscode.l10n.t('Grades'), grades], [vscode.l10n.t('Lines of code'), code.toLocaleString()], [vscode.l10n.t('Still in fixed format'), code ? `${Math.round(100 * fixed / code)}%` : '—'],
      [vscode.l10n.t('Code check findings'), ok.reduce((t, r) => t + r.h!.errors + r.h!.warnings + r.h!.infos, 0)], [vscode.l10n.t('GOTO / CABxx'), ok.reduce((t, r) => t + r.h!.gotos, 0)],
      [vscode.l10n.t('Not read'), results.length - ok.length]],
    tables: [
      { title: vscode.l10n.t('Members'), filter: true,
        columns: [vscode.l10n.t('Member'), vscode.l10n.t('Type'), vscode.l10n.t('Grade'), vscode.l10n.t('Score'), vscode.l10n.t('Code lines'), vscode.l10n.t('Fixed %'), vscode.l10n.t('Errors'), vscode.l10n.t('Warnings'), vscode.l10n.t('Indicators'), 'GOTO', vscode.l10n.t('Subroutines'), vscode.l10n.t('Procedures'), vscode.l10n.t('Text')],
        rows: ok.map(r => [s(r.m, 'M'), s(r.m, 'T'), grade(r.h!.score), r.h!.score, r.h!.code, r.h!.fixedPct, r.h!.errors, r.h!.warnings, r.h!.indicators, r.h!.gotos, r.h!.subroutines, r.h!.procedures, s(r.m, 'X')]),
        rowClass: ok.map(r => (r.h!.score < 40 ? 'bad' : r.h!.score < 60 ? 'different' : undefined)), rowActions: ok.map(r => open(r.m)) },
      { title: vscode.l10n.t('Most frequent code checks'), columns: [vscode.l10n.t('Check'), vscode.l10n.t('Findings')],
        rows: Object.entries(rules).sort((x, y) => y[1] - x[1]).map(([k, v]) => [k, v]), empty: vscode.l10n.t('No findings. 👍') },
      ...(results.some(r => r.error) ? [{ title: vscode.l10n.t('Could not be read'), columns: [vscode.l10n.t('Member'), vscode.l10n.t('Reason')], rows: results.filter(r => r.error).map(r => [s(r.m, 'M'), r.error!]) }] : []),
    ],
    note: vscode.l10n.t('Score: 100, minus errors, warnings per 1,000 lines, GOTOs, numbered indicators and the share of fixed format. A: 90+, B: 75+, C: 60+, D: 40+, E: below 40.'),
  }, ALLOWED);
}

const progress = <T>(title: string, fn: () => Promise<T>) => vscode.window.withProgress({ location: vscode.ProgressLocation.Window, title }, fn);

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
      rowActions: d.fields.map(f => ({ label: vscode.l10n.t('Go to line'), command: 'vanthrex.gotoLine', args: [uri.toString(), f.line] })),
      empty: vscode.l10n.t('No subfields.'),
    }],
    note: d.problems.join(' ') || vscode.l10n.t('Positions are 1-based, lengths in bytes (arrays: all elements). Click a row to go to its definition.'),
  }, new Set(['vanthrex.dsLayout', 'vanthrex.dsLayout.copy', 'vanthrex.gotoLine']));
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

// ================================================================ registration

export function registerSourceAnalysis(context: vscode.ExtensionContext, manager: ConnectionManager): void {
  const guard = <A extends unknown[]>(fn: (...a: A) => Promise<unknown>) => async (...a: A) => {
    try { await fn(...a); } catch (e) { logError(e); vscode.window.showErrorMessage(errorMessage(e)); }
  };
  context.subscriptions.push(
    vscode.commands.registerCommand('vanthrex.unusedCode', guard(() => unusedCode())),
    vscode.commands.registerCommand('vanthrex.hardcodedLibraries', guard((n?: { library?: string; file?: string }) => hardcodedLibraries(manager, n))),
    vscode.commands.registerCommand('vanthrex.gotoLine', guard(async (uri: string, line: number) => {
      const doc = await vscode.workspace.openTextDocument(vscode.Uri.parse(uri));
      await vscode.window.showTextDocument(doc, { viewColumn: vscode.ViewColumn.One, selection: new vscode.Range(line, 0, line, 0) });
    })),
    vscode.commands.registerCommand('vanthrex.indicatorUsage', guard(() => indicatorUsageCmd())),
    vscode.commands.registerCommand('vanthrex.sourceQuality', guard((a?: unknown) => sourceQuality(manager, a))),
    vscode.languages.registerHoverProvider({ language: 'rpgle' }, new LayoutHover()),
    vscode.commands.registerCommand('vanthrex.dsLayout', guard((uri?: string, line?: number) => dsLayout(manager, typeof uri === 'string' ? uri : undefined, typeof line === 'number' ? line : undefined))),
    vscode.commands.registerCommand('vanthrex.dsLayout.copy', guard(async (md: string) => { await vscode.env.clipboard.writeText(md); vscode.window.setStatusBarMessage(vscode.l10n.t('✓ Copied'), 3000); })),
    vscode.commands.registerCommand('vanthrex.expandCopies', guard(() => expandCopies(manager))),
  );
}
