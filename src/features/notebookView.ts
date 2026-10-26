// IBM i notebooks (.vxnb): SQL, CL, PASE shell and Markdown cells in one file. Results are shown as tables or charts
// (`-- chart: bar|line|pie`) and are not saved in the file. Export to Markdown for documentation or a ticket.
import * as vscode from 'vscode';
import { runCommand } from './greenScreenView';
import { CELL_LANGUAGE, cellOptions, chartSvg, kindOfLanguage, notebookMarkdown, parseNotebook, resultTableHtml, sampleNotebook, serializeNotebook, CellKind } from '../core/notebook';
import { errorMessage } from '../core/log';
import { ConnectionManager } from '../core/manager';
import { splitSqlStatements } from '../core/util';

const TYPE = 'vanthrex-notebook';
type Result = { columns: string[]; rows: Record<string, unknown>[] } | string;
/** Last result of each cell (for the Markdown export), by cell document URI. */
const lastResults = new Map<string, Result>();

class Serializer implements vscode.NotebookSerializer {
  deserializeNotebook(content: Uint8Array): vscode.NotebookData {
    const nb = parseNotebook(new TextDecoder().decode(content));
    return new vscode.NotebookData(nb.cells.map(c => new vscode.NotebookCellData(
      c.kind === 'markdown' ? vscode.NotebookCellKind.Markup : vscode.NotebookCellKind.Code, c.source, CELL_LANGUAGE[c.kind])));
  }
  serializeNotebook(data: vscode.NotebookData): Uint8Array {
    return new TextEncoder().encode(serializeNotebook(data.cells.map(c => ({
      kind: c.kind === vscode.NotebookCellKind.Markup ? 'markdown' : kindOfLanguage(c.languageId), source: c.value,
    }))));
  }
}

const html = (h: string) => vscode.NotebookCellOutputItem.text(h, 'text/html');

async function runCell(manager: ConnectionManager, cell: vscode.NotebookCell, exec: vscode.NotebookCellExecution): Promise<boolean> {
  const conn = manager.require();
  const source = cell.document.getText();
  const kind: CellKind = kindOfLanguage(cell.document.languageId);
  const outputs: vscode.NotebookCellOutput[] = [];
  if (kind === 'sql') {
    const opts = cellOptions(source);
    const statements = splitSqlStatements(source).map(s => s.sql.replace(/^(\s*--[^\n]*\n)+/, '').trim()).filter(Boolean);
    if (!statements.length) { return true; }
    for (const [i, stmt] of statements.entries()) {
      if (exec.token.isCancellationRequested) { return false; }
      const r = await conn.sql(stmt, opts.rows ?? vscode.workspace.getConfiguration('vanthrex').get<number>('notebook.maxRows', 1000));
      const last = i === statements.length - 1;
      if (r.columns.length) {
        const note = `${r.rows.length} row(s)${r.truncated ? ' (more not shown — add "-- rows: N" to read more)' : ''} · ${r.elapsedMs} ms`;
        const items = [html(resultTableHtml(r.columns, r.rows, note)), vscode.NotebookCellOutputItem.json({ columns: r.columns, rows: r.rows }, 'application/json')];
        if (opts.chart && last) {
          try { outputs.push(new vscode.NotebookCellOutput([html(chartSvg(opts.chart, r.columns, r.rows, opts.title))])); }
          catch (e) { outputs.push(new vscode.NotebookCellOutput([vscode.NotebookCellOutputItem.stderr(errorMessage(e))])); }
        }
        outputs.push(new vscode.NotebookCellOutput(items));
        if (last) { lastResults.set(cell.document.uri.toString(), { columns: r.columns, rows: r.rows }); }
      } else {
        const t = `${stmt.split(/\s+/)[0].toUpperCase()}: ${r.updateCount >= 0 ? `${r.updateCount} row(s) changed` : 'done'} · ${r.elapsedMs} ms`;
        outputs.push(new vscode.NotebookCellOutput([vscode.NotebookCellOutputItem.text(t)]));
        if (last) { lastResults.set(cell.document.uri.toString(), t); }
      }
      await exec.replaceOutput(outputs);
    }
    return true;
  }
  if (kind === 'cl') {
    const commands = source.split(/\r?\n/).map(l => l.trim()).filter(l => l && !l.startsWith('/*') && !l.startsWith('--'));
    let ok = true; const texts: string[] = [];
    for (const cmd of commands) {
      if (exec.token.isCancellationRequested) { return false; }
      const r = await runCommand(manager, cmd);
      const lines = [`> ${r.ran ?? cmd}`];
      if (r.opened) { lines.push(`(opened ${r.opened})`); }
      for (const m of r.messages) { lines.push(`${m.id ? m.id + ' ' : ''}${m.text}`); }
      if (r.error && !r.messages.length) { lines.push(r.error); }
      if (r.spool?.text) { lines.push('', r.spool.text); }
      texts.push(lines.join('\n'));
      outputs.push(new vscode.NotebookCellOutput([r.ok ? vscode.NotebookCellOutputItem.stdout(lines.join('\n') + '\n') : vscode.NotebookCellOutputItem.stderr(lines.join('\n') + '\n')]));
      await exec.replaceOutput(outputs);
      if (!r.ok) { ok = false; break; }
    }
    lastResults.set(cell.document.uri.toString(), texts.join('\n\n'));
    return ok;
  }
  // PASE shell
  const r = await conn.withChangesAllowed(vscode.l10n.t('Shell: {0}', source.slice(0, 300)), () => conn.exec(`export PATH=/QOpenSys/pkgs/bin:$PATH; ${source}`));
  if (r.stdout) { outputs.push(new vscode.NotebookCellOutput([vscode.NotebookCellOutputItem.stdout(r.stdout)])); }
  if (r.stderr) { outputs.push(new vscode.NotebookCellOutput([vscode.NotebookCellOutputItem.stderr(r.stderr)])); }
  if (!outputs.length) { outputs.push(new vscode.NotebookCellOutput([vscode.NotebookCellOutputItem.text(`exit code ${r.code}`)])); }
  await exec.replaceOutput(outputs);
  lastResults.set(cell.document.uri.toString(), r.stdout + r.stderr);
  return r.code === 0;
}

