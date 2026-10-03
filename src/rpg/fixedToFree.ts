// Fixed-format RPG IV C-spec -> free-format converter (pure module, unit tested).
// Converts the common operation codes; anything it can't safely convert is kept as a
// "// TODO" comment so nothing is silently lost.

export interface ConvertOptions {
  /** Prefix for every output line: '' for **FREE sources, 7 spaces for column-8 free form. */
  baseIndent?: string;
  /** Indentation per nesting level. */
  step?: string;
}

export interface ConvertResult {
  lines: string[];
  /** Number of lines that need a manual check (TODO comments). */
  todo: number;
}

interface CSpec {
  neg: boolean;
  ind: string;
  f1: string;
  op: string;
  ext: string;
  f2: string;
  result: string;
  hi: string;
  lo: string;
  eq: string;
  extF2: string;
  comment: string;
}

const CMP: Record<string, string> = { EQ: '=', NE: '<>', GT: '>', LT: '<', GE: '>=', LE: '<=' };

function parseC(line: string): CSpec {
  const l = line.padEnd(100, ' ');
  const opField = l.substring(25, 35).trim().toUpperCase();
  const m = opField.match(/^([A-Z0-9-]+)(?:\(([A-Z ]+)\))?$/);
  return {
    neg: l[8].toUpperCase() === 'N',
    ind: l.substring(9, 11).trim(),
    f1: l.substring(11, 25).trim(),
    op: m ? m[1] : opField,
    ext: m && m[2] ? m[2].trim() : '',
    f2: l.substring(35, 49).trim(),
    result: l.substring(49, 63).trim(),
    hi: l.substring(70, 72).trim(),
    lo: l.substring(72, 74).trim(),
    eq: l.substring(74, 76).trim(),
    extF2: l.substring(35, 80).trim(),
    comment: line.length > 80 ? line.substring(80).trim() : '',
  };
}

type Block = { type: 'if' | 'do' | 'for' | 'select' | 'monitor' | 'sr'; inner: boolean };

