import * as vscode from 'vscode';
import { ConnectionManager } from '../core/manager';
import { errorMessage } from '../core/log';
import { sqlString } from '../core/util';
import { SpoolNode, SpoolTreeProvider } from '../views/spoolTree';

export const SPOOL_SCHEME = 'vanthrex-spool';

export function spoolUri(n: Pick<SpoolNode, "job" | "name" | "number">): vscode.Uri {
  const query = new URLSearchParams({ job: n.job, name: n.name, number: String(n.number) }).toString();
  return vscode.Uri.from({ scheme: SPOOL_SCHEME, path: `/${n.name}_${n.number}.txt`, query });
}

class SpoolContentProvider implements vscode.TextDocumentContentProvider {
  constructor(private readonly manager: ConnectionManager) {}

  async provideTextDocumentContent(uri: vscode.Uri): Promise<string> {
    const q = new URLSearchParams(uri.query);
    return readSpool(this.manager, q.get('job') ?? '', q.get('name') ?? '', Number(q.get('number') ?? 1));
  }
}

async function readSpool(manager: ConnectionManager, job: string, name: string, number: number): Promise<string> {
  const rows = await manager.require().rows<{ SPOOLED_DATA: string }>(
    `SELECT SPOOLED_DATA FROM TABLE(SYSTOOLS.SPOOLED_FILE_DATA(JOB_NAME => ${sqlString(job)}, ` +
    `SPOOLED_FILE_NAME => ${sqlString(name)}, SPOOLED_FILE_NUMBER => ${Math.floor(number)})) ORDER BY ORDINAL_POSITION`,
    500000);
  return rows.map(r => String(r.SPOOLED_DATA ?? '').trimEnd()).join('\n');
}

export function registerSpool(context: vscode.ExtensionContext, manager: ConnectionManager, tree: SpoolTreeProvider): void {
  context.subscriptions.push(
    vscode.workspace.registerTextDocumentContentProvider(SPOOL_SCHEME, new SpoolContentProvider(manager)),
    vscode.commands.registerCommand('vanthrex.refreshSpool', () => tree.refresh()),
    vscode.commands.registerCommand('vanthrex.spoolOpen', async (n: SpoolNode) => {
      try {
        const doc = await vscode.workspace.openTextDocument(spoolUri(n));
        await vscode.window.showTextDocument(doc, { preview: true });
      } catch (e) {
        vscode.window.showErrorMessage(vscode.l10n.t('Could not open spooled file: {0}', errorMessage(e)));
      }
    }),
    vscode.commands.registerCommand('vanthrex.spoolDownload', async (n: SpoolNode) => {
      const target = await vscode.window.showSaveDialog({
        defaultUri: vscode.Uri.file(`${n.name}_${n.number}.txt`), filters: { Text: ['txt'] } });
      if (!target) { return; }
      try {
        const text = await readSpool(manager, n.job, n.name, n.number);
        await vscode.workspace.fs.writeFile(target, Buffer.from(text, 'utf8'));
        vscode.window.showInformationMessage(vscode.l10n.t('Saved {0} to {1}', n.name, target.fsPath));
      } catch (e) {
        vscode.window.showErrorMessage(errorMessage(e));
      }
    }),
    vscode.commands.registerCommand('vanthrex.spoolDelete', async (n: SpoolNode) => {
      const ok = await vscode.window.showWarningMessage(vscode.l10n.t('Delete spooled file {0} (#{1}) of job {2}?', n.name, n.number, n.job),
        { modal: true }, vscode.l10n.t('Delete'));
      if (ok !== vscode.l10n.t('Delete')) { return; }
      const r = await manager.require().runCL(`DLTSPLF FILE(${n.name}) JOB(${n.job}) SPLNBR(${n.number})`);
      if (!r.ok) { vscode.window.showErrorMessage(vscode.l10n.t('Could not delete: {0}', (r.stderr || r.stdout).trim())); }
      tree.refresh();
    }),
  );
}
