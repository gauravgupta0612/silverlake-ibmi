// Message files: message descriptions and the commands to change them. Pure functions (no vscode import), unit tested.
import { isValidSystemName } from './util';

const NAME = (v: string, what: string): string => {
  const u = v.trim().toUpperCase();
  if (!isValidSystemName(u)) { throw new Error(`"${v}" is not a valid ${what} name.`); }
  return u;
};

const clq = (v: string) => `'${v.replace(/'/g, "''")}'`;

export const MESSAGE_ID_FORMAT = /^[A-Z][A-Z0-9]{2}[0-9A-F]{4}$/;

export interface MessageDesc { id: string; text: string; help?: string; severity?: number }

function msgParts(m: MessageDesc): string {
  const id = m.id.trim().toUpperCase();
  if (!MESSAGE_ID_FORMAT.test(id)) { throw new Error('A message ID is 3 characters and 4 hexadecimal digits, like APP0001.'); }
  if (!m.text.trim()) { throw new Error('Enter the message text.'); }
  if (m.text.length > 132) { throw new Error('The message text is at most 132 characters.'); }
  if ((m.help ?? '').length > 3000) { throw new Error('The help text is at most 3000 characters.'); }
  const sev = m.severity ?? 0;
  if (!Number.isInteger(sev) || sev < 0 || sev > 99) { throw new Error('Severity is 0 to 99.'); }
  return `MSGID(${id}) MSGF(&MSGF) MSG(${clq(m.text)})${m.help?.trim() ? ` SECLVL(${clq(m.help.trim())})` : ''} SEV(${sev})`;
}

export function addMessageCommand(lib: string, msgf: string, m: MessageDesc): string {
  return `ADDMSGD ${msgParts(m).replace('&MSGF', `${NAME(lib, 'library')}/${NAME(msgf, 'message file')}`)}`;
}

export function changeMessageCommand(lib: string, msgf: string, m: MessageDesc): string {
  const p = msgParts(m).replace('&MSGF', `${NAME(lib, 'library')}/${NAME(msgf, 'message file')}`);
  return `CHGMSGD ${m.help?.trim() ? p : p + ' SECLVL(*NONE)'}`;
}

export function removeMessageCommand(lib: string, msgf: string, id: string): string {
  if (!MESSAGE_ID_FORMAT.test(id.trim().toUpperCase())) { throw new Error('Invalid message ID.'); }
  return `RMVMSGD MSGID(${id.trim().toUpperCase()}) MSGF(${NAME(lib, 'library')}/${NAME(msgf, 'message file')})`;
}

/** Next free ID after the highest one with the same prefix (hexadecimal numbering, as IBM does). */
export function nextMessageId(existing: string[], prefix: string): string {
  const p = prefix.trim().toUpperCase().slice(0, 3);
  if (!/^[A-Z][A-Z0-9]{2}$/.test(p)) { throw new Error('The prefix is 3 characters, starting with a letter.'); }
  const nums = existing.map(x => x.trim().toUpperCase()).filter(x => x.startsWith(p) && MESSAGE_ID_FORMAT.test(x)).map(x => parseInt(x.slice(3), 16));
  const n = nums.length ? Math.max(...nums) + 1 : 1;
  if (n > 0xffff) { throw new Error(`No free IDs left for ${p}.`); }
  return p + n.toString(16).toUpperCase().padStart(4, '0');
}

/** Turn a field-finder pattern (with * or % wildcards) into an SQL LIKE pattern. */
export function likePattern(input: string): string {
  const t = input.trim().toUpperCase().replace(/'/g, "''").replace(/\*/g, '%');
  if (!t) { throw new Error('Enter a field name.'); }
  return /[%_]/.test(t) ? t : `%${t}%`;
}
