import * as vscode from 'vscode';
import { ConnectionManager } from '../core/manager';
import { errorMessage } from '../core/log';
import { sqlString } from '../core/util';
import { SpoolNode, SpoolTreeProvider } from '../views/spoolTree';

export const SPOOL_SCHEME = 'silverlake-spool';

function spoolUri(n: SpoolNode): vscode.Uri {
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
    vscode.commands.registerCommand('silverlake.refreshSpool', () => tree.refresh()),
    vscode.commands.registerCommand('silverlake.spoolOpen', async (n: SpoolNode) => {
      try {
        const doc = await vscode.workspace.openTextDocument(spoolUri(n));
        await vscode.window.showTextDocument(doc, { preview: true });
      } catch (e) {
        vscode.window.showErrorMessage(`Could not open spooled file: ${errorMessage(e)}`);
      }
    }),
    vscode.commands.registerCommand('silverlake.spoolDownload', async (n: SpoolNode) => {
      const target = await vscode.window.showSaveDialog({
        defaultUri: vscode.Uri.file(`${n.name}_${n.number}.txt`), filters: { Text: ['txt'] } });
      if (!target) { return; }
      try {
        const text = await readSpool(manager, n.job, n.name, n.number);
        await vscode.workspace.fs.writeFile(target, Buffer.from(text, 'utf8'));
        vscode.window.showInformationMessage(`Saved ${n.name} to ${target.fsPath}`);
      } catch (e) {
        vscode.window.showErrorMessage(errorMessage(e));
      }
    }),
    vscode.commands.registerCommand('silverlake.spoolDelete', async (n: SpoolNode) => {
      const ok = await vscode.window.showWarningMessage(`Delete spooled file ${n.name} (#${n.number}) of job ${n.job}?`,
        { modal: true }, 'Delete');
      if (ok !== 'Delete') { return; }
      const r = await manager.require().runCL(`DLTSPLF FILE(${n.name}) JOB(${n.job}) SPLNBR(${n.number})`);
      if (!r.ok) { vscode.window.showErrorMessage(`Could not delete: ${(r.stderr || r.stdout).trim()}`); }
      tree.refresh();
    }),
  );
}
