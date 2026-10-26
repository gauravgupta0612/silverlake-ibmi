// Offline explanations of the codes developers meet every day: SQLCODE / SQLSTATE of Db2 for i and the RPG status codes
// (%STATUS, the *STATUS of the program and file information data structures). Pure (no vscode import), unit tested.

export interface CodeInfo { kind: 'SQLCODE' | 'SQLSTATE' | 'RPG status'; code: string; text: string; fix?: string; other?: string }

// SQLCODE → [SQLSTATE, text, what to do]
const SQLCODES: Record<number, [string, string, string?]> = {
  0: ['00000', 'Successful.'],
  100: ['02000', 'No row was found (end of a FETCH, or SELECT INTO / UPDATE / DELETE found nothing).', 'Test SQLCODE = 100 (or SQLSTATE = \'02000\') to end the loop.'],
  [-104]: ['42601', 'A token in the statement is not valid (syntax error).', 'Look at the token named in the message: often a missing comma, quote or parenthesis.'],
  [-107]: ['42622', 'A name is too long.'],
  [-117]: ['42802', 'The number of values is not the same as the number of columns (INSERT or SET).'],
  [-180]: ['22007', 'The string representation of a date, time or timestamp has the wrong syntax.', 'Check the date format of the job and of the value (*ISO is yyyy-mm-dd).'],
  [-181]: ['22007', 'A date, time or timestamp value is not valid (for example 2026-02-30).'],
  [-183]: ['22008', 'A date / time arithmetic result is out of range.'],
  [-199]: ['42601', 'A keyword is not expected at this place.'],
  [-204]: ['42704', 'The object (table, view, procedure…) was not found.', 'Qualify it with its library, or check the library list / the default schema (naming *SQL uses the user profile name as schema).'],
  [-205]: ['42703', 'A column is not in the table.'],
  [-206]: ['42703', 'A column is not in any table of the FROM clause.', 'Check the spelling; a quoted "name" is case-sensitive.'],
  [-208]: ['42707', 'An ORDER BY column is not in the result table.'],
  [-302]: ['22001', 'A value is too long for its host variable or parameter (or numeric out of range).', 'Make the host variable longer or SUBSTR / CAST the value.'],
  [-303]: ['42806', 'A value cannot be assigned to the host variable: the types are not compatible.'],
  [-304]: ['22003', 'A value does not fit in the host variable (numeric overflow or conversion error).', 'Make the host variable larger (more digits).'],
  [-305]: ['22002', 'A NULL value was returned and the host variable has no null indicator.', 'Add an indicator (:var :ind), or COALESCE / IFNULL the column.'],
  [-310]: ['22023', 'Decimal data error: a packed or zoned value is not valid.', 'The data in the file is not numeric (blanks in a numeric field): fix the data or read it as CHAR.'],
  [-312]: ['42618', 'A host variable is not defined or not usable.'],
  [-330]: ['22021', 'A character could not be converted between CCSIDs.', 'Check the CCSID of the column, the job (QCCSID 65535?) and the data.'],
  [-332]: ['57017', 'A conversion between these two CCSIDs is not defined.'],
  [-401]: ['42818', 'The operands of an operator or comparison are not compatible.'],
  [-404]: ['22001', 'A value is too long for its column (INSERT / UPDATE).'],
  [-406]: ['22003', 'A calculated or converted value is out of range for its column.'],
  [-407]: ['23502', 'A NULL value is not allowed in this column (NOT NULL).'],
  [-408]: ['42821', 'The value is not compatible with the type of the column.'],
  [-420]: ['22018', 'A character value in CAST (or DECIMAL, INTEGER…) is not a valid number.'],
  [-438]: ['(user)', 'An application raised this error with SIGNAL or RAISE_ERROR: the SQLSTATE is the one it chose.'],
  [-440]: ['42884', 'No routine with this name and these arguments was found.', 'Check the number and types of the arguments (CAST them), and the path / library list.'],
  [-443]: ['38501', 'An external routine (function / procedure) returned an error.'],
  [-444]: ['42724', 'The external program of a routine was not found.'],
  [-501]: ['24501', 'The cursor is not open (FETCH or CLOSE).'],
  [-502]: ['24502', 'The cursor is already open.', 'CLOSE it first, or declare it WITH HOLD and test whether it is open.'],
  [-504]: ['34000', 'The cursor is not declared.'],
  [-507]: ['24501', 'The cursor of an UPDATE / DELETE WHERE CURRENT OF is not open.'],
  [-508]: ['24504', 'The cursor is not positioned on a row.'],
  [-514]: ['26501', 'The prepared statement is not found.'],
  [-518]: ['07003', 'The statement in EXECUTE is not prepared.'],
  [-530]: ['23503', 'The foreign key value has no parent row (INSERT / UPDATE).'],
  [-532]: ['23504', 'The row has dependent rows: the delete is restricted.'],
  [-551]: ['42501', 'Not authorized to the object.', 'Check the authority with Vanthrex → Check Authority, or ask the owner (GRTOBJAUT).'],
  [-552]: ['42502', 'Not authorized to perform this operation.'],
  [-601]: ['42710', 'The object already exists.', 'Use CREATE OR REPLACE, or drop it first.'],
  [-603]: ['23515', 'A unique index cannot be created: duplicate keys exist.'],
  [-612]: ['42711', 'A column name is used twice.'],
  [-802]: ['22003', 'Data conversion or data mapping error (overflow, division by zero…).'],
  [-803]: ['23505', 'Duplicate key: the value is already in a unique index or primary key.', 'Check the existing row first, or use MERGE.'],
  [-811]: ['21000', 'More than one row was found for a SELECT INTO or a subquery that must return one row.', 'Add FETCH FIRST 1 ROW ONLY or make the WHERE unique.'],
  [-901]: ['58004', 'System error: see the job log.'],
  [-904]: ['57011', 'A resource limit was exceeded.'],
  [-910]: ['57007', 'The object cannot be used: a change is pending on it (for example a DDL in an uncommitted transaction).'],
  [-913]: ['57033', 'A row or object is in use (locked by another job).', 'See who holds it: Vanthrex → Row Locks / Object Locks. Consider a shorter commit or WAIT time.'],
  [-952]: ['57014', 'Processing was canceled (interrupt or query time limit).'],
  [-7007]: ['51009', 'COMMIT or ROLLBACK is not valid here.'],
  [-7008]: ['55019', 'The object is not valid for this operation — most often: the table is not journaled and the statement runs under commitment control.', 'Journal the file (Vanthrex → Journal Coverage), or run with COMMIT(*NONE) / WITH NC.'],
};