export function convertFixedToFree(input: string[], options: ConvertOptions = {}): ConvertResult {
  const base = options.baseIndent ?? '       ';
  const step = options.step ?? '  ';
  const out: string[] = [];
  const stack: Block[] = [];
  let level = 0;
  let todo = 0;
  let lastConditionIndex = -1;
  let pendingCall: { line: number; parms: string[] } | undefined;

  const emit = (text: string) => { out.push(base + step.repeat(Math.max(0, level)) + text); };
  const flag = (text: string) => { todo++; emit(`// TODO: ${text}`); };
  const closeCall = () => {
    if (pendingCall) {
      const parms = pendingCall.parms.length ? ` parms: ${pendingCall.parms.join(', ')}` : '';
      out[pendingCall.line] += parms;
      pendingCall = undefined;
    }
  };
  const ext = (c: CSpec, op: string) => (c.ext ? `${op}(${c.ext.toLowerCase()}) ` : '');
  const blockEnd = (types: Block['type'][], keyword: string) => {
    const top = stack[stack.length - 1];
    if (top && types.includes(top.type)) {
      stack.pop();
      if (top.inner) { level--; }
      level--;
      emit(keyword);
    } else {
      level = Math.max(0, level - 1);
      emit(keyword);
    }
  };

  for (const raw of input) {
    const line = raw.replace(/\s+$/, '');
    const spec = (line[5] ?? ' ').toUpperCase();
    const col7 = line[6] ?? ' ';

    if (!line.trim()) { out.push(''); continue; }
    if (/^\s*\/(free|end-free)\b/i.test(line.substring(5))) { continue; }
    if (col7 === '*') { out.push(base + step.repeat(level) + '//' + line.substring(7).replace(/^(\s?)/, ' ').trimEnd()); continue; }
    if (spec !== 'C') { out.push(line); continue; }

    const c = parseC(line);
    if (pendingCall && c.op !== 'PARM') { closeCall(); }

    const conditioned = !!c.ind && !['IF', 'ELSE', 'ELSEIF', 'DOW', 'DOU', 'SELECT', 'WHEN', 'OTHER', 'BEGSR', 'ENDSR'].includes(c.op)
      && !c.op.startsWith('END') && !/^(AND|OR)(EQ|NE|GT|LT|GE|LE)$/.test(c.op);
    if (conditioned) { emit(`if ${c.neg ? 'not ' : ''}*in${c.ind};`); level++; }

    const before = out.length;
    const op = c.op;
    const cmpMatch = op.match(/^(IF|DOW|DOU|WHEN|AND|OR)(EQ|NE|GT|LT|GE|LE)$/);

    if (cmpMatch) {
      const cond = `${c.f1} ${CMP[cmpMatch[2]]} ${c.f2}`;
      const kind = cmpMatch[1];
      if (kind === 'AND' || kind === 'OR') {
        if (lastConditionIndex >= 0) {
          out[lastConditionIndex] = out[lastConditionIndex].replace(/;$/, ` ${kind.toLowerCase()} ${cond};`);
        } else { flag(`${op} ${c.f1} ${c.f2}`); }
      } else if (kind === 'WHEN') {
        whenLike(`when ${cond};`);
      } else {
        emit(`${kind === 'IF' ? 'if' : kind.toLowerCase()} ${cond};`);
        lastConditionIndex = out.length - 1;
        stack.push({ type: kind === 'IF' ? 'if' : 'do', inner: false });
        level++;
      }
    } else {
      switch (op) {
        case 'EVAL': emit(`${ext(c, 'eval')}${c.extF2};`); break;
        case 'EVALR': emit(`evalr ${c.extF2};`); break;
        case 'CALLP': emit(`${c.extF2};`); break;
        case 'IF': emit(`if ${c.extF2};`); lastConditionIndex = out.length - 1; stack.push({ type: 'if', inner: false }); level++; break;
        case 'ELSEIF': level--; emit(`elseif ${c.extF2};`); lastConditionIndex = out.length - 1; level++; break;
        case 'ELSE': level--; emit('else;'); level++; break;
        case 'DOW': case 'DOU':
          emit(`${op.toLowerCase()} ${c.extF2};`); lastConditionIndex = out.length - 1; stack.push({ type: 'do', inner: false }); level++; break;
        case 'FOR': emit(`for ${c.extF2};`); stack.push({ type: 'for', inner: false }); level++; break;
        case 'DO':
          if (c.result) {
            emit(`for ${c.result} = ${c.f1 || '1'} to ${c.f2 || '1'};`);
            stack.push({ type: 'for', inner: false }); level++;
          } else {
            todo++; emit(`// TODO: DO ${c.f2} without an index – rewritten as a counted FOR loop over a new variable`);
            emit(`for i = ${c.f1 || '1'} to ${c.f2 || '1'};`); stack.push({ type: 'for', inner: false }); level++;
          }
          break;
        case 'SELECT': emit('select;'); stack.push({ type: 'select', inner: false }); level++; break;
        case 'WHEN': whenLike(`when ${c.extF2};`); break;
        case 'OTHER': whenLike('other;'); break;
        case 'MONITOR': emit('monitor;'); stack.push({ type: 'monitor', inner: false }); level++; break;
        case 'ON-ERROR': whenLike(`on-error${c.extF2 ? ' ' + c.extF2 : ''};`); break;
        case 'ENDIF': blockEnd(['if'], 'endif;'); break;
        case 'ENDDO': blockEnd(['do'], 'enddo;'); break;
        case 'ENDFOR': blockEnd(['for'], 'endfor;'); break;
        case 'ENDSL': blockEnd(['select'], 'endsl;'); break;
        case 'ENDMON': blockEnd(['monitor'], 'endmon;'); break;
        case 'END': {
          const top = stack[stack.length - 1];
          const kw = top ? { if: 'endif;', do: 'enddo;', for: 'endfor;', select: 'endsl;', monitor: 'endmon;', sr: 'endsr;' }[top.type] : 'endif;';
          blockEnd(top ? [top.type] : ['if'], kw);
          break;
        }
        case 'BEGSR': emit(`begsr ${c.f1};`); stack.push({ type: 'sr', inner: false }); level++; break;
        case 'ENDSR': blockEnd(['sr'], 'endsr;'); break;
        case 'EXSR': emit(`exsr ${c.f2};`); break;
        case 'LEAVE': case 'ITER': case 'LEAVESR': emit(`${op.toLowerCase()};`); break;
        case 'RETURN': emit(`return${c.extF2 ? ' ' + c.extF2 : ''};`); break;
        case 'CHAIN':
          emit(`${ext(c, 'chain') || 'chain '}${c.f1} ${c.f2}${c.result ? ' ' + c.result : ''};`);
          if (c.hi) { emit(`*in${c.hi} = not %found(${c.f2});`); }
          if (c.lo) { emit(`*in${c.lo} = %error();`); }
          break;
        case 'READ': case 'READP': case 'READC':
          emit(`${ext(c, op.toLowerCase()) || op.toLowerCase() + ' '}${c.f2}${c.result ? ' ' + c.result : ''};`);
          if (c.lo) { emit(`*in${c.lo} = %error();`); }
          if (c.eq) { emit(`*in${c.eq} = %eof(${c.f2});`); }
          break;
        case 'READE': case 'READPE':
          emit(`${ext(c, op.toLowerCase()) || op.toLowerCase() + ' '}${c.f1} ${c.f2}${c.result ? ' ' + c.result : ''};`);
          if (c.lo) { emit(`*in${c.lo} = %error();`); }
          if (c.eq) { emit(`*in${c.eq} = %eof(${c.f2});`); }
          break;
        case 'SETLL': case 'SETGT':
          emit(`${op.toLowerCase()} ${c.f1} ${c.f2};`);
          if (c.hi) { emit(`*in${c.hi} = not %found(${c.f2});`); }
          if (c.eq && op === 'SETLL') { emit(`*in${c.eq} = %equal(${c.f2});`); }
          break;
        case 'WRITE': case 'UPDATE':
          emit(`${op.toLowerCase()} ${c.f2}${c.result ? ' ' + c.result : ''};`);
          if (c.lo) { emit(`*in${c.lo} = %error();`); }
          break;
        case 'DELETE': emit(`delete ${c.f1 ? c.f1 + ' ' : ''}${c.f2};`); if (c.hi) { emit(`*in${c.hi} = not %found(${c.f2});`); } break;
        case 'EXFMT': emit(`exfmt ${c.f2}${c.result ? ' ' + c.result : ''};`); break;
        case 'OPEN': case 'CLOSE': case 'UNLOCK': case 'FEOD': emit(`${op.toLowerCase()} ${c.f2};`); break;
        case 'CLEAR': case 'RESET': emit(`${op.toLowerCase()} ${c.f1 ? c.f1 + ' ' : ''}${c.f2};`); break;
        case 'DSPLY': emit(`dsply ${[c.f1, c.f2, c.result].filter(Boolean).join(' ')};`); break;
        case 'Z-ADD': emit(`${ext(c, 'eval')}${c.result} = ${c.f2};`); break;
        case 'Z-SUB': emit(`${ext(c, 'eval')}${c.result} = -${c.f2};`); break;
        case 'ADD': case 'SUB': case 'MULT': case 'DIV': {
          const sym = { ADD: '+', SUB: '-', MULT: '*', DIV: '/' }[op];
          emit(c.f1
            ? `${ext(c, 'eval')}${c.result} = ${c.f1} ${sym} ${c.f2};`
            : `${ext(c, 'eval')}${c.result} ${sym}= ${c.f2};`);
          break;
        }
        case 'CAT': {
          const [f2, blanks] = c.f2.split(':');
          const left = c.f1 || c.result;
          emit(blanks !== undefined
            ? `${c.result} = %trimr(${left}) + ${blanks.trim() === '0' ? '' : `'${' '.repeat(Number(blanks) || 1)}' + `}${f2.trim()};`
            : `${c.result} = ${left} + ${c.f2};`);
          break;
        }
        case 'MOVE': case 'MOVEL':
          emit(`${c.result} = ${c.f2};`);
          todo++; emit(`// TODO: check ${op} semantics (padding/length/type conversion) for ${c.result}`);
          break;
        case 'SETON': case 'SETOFF':
          for (const i of [c.hi, c.lo, c.eq].filter(Boolean)) { emit(`*in${i} = ${op === 'SETON' ? '*on' : '*off'};`); }
          break;
        case 'CALL':
          todo++; emit(`// TODO: CALL ${c.f2} – declare a prototype (dcl-pr ... extpgm(${c.f2})) and call it`);
          pendingCall = { line: out.length - 1, parms: [] };
          break;
        case 'PARM':
          if (pendingCall) { pendingCall.parms.push(c.result); }
          else { flag(`PARM ${c.result} (move to dcl-pi / dcl-pr)`); }
          break;
        case 'KLIST':
          todo++; emit(`// TODO: KLIST ${c.f1} – replace with a key list in parentheses or %KDS(ds)`);
          break;
        case 'KFLD':
          emit(`//   key field: ${c.result}`);
          break;
        case 'TIME': emit(`${c.result} = %timestamp(); // TODO: TIME stored a timestamp; adjust to %time() / %date() as needed`); todo++; break;
        default:
          flag(`${[c.f1, op + (c.ext ? `(${c.ext})` : ''), c.f2, c.result].filter(Boolean).join(' ')}`);
      }
    }
    if (c.comment && out.length > before) { out[out.length - 1] += ` // ${c.comment}`; }
    if (conditioned) { level--; emit('endif;'); }
  }
  closeCall();
  return { lines: out, todo };

  function whenLike(text: string): void {
    const top = stack[stack.length - 1];
    if (top && (top.type === 'select' || top.type === 'monitor')) {
      if (top.inner) { level--; }
      emit(text);
      level++;
      top.inner = true;
      if (text.startsWith('when')) { lastConditionIndex = out.length - 1; }
    } else {
      emit(text);
    }
  }
}
