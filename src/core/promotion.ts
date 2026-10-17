// Object promotion: plans, commands and undo. Pure functions (no vscode import), unit tested.
import { isValidSystemName } from './util';

const NAME = (v: string, what: string): string => {
  const u = v.trim().toUpperCase();
  if (!isValidSystemName(u)) { throw new Error(`"${v}" is not a valid ${what} name.`); }
  return u;
};

export interface PromoteObject { name: string; type: string; attribute?: string; sourceChanged?: string; targetChanged?: string; existsInTarget: boolean }

export type PromoteStatus = 'new' | 'newer in source' | 'NEWER IN TARGET' | 'same date';

export function promoteStatus(o: PromoteObject): PromoteStatus {
  if (!o.existsInTarget) { return 'new'; }
  const s = o.sourceChanged ?? ''; const t = o.targetChanged ?? '';
  if (s === t) { return 'same date'; }
  return s > t ? 'newer in source' : 'NEWER IN TARGET';
}

/** Physical files carry data: restoring them would replace the target's data. */
export function carriesData(o: PromoteObject): boolean {
  return o.type.toUpperCase() === '*FILE' && /^PF/i.test(o.attribute ?? '');
}

/** Save file name for a backup or a transfer: prefix + MMDDHHMM (10 characters). */
export function stampedName(prefix: 'VB' | 'VP', d: Date): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${prefix}${p(d.getMonth() + 1)}${p(d.getDate())}${p(d.getHours())}${p(d.getMinutes())}`;
}

export interface PromotionPlan {
  source: string; target: string; objects: { name: string; type: string }[]; backupLibrary: string; when: string;
}

/** The commands a promotion runs, in order. */
export function promotionCommands(plan: PromotionPlan, existingInTarget: { name: string; type: string }[]): { backupSavf?: string; transferSavf: string; steps: string[] } {
  const src = NAME(plan.source, 'library'); const tgt = NAME(plan.target, 'library'); const bl = NAME(plan.backupLibrary, 'library');
  if (src === tgt) { throw new Error('Source and target library are the same.'); }
  if (!plan.objects.length) { throw new Error('Pick at least one object.'); }
  const d = new Date(plan.when);
  const names = (os: { name: string; type: string }[]) => [...new Set(os.map(o => NAME(o.name, 'object')))].join(' ');
  const types = (os: { name: string; type: string }[]) => [...new Set(os.map(o => o.type.toUpperCase()))].join(' ');
  const steps: string[] = [];
  let backupSavf: string | undefined;
  if (existingInTarget.length) {
    backupSavf = `${bl}/${stampedName('VB', d)}`;
    steps.push(`CRTSAVF FILE(${backupSavf}) TEXT('Vanthrex backup of ${tgt} before promotion from ${src}')`);
    steps.push(`SAVOBJ OBJ(${names(existingInTarget)}) LIB(${tgt}) DEV(*SAVF) SAVF(${backupSavf}) OBJTYPE(${types(existingInTarget)})`);
  }
  const transferSavf = `${bl}/${stampedName('VP', d)}`;
  steps.push(`CRTSAVF FILE(${transferSavf}) TEXT('Vanthrex promotion ${src} to ${tgt}')`);
  steps.push(`SAVOBJ OBJ(${names(plan.objects)}) LIB(${src}) DEV(*SAVF) SAVF(${transferSavf}) OBJTYPE(${types(plan.objects)})`);
  steps.push(`RSTOBJ OBJ(${names(plan.objects)}) SAVLIB(${src}) DEV(*SAVF) SAVF(${transferSavf}) OBJTYPE(${types(plan.objects)}) MBROPT(*ALL) ALWOBJDIF(*COMPATIBLE) RSTLIB(${tgt})`);
  steps.push(`DLTF FILE(${transferSavf})`);
  return { backupSavf, transferSavf, steps };
}

/** Undo a promotion: restore the backup over the target library. */
export function undoPromotionCommand(target: string, backupSavf: string): string {
  return `RSTOBJ OBJ(*ALL) SAVLIB(${NAME(target, 'library')}) DEV(*SAVF) SAVF(${backupSavf}) MBROPT(*ALL) ALWOBJDIF(*COMPATIBLE)`;
}