const SQLSTATE_CLASS: Record<string, string> = {
  '00': 'Successful completion', '01': 'Warning', '02': 'No data', '07': 'Dynamic SQL error', '08': 'Connection exception', '09': 'Triggered action exception',
  '0A': 'Feature not supported', '21': 'Cardinality violation', '22': 'Data exception', '23': 'Constraint violation', '24': 'Invalid cursor state',
  '25': 'Invalid transaction state', '26': 'Invalid SQL statement identifier', '27': 'Triggered data change violation', '34': 'Invalid cursor name',
  '38': 'External function exception', '39': 'External function call exception', '40': 'Transaction rollback', '42': 'Syntax error or access rule violation',
  '44': 'WITH CHECK OPTION violation', '46': 'Java error', '51': 'Invalid application state', '53': 'Invalid operand or inconsistent specification',
  '54': 'SQL or product limit exceeded', '55': 'Object not in prerequisite state', '56': 'Miscellaneous SQL or product error', '57': 'Resource not available or operator intervention',
  '58': 'System error',
};

const RPG_STATUS: Record<string, [string, string?]> = {
  '00000': ['No exception or error.'], '00001': ['Called program returned with the LR indicator on.'], '00002': ['A function key was used to end the display.'],
  '00011': ['End of file on a read (input).'], '00012': ['No record found on CHAIN, SETLL or a similar operation.'], '00013': ['Subfile is full on WRITE.'],
  '00050': ['Conversion resulted in substitution.'], '00100': ['Value out of range for a string operation (%SUBST, %SCAN… start or length not valid).', 'Check the start position and length against %LEN.'],
  '00101': ['Negative square root.'], '00102': ['Divide by zero.'], '00103': ['An intermediate result is too large for the result field (numeric overflow).', 'Make the result field larger, or use EVAL(H) / check the values.'],
  '00104': ['Float underflow.'], '00105': ['Characters not valid in a character-to-numeric conversion (%DEC, %INT…).', 'Validate with %CHECK before converting, or MONITOR the conversion.'],
  '00112': ['Date, time or timestamp value not valid.', 'TEST(DE) the value before %DATE, or MONITOR.'], '00113': ['Date overflow or underflow (result outside the valid range).'],
  '00114': ['Date mapping error (the date does not fit the 2-digit-year format).'], '00115': ['Variable-length field has a current length that is not valid.'],
  '00120': ['Table or array out of sequence.'], '00121': ['Array index not valid (0, negative or greater than the number of elements).', 'Check the index against %ELEM before using it.'],
  '00122': ['OCCUR outside the range of the multiple-occurrence data structure.'], '00123': ['RESET attempted during initialization.'],
  '00202': ['Called program or procedure failed.', 'See the job log for the error of the called program.'], '00211': ['Error calling the program or procedure (not found, not authorized, wrong type).', 'Check that the program exists in the library list and the authority.'],
  '00221': ['Called program tried to use a parameter that was not passed.', 'Use %PARMS / %PASSED, or OPTIONS(*NOPASS) carefully.'], '00222': ['Pointer or parameter error.'],
  '00231': ['Called program returned with a halt indicator on.'], '00232': ['Halt indicator on in this program.'], '00233': ['Halt indicator on when RETURN was done.'],
  '00299': ['RPG formatted dump failed.'], '00333': ['Error on DSPLY.'], '00401': ['Data area not found.'], '00402': ['*PDA not valid for a non-prestart job.'],
  '00411': ['Data area type or length does not match.'], '00412': ['Data area not locked for output.'], '00413': ['Error on IN or OUT of a data area.'],
  '00414': ['Not authorized to use the data area.'], '00415': ['Not authorized to change the data area.'], '00421': ['Error on UNLOCK of a data area.'],
  '00425': ['Length requested for storage allocation is out of range.'], '00426': ['Error during storage management (%ALLOC, %REALLOC, DEALLOC).'],
  '00431': ['Data area locked by another program.'], '00432': ['Data area locked by a program in the same process.'],
  '00450': ['Character field not enclosed by SO and SI.'], '00451': ['Conversion between the two CCSIDs is not supported.'],
  '00501': ['Failure to retrieve the sort sequence.'], '00502': ['Failure to convert the sort sequence.'], '00802': ['Commitment control not active.'],
  '00803': ['Rollback failed.'], '00804': ['Error during COMMIT.'], '00805': ['Error during ROLBK.'],
  '00907': ['Decimal data error: a numeric field holds data that is not numeric.', 'The data is bad (blanks or letters in a packed / zoned field): find the record, fix it, or read the field as character.'],
  '00970': ['Level check: the file format changed since the program was compiled.', 'Recompile the program (Vanthrex → Programs That Would Get a Level Check lists them all).'],
  '09998': ['Internal failure in ILE RPG or in its generated code.'], '09999': ['Program exception in a system routine.'],
  '01011': ['Undefined record type (input record does not match a record identifying indicator).'], '01021': ['Tried to write a record that already exists (duplicate key).', 'CHAIN or SETLL first, or MONITOR the WRITE.'],
  '01022': ['Referential constraint error on update or write.'], '01023': ['Error in a trigger program before the operation.'], '01024': ['Error in a trigger program after the operation.'],
  '01031': ['Match field out of sequence.'], '01041': ['Array or table load sequence error.'], '01042': ['Array or table load error.'], '01051': ['Excess entries in an array or table file.'],
  '01071': ['Numeric sequence error.'], '01121': ['No indicator on the DDS keyword for the Print key.'], '01122': ['No indicator on the DDS keyword for the Roll Up key.'],
  '01123': ['No indicator on the DDS keyword for the Roll Down key.'], '01124': ['No indicator on the DDS keyword for the Clear key.'], '01125': ['No indicator on the DDS keyword for the Help key.'],
  '01126': ['No indicator on the DDS keyword for the Home key.'], '01201': ['Record mismatch detected on input.'],
  '01211': ['I/O operation to a closed file.', 'OPEN the file (USROPN), or check that it was not closed earlier.'], '01215': ['OPEN of a file that is already open.', 'Test %OPEN before OPEN.'],
  '01216': ['Error on an implicit OPEN or CLOSE (file not found, not authorized, member missing, level check…).', 'See the job log: the CPF message before RNQ1216 says why.'],
  '01217': ['Error on an explicit OPEN or CLOSE.', 'See the job log: the CPF message before RNQ1217 says why.'], '01218': ['Record already locked (by this job or another).', 'Read with (N) when you do not update, and keep locks short; see who holds it with Row Locks.'],
  '01221': ['Update or delete without a prior read of the record.'], '01222': ['Record cannot be allocated because of a referential constraint error.'],
  '01231': ['Error on a SPECIAL file.'], '01235': ['Error in PRTCTL space or skip entries.'], '01241': ['Record number not found (relative record number beyond the end).'],
  '01251': ['Permanent I/O error.'], '01255': ['Session or device error; recovery may be possible.'], '01261': ['Attempt to exceed the maximum number of acquired devices.'],
  '01271': ['Attempt to acquire a device that is not available.'], '01281': ['Operation to a device that is not acquired.'], '01282': ['Job is ending with the controlled option.'],
  '01284': ['Unable to acquire a second device for a single-device file.'], '01285': ['Device already acquired.'], '01286': ['Attempt to open a shared file with the SAVDS or IND options.'],
  '01287': ['Response indicators overlap the IND indicators.'], '01299': ['Other I/O error.', 'See the job log for the CPF message.'], '01331': ['Wait time exceeded on a READ from a WORKSTN file.'],
};

