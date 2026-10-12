import * as vscode from 'vscode';
import { ConnectionManager } from '../core/manager';
import { errorMessage, logError } from '../core/log';
import { assertSystemName, sqlString } from '../core/util';
import { ErdLink, ErdTable, inferLinks, layoutErd, toMermaid } from '../core/diagrams';
import { escapeHtml, nonce } from './webviewUtil';

type Row = Record<string, unknown>;
const s = (r: Row, k: string) => String(r[k] ?? '').trim();
const MAX_COLS = 12;

async function load(manager: ConnectionManager, lib: string): Promise<{ tables: ErdTable[]; links: ErdLink[] } | undefined> {
  const conn = manager.require();
  const all = await conn.rows<Row>(`SELECT SYSTEM_TABLE_NAME AS N, COALESCE(TABLE_TEXT, '') AS T, TABLE_TYPE AS TT FROM QSYS2.SYSTABLES ` +
    `WHERE SYSTEM_TABLE_SCHEMA = ${sqlString(lib)} AND TABLE_TYPE IN ('T', 'P') AND FILE_TYPE = 'D' ORDER BY SYSTEM_TABLE_NAME`, 5000);
  if (!all.length) { throw new Error(vscode.l10n.t('No tables or physical files in {0}.', lib)); }
  let names = all.map(r => s(r, 'N'));
  if (names.length > 40) {
    const pick = await vscode.window.showQuickPick(all.map(r => ({ label: s(r, 'N'), description: s(r, 'T'), picked: false })), {
      canPickMany: true, title: vscode.l10n.t('{0} has {1} tables — pick the ones to draw (up to 60)', lib, names.length), matchOnDescription: true });
    if (!pick?.length) { return undefined; }
    names = pick.slice(0, 60).map(p => p.label);
  }
  const inList = names.map(sqlString).join(', ');
  const [cols, pk, fk] = await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: vscode.l10n.t('Reading the database design of {0}…', lib) }, () => Promise.all([
    conn.rows<Row>(`SELECT SYSTEM_TABLE_NAME AS TBL, COLUMN_NAME AS C, DATA_TYPE AS DT, LENGTH AS L, COALESCE(NUMERIC_SCALE, 0) AS SC, IS_NULLABLE AS NL FROM QSYS2.SYSCOLUMNS ` +
      `WHERE SYSTEM_TABLE_SCHEMA = ${sqlString(lib)} AND SYSTEM_TABLE_NAME IN (${inList}) ORDER BY SYSTEM_TABLE_NAME, ORDINAL_POSITION`, 50000),
    conn.rows<Row>(`SELECT C.SYSTEM_TABLE_NAME AS TBL, K.COLUMN_NAME AS C FROM QSYS2.SYSCST C JOIN QSYS2.SYSKEYCST K ON K.CONSTRAINT_SCHEMA = C.CONSTRAINT_SCHEMA AND K.CONSTRAINT_NAME = C.CONSTRAINT_NAME ` +
      `WHERE C.SYSTEM_TABLE_SCHEMA = ${sqlString(lib)} AND C.CONSTRAINT_TYPE = 'PRIMARY KEY'`, 10000).catch(() => []),
    conn.rows<Row>(`SELECT C.SYSTEM_TABLE_NAME AS FROMT, K.COLUMN_NAME AS FROMC, P.SYSTEM_TABLE_NAME AS TOT, PK.COLUMN_NAME AS TOC, C.CONSTRAINT_NAME AS CN, K.ORDINAL_POSITION AS POS ` +
      `FROM QSYS2.SYSCST C JOIN QSYS2.SYSREFCST R ON R.CONSTRAINT_SCHEMA = C.CONSTRAINT_SCHEMA AND R.CONSTRAINT_NAME = C.CONSTRAINT_NAME ` +
      `JOIN QSYS2.SYSKEYCST K ON K.CONSTRAINT_SCHEMA = C.CONSTRAINT_SCHEMA AND K.CONSTRAINT_NAME = C.CONSTRAINT_NAME ` +
      `JOIN QSYS2.SYSCST P ON P.CONSTRAINT_SCHEMA = R.UNIQUE_CONSTRAINT_SCHEMA AND P.CONSTRAINT_NAME = R.UNIQUE_CONSTRAINT_NAME ` +
      `JOIN QSYS2.SYSKEYCST PK ON PK.CONSTRAINT_SCHEMA = P.CONSTRAINT_SCHEMA AND PK.CONSTRAINT_NAME = P.CONSTRAINT_NAME AND PK.ORDINAL_POSITION = K.ORDINAL_POSITION ` +
      `WHERE C.SYSTEM_TABLE_SCHEMA = ${sqlString(lib)} AND C.CONSTRAINT_TYPE = 'FOREIGN KEY' ORDER BY C.CONSTRAINT_NAME, K.ORDINAL_POSITION`, 10000).catch(() => []),
  ]));
  const pkSet = new Set(pk.map(r => `${s(r, 'TBL')}|${s(r, 'C')}`));
  const fkSet = new Set(fk.map(r => `${s(r, 'FROMT')}|${s(r, 'FROMC')}`));
  const tables: ErdTable[] = names.map(n => ({
    name: n, text: s(all.find(r => s(r, 'N') === n)!, 'T'),
    columns: cols.filter(c => s(c, 'TBL') === n).map(c => ({ name: s(c, 'C'), type: `${s(c, 'DT')}(${s(c, 'L')}${Number(c.SC) ? ',' + s(c, 'SC') : ''})`,
      pk: pkSet.has(`${n}|${s(c, 'C')}`), fk: fkSet.has(`${n}|${s(c, 'C')}`), nullable: s(c, 'NL') === 'Y' })),
  }));
  const byName = new Map<string, ErdLink>();
  for (const r of fk) {
    if (!names.includes(s(r, 'FROMT')) || !names.includes(s(r, 'TOT'))) { continue; }
    const key = s(r, 'CN');
    const l = byName.get(key) ?? { from: s(r, 'FROMT'), to: s(r, 'TOT'), fromCols: [], toCols: [], inferred: false, name: key };
    l.fromCols.push(s(r, 'FROMC')); l.toCols.push(s(r, 'TOC')); byName.set(key, l);
  }
  const declared = [...byName.values()];
  return { tables, links: [...declared, ...inferLinks(tables, declared)] };
}