export function registerNotebooks(context: vscode.ExtensionContext, manager: ConnectionManager): void {
  const controller = vscode.notebooks.createNotebookController('vanthrex-notebook-kernel', TYPE, 'IBM i (Vanthrex)');
  controller.supportedLanguages = ['sql', 'cl', 'shellscript'];
  controller.supportsExecutionOrder = true;
  controller.description = vscode.l10n.t('Runs on the connected IBM i');
  let order = 0;
  controller.executeHandler = async cells => {
    for (const cell of cells) {
      const exec = controller.createNotebookCellExecution(cell);
      exec.executionOrder = ++order;
      exec.start(Date.now());
      try {
        await exec.clearOutput();
        exec.end(await runCell(manager, cell, exec), Date.now());
      } catch (e) {
        await exec.replaceOutput([new vscode.NotebookCellOutput([vscode.NotebookCellOutputItem.error(new Error(errorMessage(e)))])]);
        exec.end(false, Date.now());
      }
    }
  };
  context.subscriptions.push(
    vscode.workspace.registerNotebookSerializer(TYPE, new Serializer(), { transientOutputs: true }),
    controller,
    vscode.commands.registerCommand('vanthrex.newNotebook', async () => {
      const user = manager.connection?.user ?? 'ME';
      const data = new Serializer().deserializeNotebook(new TextEncoder().encode(serializeNotebook(sampleNotebook(user))));
      const doc = await vscode.workspace.openNotebookDocument(TYPE, data);
      await vscode.window.showNotebookDocument(doc);
    }),
    vscode.commands.registerCommand('vanthrex.notebook.exportMarkdown', async () => {
      const nb = vscode.window.activeNotebookEditor?.notebook;
      if (!nb || nb.notebookType !== TYPE) { vscode.window.showWarningMessage(vscode.l10n.t('Open an IBM i notebook first.')); return; }
      const md = notebookMarkdown(nb.getCells().map(c => ({
        kind: c.kind === vscode.NotebookCellKind.Markup ? 'markdown' as const : kindOfLanguage(c.document.languageId), source: c.document.getText(),
        result: lastResults.get(c.document.uri.toString()),
      })));
      const doc = await vscode.workspace.openTextDocument({ language: 'markdown', content: md });
      await vscode.window.showTextDocument(doc);
    }),
  );
}