export function explainSqlcode(code: number): CodeInfo | undefined {
  const e = SQLCODES[code];
  if (e) { return { kind: 'SQLCODE', code: String(code), text: e[1], fix: e[2], other: e[0] === '(user)' ? undefined : `SQLSTATE ${e[0]}` }; }
  if (code > 0) { return { kind: 'SQLCODE', code: String(code), text: 'A positive SQLCODE is a warning: the statement ran. See the message SQL' + String(code).padStart(4, '0') + ' for details.' }; }
  if (code < 0 && code > -100000) { return { kind: 'SQLCODE', code: String(code), text: `An error. The message is SQL${String(-code).padStart(4, '0')} in QSQLMSG (Explain Message shows its text).` }; }
  return undefined;
}

export function explainSqlstate(state: string): CodeInfo | undefined {
  const s = state.toUpperCase();
  if (!/^[0-9A-Z]{5}$/.test(s)) { return undefined; }
  const cls = SQLSTATE_CLASS[s.slice(0, 2)];
  if (!cls) { return undefined; }
  const codes = Object.entries(SQLCODES).filter(([, v]) => v[0] === s);
  return { kind: 'SQLSTATE', code: s, text: codes.length ? codes.map(([c, v]) => `${v[1]} (SQLCODE ${c})`).join(' / ') : `Class ${s.slice(0, 2)}: ${cls}.`,
    fix: codes.find(([, v]) => v[2])?.[1][2], other: `Class ${s.slice(0, 2)}: ${cls}` };
}