function svg(tables: ErdTable[], links: ErdLink[], showInferred: boolean): { svg: string; width: number; height: number } {
  const ls = links.filter(l => showInferred || !l.inferred);
  const { boxes, width, height } = layoutErd(tables, ls, MAX_COLS);
  const box = new Map(boxes.map(b => [b.name, b]));
  const edges = ls.map(l => {
    const a = box.get(l.from)!; const b = box.get(l.to)!;
    if (!a || !b) { return ''; }
    const aRight = a.x + a.w <= b.x; const bRight = b.x + b.w <= a.x;
    const x1 = aRight ? a.x + a.w : bRight ? a.x : a.x + a.w / 2; const y1 = aRight || bRight ? a.y + 13 : (a.y < b.y ? a.y + a.h : a.y);
    const x2 = aRight ? b.x : bRight ? b.x + b.w : b.x + b.w / 2; const y2 = aRight || bRight ? b.y + 13 : (a.y < b.y ? b.y : b.y + b.h);
    const dx = aRight || bRight ? Math.max(40, Math.abs(x2 - x1) / 2) * (aRight ? 1 : -1) : 0; const dy = aRight || bRight ? 0 : (y2 > y1 ? 40 : -40);
    const title = `${l.from}(${l.fromCols.join(', ')}) → ${l.to}(${l.toCols.join(', ')})${l.inferred ? ' — inferred from the column name' : ''}`;
    return `<path class="edge${l.inferred ? ' inferred' : ''}" data-a="${escapeHtml(l.from)}" data-b="${escapeHtml(l.to)}" d="M${x1},${y1} C${x1 + dx},${y1 + dy} ${x2 - dx},${y2 - dy} ${x2},${y2}"><title>${escapeHtml(title)}</title></path>` +
      `<circle class="end" cx="${x2}" cy="${y2}" r="4"/>`;
  }).join('');
  const nodes = boxes.map(b => {
    const t = tables.find(x => x.name === b.name)!;
    const rows = t.columns.slice(0, MAX_COLS).map((c, i) => `<text x="${b.x + 10}" y="${b.y + 26 + 14 + i * 18}" class="col${c.pk ? ' pk' : ''}">${c.pk ? '🔑 ' : c.fk ? '↗ ' : ''}${escapeHtml(c.name)}</text>` +
      `<text x="${b.x + b.w - 8}" y="${b.y + 26 + 14 + i * 18}" class="type" text-anchor="end">${escapeHtml(c.type.toLowerCase())}</text>`).join('');
    const more = t.columns.length > MAX_COLS ? `<text x="${b.x + 10}" y="${b.y + 26 + 14 + MAX_COLS * 18}" class="type">+ ${t.columns.length - MAX_COLS} more</text>` : '';
    return `<g class="tbl" data-t="${escapeHtml(t.name)}"><title>${escapeHtml(`${t.name}${t.text ? ' — ' + t.text : ''}\n${t.columns.map(c => `${c.name} ${c.type}`).join('\n')}`)}</title>` +
      `<rect x="${b.x}" y="${b.y}" width="${b.w}" height="${b.h}" rx="6" class="box"/><rect x="${b.x}" y="${b.y}" width="${b.w}" height="26" rx="6" class="head"/>` +
      `<text x="${b.x + 10}" y="${b.y + 18}" class="name">${escapeHtml(t.name)}</text>${rows}${more}</g>`;
  }).join('');
  return { svg: `<svg xmlns="http://www.w3.org/2000/svg" id="erd" viewBox="0 0 ${width} ${height}" width="${width}" height="${height}">${edges}${nodes}</svg>`, width, height };
}