export function explainStatus(status: string | number): CodeInfo | undefined {
  const s = String(status).padStart(5, '0');
  const e = RPG_STATUS[s];
  if (e) { return { kind: 'RPG status', code: s, text: e[0], fix: e[1], other: Number(s) >= 1000 ? 'File exception (INFDS *STATUS)' : 'Program exception (PSDS *STATUS)' }; }
  if (/^0\d{4}$/.test(s)) { return { kind: 'RPG status', code: s, text: Number(s) >= 1000 ? 'A file exception / error.' : Number(s) >= 100 ? 'A program exception / error.' : 'A normal condition (not an error).' }; }
  return undefined;
}

/** Explains whatever was typed: "-803", "SQLCODE -803", "23505", "SQLSTATE 23505", "01211", "RNQ1211", "RNX1218". */
export function explainAny(text: string): CodeInfo[] {
  const t = text.trim().toUpperCase().replace(/^(SQLCODE|SQLCOD|SQLCA\.SQLCODE)\s*[:=]?\s*/, 'C').replace(/^(SQLSTATE|SQLSTT)\s*[:=]?\s*/, 'S');
  const out: CodeInfo[] = [];
  const push = (x?: CodeInfo) => { if (x) { out.push(x); } };
  let m: RegExpMatchArray | null;
  if ((m = t.match(/^C\s*([-+]?\d{1,5})$/))) { push(explainSqlcode(+m[1])); return out; }
  if ((m = t.match(/^S\s*'?([0-9A-Z]{5})'?$/))) { push(explainSqlstate(m[1])); return out; }
  if ((m = t.match(/^RN[QX](\d{4})$/))) { push(explainStatus('0' + m[1])); return out; }
  if ((m = t.match(/^SQL(\d{4})$/))) { push(explainSqlcode(-Number(m[1]))); return out; }
  if ((m = t.match(/^[-+]\d{1,5}$/))) { push(explainSqlcode(+t)); return out; }
  if ((m = t.match(/^'?([0-9A-Z]{5})'?$/))) {
    if (/^0\d{4}$/.test(m[1]) && RPG_STATUS[m[1]]) { push(explainStatus(m[1])); }
    if (SQLSTATE_CLASS[m[1].slice(0, 2)] && Object.values(SQLCODES).some(v => v[0] === m![1])) { push(explainSqlstate(m[1])); }
    if (!out.length) { push(explainStatus(m[1]) ?? explainSqlstate(m[1])); }
    return out;
  }
  if ((m = t.match(/^\d{1,4}$/))) { push(explainSqlcode(+t)); push(explainStatus(t)); }
  return out;
}

/** The code under the cursor in a source line, when the line talks about SQLCODE, SQLSTATE or a status. */
export function codeAt(line: string, character: number): { code: CodeInfo; start: number; end: number } | undefined {
  const re = /'[0-9A-Z]{5}'|[-+]?\b\d{1,5}\b/gi;
  let m: RegExpExecArray | null;
  const L = line.toUpperCase();
  while ((m = re.exec(line))) {
    if (character < m.index || character > m.index + m[0].length) { continue; }
    const v = m[0];
    let code: CodeInfo | undefined;
    if (/SQLCODE|SQLCOD\b/.test(L) && /^[-+]?\d+$/.test(v) && v !== '0') { code = explainSqlcode(+v); }
    else if (/SQLSTATE|SQLSTT/.test(L) && /^'.{5}'$/.test(v)) { code = explainSqlstate(v.slice(1, -1)); }
    else if (/%STATUS|\*STATUS|STATUS\b|\bSTS\b/.test(L) && /^\d{4,5}$/.test(v)) { code = RPG_STATUS[v.padStart(5, '0')] ? explainStatus(v) : undefined; }
    if (code) { return { code, start: m.index, end: m.index + v.length }; }
  }
  return undefined;
}