async function showErd(manager: ConnectionManager, lib: string): Promise<void> {
  lib = assertSystemName(lib, 'library');
  const data = await load(manager, lib);
  if (!data) { return; }
  const panel = vscode.window.createWebviewPanel('vanthrex.erd', vscode.l10n.t('Database diagram — {0}', lib), vscode.ViewColumn.Active, { enableScripts: true });
  let showInferred = true;
  const render = () => {
    const { svg: pic } = svg(data.tables, data.links, showInferred);
    const declared = data.links.filter(l => !l.inferred).length; const inferred = data.links.length - declared;
    const n = nonce();
    panel.webview.html = `<!DOCTYPE html><html><head><meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${n}';">
<style>
 body { font-family: var(--vscode-font-family); color: var(--vscode-foreground); padding: 8px 12px; margin: 0; }
 .bar { display:flex; gap:8px; align-items:center; flex-wrap:wrap; margin-bottom: 8px; } .dim { color: var(--vscode-descriptionForeground); }
 button { padding: 4px 10px; border: none; border-radius: 3px; cursor: pointer; background: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground); }
 #wrap { overflow: auto; border: 1px solid var(--vscode-editorWidget-border, #8883); border-radius: 6px; height: calc(100vh - 70px); }
 svg { transform-origin: 0 0; font-family: var(--vscode-editor-font-family); font-size: 12px; }
 .box { fill: var(--vscode-editor-background); stroke: var(--vscode-editorWidget-border, #888); }
 .head { fill: var(--vscode-editorWidget-background); stroke: var(--vscode-editorWidget-border, #888); }
 .name { fill: var(--vscode-foreground); font-weight: 600; } .col { fill: var(--vscode-foreground); } .pk { font-weight: 600; } .type { fill: var(--vscode-descriptionForeground); font-size: 11px; }
 .edge { fill: none; stroke: var(--vscode-charts-blue, #3794ff); stroke-width: 1.6; } .edge.inferred { stroke-dasharray: 5 4; stroke: var(--vscode-descriptionForeground); }
 .end { fill: var(--vscode-charts-blue, #3794ff); } .tbl { cursor: pointer; }
 .fade .tbl:not(.on) { opacity: .25; } .fade .edge:not(.on) { opacity: .1; } .edge.on { stroke-width: 2.6; }
</style></head><body>
<div class="bar"><strong>${escapeHtml(lib)}</strong><span class="dim">${data.tables.length} ${escapeHtml(vscode.l10n.t('tables'))} · ${declared} ${escapeHtml(vscode.l10n.t('foreign keys'))} · ${inferred} ${escapeHtml(vscode.l10n.t('inferred (dashed)'))}</span>
<button id="inf">${escapeHtml(showInferred ? vscode.l10n.t('Hide inferred links') : vscode.l10n.t('Show inferred links'))}</button>
<button id="mer">${escapeHtml(vscode.l10n.t('Copy as Mermaid'))}</button><button id="svg">${escapeHtml(vscode.l10n.t('Save as SVG…'))}</button>
<button id="zi">+</button><button id="zo">−</button><span class="dim">${escapeHtml(vscode.l10n.t('Click a table to highlight its links. Inferred links match a column to another table\'s one-column primary key.'))}</span></div>
<div id="wrap">${pic}</div>
<script nonce="${n}">
 const vscode = acquireVsCodeApi(); let z = 1; const svg = document.getElementById('erd');
 const zoom = f => { z = Math.min(3, Math.max(.2, z * f)); svg.style.transform = 'scale(' + z + ')'; };
 document.getElementById('zi').onclick = () => zoom(1.2); document.getElementById('zo').onclick = () => zoom(1 / 1.2);
 document.getElementById('wrap').addEventListener('wheel', e => { if (e.ctrlKey) { e.preventDefault(); zoom(e.deltaY < 0 ? 1.1 : 1 / 1.1); } }, { passive: false });
 document.getElementById('inf').onclick = () => vscode.postMessage({ type: 'inferred' });
 document.getElementById('mer').onclick = () => vscode.postMessage({ type: 'mermaid' });
 document.getElementById('svg').onclick = () => vscode.postMessage({ type: 'svg' });
 svg.addEventListener('click', e => {
   const g = e.target.closest('.tbl');
   document.querySelectorAll('.on').forEach(x => x.classList.remove('on'));
   if (!g) { svg.classList.remove('fade'); return; }
   const t = g.dataset.t; svg.classList.add('fade'); g.classList.add('on');
   document.querySelectorAll('.edge').forEach(p => { if (p.dataset.a === t || p.dataset.b === t) { p.classList.add('on'); [p.dataset.a, p.dataset.b].forEach(n => { const o = document.querySelector('.tbl[data-t="' + CSS.escape(n) + '"]'); if (o) o.classList.add('on'); }); } });
 });
</script></body></html>`;
  };
  panel.webview.onDidReceiveMessage(async m => {
    try {
      if (m?.type === 'inferred') { showInferred = !showInferred; render(); }
      if (m?.type === 'mermaid') {
        await vscode.env.clipboard.writeText(toMermaid(data.tables, data.links.filter(l => showInferred || !l.inferred)));
        vscode.window.showInformationMessage(vscode.l10n.t('Mermaid diagram copied — paste it into Markdown, GitHub or a wiki.'));
      }
      if (m?.type === 'svg') {
        const target = await vscode.window.showSaveDialog({ defaultUri: vscode.Uri.file(`${lib}-erd.svg`), filters: { SVG: ['svg'] } });
        if (!target) { return; }
        const { svg: pic } = svg(data.tables, data.links, showInferred);
        const style = '<style>text{font-family:Consolas,monospace;font-size:12px}.box{fill:#fff;stroke:#888}.head{fill:#eef}.name{font-weight:600}.type{fill:#666;font-size:11px}.edge{fill:none;stroke:#2f6fdf;stroke-width:1.6}.edge.inferred{stroke:#888;stroke-dasharray:5 4}.end{fill:#2f6fdf}</style>';
        await vscode.workspace.fs.writeFile(target, Buffer.from(pic.replace(/^<svg([^>]*)>/, `<svg$1>${style}`), 'utf8'));
        vscode.window.showInformationMessage(vscode.l10n.t('Saved {0}', target.fsPath));
      }
    } catch (e) { logError(e); vscode.window.showErrorMessage(errorMessage(e)); }
  });
  render();
}

export function registerErd(context: vscode.ExtensionContext, manager: ConnectionManager): void {
  context.subscriptions.push(vscode.commands.registerCommand('vanthrex.databaseDiagram', async (n?: { library?: string } | string) => {
    try {
      const lib = typeof n === 'string' ? n : n?.library ?? (await vscode.window.showInputBox({ title: vscode.l10n.t('Database diagram'), prompt: vscode.l10n.t('Library'), value: manager.connection?.profile.currentLibrary ?? '', ignoreFocusOut: true }));
      if (lib) { await showErd(manager, lib.trim().toUpperCase()); }
    } catch (e) { logError(e); vscode.window.showErrorMessage(errorMessage(e)); }
  }));
}
