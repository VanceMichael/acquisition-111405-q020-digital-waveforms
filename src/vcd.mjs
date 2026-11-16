const SPACE = new Set([0x20, 0x09, 0x0a, 0x0d]);
const HORIZONTAL_SPACE = new Set([0x20, 0x09]);
const VALUE_BYTES = new Set([0x30, 0x31, 0x78, 0x58, 0x7a, 0x5a]);

const UNIT_PS = new Map([
  ['s', 1000000000000n],
  ['ms', 1000000000n],
  ['us', 1000000n],
  ['ns', 1000n],
  ['ps', 1n]
]);

const MAX_WIDTH = 1000000;

const isSpace = byte => SPACE.has(byte);
const isHorizontalSpace = byte => HORIZONTAL_SPACE.has(byte);

function findSpace(bytes, from) {
  for (let index = from; index < bytes.length; index++) {
    if (isSpace(bytes[index])) return index;
  }
  return -1;
}

function ascii(bytes, from, to) {
  return bytes.toString('utf8', from, to);
}

function cloneSpan(span) {
  return span === null ? null : structuredClone(span);
}

/**
 * Incremental decoder for the locally supported VCD subset.
 *
 * Bytes are appended in arrival order and only complete lexical units are
 * interpreted. A unit that reaches the end of the arrived bytes is held back
 * until more bytes complete it, unless the stream is explicitly finished.
 */
export class VcdDecoder {
  constructor({runId}) {
    this.runId = runId;
    this.pending = Buffer.alloc(0);
    this.base = 0;
    this.total = 0;
    this.segments = [];
    this.records = [];
    this.field = null;
    this.scopes = [];
    this.codes = new Map();
    this.timescale = null;
    this.timescaleConflict = false;
    this.seenDefinitions = false;
    this.time = null;
    this.dumpState = 'observed';
    this.occurrences = new Map();
    this.issuesSeen = new Set();
    this.issueList = [];
    this.incomplete = false;
    this.reportedUnclosedScope = false;
  }

  push({index, url, bytes}) {
    const start = this.total;
    this.segments.push({index, url, start, end: start + bytes.length});
    this.total += bytes.length;
    this.pending = this.pending.length === 0 ? bytes : Buffer.concat([this.pending, bytes]);
    this.drain(false);
  }

  finish({eof}) {
    this.drain(eof);
    if (this.pending.length > 0) {
      this.issue('incomplete-fragment', '片段在本次接收结束时尚未闭合，未作解释', this.base, this.base + this.pending.length);
    }
    if (this.field) {
      this.issue('unclosed-command', `命令${this.field.command}缺少$end结尾`, this.field.startAbs, this.base + this.pending.length);
    }
    if (!this.seenDefinitions) {
      this.issue('missing-enddefinitions', '缺少$enddefinitions，声明区未闭合');
    }
    if (this.scopes.length > 0 && !this.reportedUnclosedScope) {
      this.issue('unclosed-scope', '仍有未$upscope的层次作用域', undefined, undefined, {sourceSpan: this.scopes.at(-1).span});
    }
    return {records: this.records, incomplete: this.incomplete, issues: [...this.issueList]};
  }

  issue(kind, message, startAbs, endAbs, extra = {}) {
    const key = kind + '\u0000' + message + '\u0000' + (extra.code ?? '');
    if (this.issuesSeen.has(key)) return;
    this.issuesSeen.add(key);
    this.incomplete = true;
    const item = {kind, message, ...extra};
    if (typeof startAbs === 'number') {
      item.sourceSpan = this.span(startAbs, typeof endAbs === 'number' ? endAbs : startAbs);
    } else if (!('sourceSpan' in item) && this.segments.length > 0) {
      item.sourceSpan = this.span(this.base, this.base);
    }
    this.issueList.push(item);
  }

  span(startAbs, endAbs) {
    if (this.segments.length === 0) return null;
    return {
      start: this.locateStart(startAbs),
      end: this.locateEnd(endAbs),
      length: Math.max(0, endAbs - startAbs)
    };
  }

  locateStart(absolute) {
    const index = this.segmentIndex(absolute);
    if (index !== -1) {
      const segment = this.segments[index];
      return {url: segment.url, chunk: segment.index, offset: absolute - segment.start};
    }
    const last = this.segments.at(-1);
    return {url: last.url, chunk: last.index, offset: last.end - last.start};
  }

  locateEnd(absolute) {
    if (absolute > 0) {
      const earlier = this.segmentIndex(absolute - 1);
      if (earlier !== -1) {
        const segment = this.segments[earlier];
        return {url: segment.url, chunk: segment.index, offset: absolute - segment.start};
      }
    }
    return {url: this.segments[0].url, chunk: this.segments[0].index, offset: 0};
  }

  segmentIndex(absolute) {
    let low = 0;
    let high = this.segments.length - 1;
    while (low <= high) {
      const middle = (low + high) >> 1;
      const segment = this.segments[middle];
      if (absolute < segment.start) high = middle - 1;
      else if (absolute >= segment.end) low = middle + 1;
      else return middle;
    }
    return -1;
  }

  take(length) {
    this.pending = this.pending.subarray(length);
    this.base += length;
  }

  compact() {
    if (this.pending.length === 0) {
      this.pending = Buffer.alloc(0);
    } else if (this.pending.length < 4096 && this.pending.buffer.byteLength > 65536) {
      this.pending = Buffer.from(this.pending);
    }
  }

  drain(eof) {
    for (;;) {
      let leading = 0;
      while (leading < this.pending.length && isSpace(this.pending[leading])) leading++;
      if (leading > 0) this.take(leading);
      if (this.pending.length === 0) {
        this.compact();
        return;
      }
      const unit = this.field && this.field.kind !== 'dump'
        ? this.scanWord(eof)
        : this.scanStep(eof);
      if (!unit) {
        this.compact();
        return;
      }
      this.take(unit.consume);
      if (unit.kind === 'word') this.handleWord(unit);
      else if (this.field && this.field.kind === 'dump') this.handleDump(unit);
      else this.handleTop(unit);
    }
  }

  scanWord(eof) {
    const end = findSpace(this.pending, 0);
    if (end === -1 && !eof) return null;
    const length = end === -1 ? this.pending.length : end;
    return {
      kind: 'word',
      text: ascii(this.pending, 0, length),
      start: this.base,
      end: this.base + length,
      consume: length,
      terminated: end !== -1
    };
  }

  scanScalar(eof) {
    const end = findSpace(this.pending, 1);
    if (end === -1 && !eof) return null;
    const length = end === -1 ? this.pending.length : end;
    return {
      kind: 'scalar',
      value: ascii(this.pending, 0, 1).toLowerCase(),
      code: ascii(this.pending, 1, length),
      start: this.base,
      end: this.base + length,
      consume: length,
      terminated: end !== -1
    };
  }

  scanVector(eof) {
    const bitsEnd = findSpace(this.pending, 1);
    if (bitsEnd === -1 && !eof) return null;
    if (bitsEnd === -1) {
      return {
        kind: 'vector',
        bits: ascii(this.pending, 1, this.pending.length),
        code: '',
        start: this.base,
        end: this.base + this.pending.length,
        consume: this.pending.length,
        terminated: false
      };
    }
    if (!isHorizontalSpace(this.pending[bitsEnd])) {
      return {
        kind: 'vector',
        bits: ascii(this.pending, 1, bitsEnd),
        code: '',
        start: this.base,
        end: this.base + bitsEnd,
        consume: bitsEnd,
        terminated: false
      };
    }
    let codeStart = bitsEnd;
    while (codeStart < this.pending.length && isHorizontalSpace(this.pending[codeStart])) codeStart++;
    if (codeStart === this.pending.length && !eof) return null;
    if (codeStart === this.pending.length) {
      return {
        kind: 'vector',
        bits: ascii(this.pending, 1, bitsEnd),
        code: '',
        start: this.base,
        end: this.base + codeStart,
        consume: codeStart,
        terminated: false
      };
    }
    const codeEnd = findSpace(this.pending, codeStart);
    if (codeEnd === -1 && !eof) return null;
    const length = codeEnd === -1 ? this.pending.length : codeEnd;
    return {
      kind: 'vector',
      bits: ascii(this.pending, 1, bitsEnd),
      code: ascii(this.pending, codeStart, length),
      start: this.base,
      end: this.base + length,
      consume: length,
      terminated: codeEnd !== -1
    };
  }

  scanTimestamp(eof) {
    const end = findSpace(this.pending, 1);
    if (end === -1 && !eof) return null;
    const length = end === -1 ? this.pending.length : end;
    return {
      kind: 'timestamp',
      text: ascii(this.pending, 1, length),
      start: this.base,
      end: this.base + length,
      consume: length,
      terminated: end !== -1
    };
  }

  scanCommand(eof) {
    const end = findSpace(this.pending, 1);
    if (end === -1 && !eof) return null;
    const length = end === -1 ? this.pending.length : end;
    return {
      kind: 'command',
      text: ascii(this.pending, 0, length),
      start: this.base,
      end: this.base + length,
      consume: length,
      terminated: end !== -1
    };
  }

  scanUnknown(eof) {
    const end = findSpace(this.pending, 0);
    if (end === -1 && !eof) return null;
    const length = end === -1 ? this.pending.length : end;
    return {
      kind: 'unknown',
      text: ascii(this.pending, 0, length),
      start: this.base,
      end: this.base + length,
      consume: length,
      terminated: end !== -1
    };
  }

  scanStep(eof) {
    const first = this.pending[0];
    if (first === 0x24) return this.scanCommand(eof);
    if (first === 0x23) return this.scanTimestamp(eof);
    if (VALUE_BYTES.has(first)) return this.scanScalar(eof);
    if (first === 0x62) return this.scanVector(eof);
    return this.scanUnknown(eof);
  }

  handleTop(unit) {
    if (unit.kind === 'command') {
      this.openCommand(unit);
      return;
    }
    if (unit.kind === 'timestamp') {
      this.setTime(unit);
      return;
    }
    if (unit.kind === 'scalar' || unit.kind === 'vector') {
      this.observe(unit);
      return;
    }
    this.issue('unsupported-token', `未声明的语法片段：${unit.text}`, unit.start, unit.end);
  }

  handleDump(unit) {
    if (unit.kind === 'command') {
      if (unit.text === '$end') {
        this.field = null;
        return;
      }
      this.issue('unexpected-command', `转储块中不得出现${unit.text}`, unit.start, unit.end);
      return;
    }
    if (unit.kind === 'timestamp') {
      this.issue('timestamp-in-dump', '转储块内不得改变时标，未作解释', unit.start, unit.end);
      return;
    }
    if (unit.kind === 'scalar' || unit.kind === 'vector') {
      this.observe(unit);
      return;
    }
    this.issue('unsupported-token', `未声明的语法片段：${unit.text}`, unit.start, unit.end);
  }

  openCommand(unit) {
    const afterDefinitions = this.seenDefinitions;
    if (unit.text === '$end') {
      this.issue('stray-end', '没有可闭合命令的$end', unit.start, unit.end);
      return;
    }
    if (unit.text === '$dumpvars' || unit.text === '$dumpoff' || unit.text === '$dumpon') {
      if (unit.text === '$dumpvars' && this.time === null) this.time = 0n;
      if (unit.text === '$dumpoff') this.dumpState = 'suspended';
      else if (unit.text === '$dumpon') this.dumpState = 'observed';
      this.field = {kind: 'dump', command: unit.text, startAbs: unit.start};
      return;
    }
    if (unit.text === '$enddefinitions') {
      if (afterDefinitions) {
        this.issue('duplicate-enddefinitions', '$enddefinitions重复出现', unit.start, unit.end);
        this.field = {kind: 'unsupported', command: unit.text, args: [], startAbs: unit.start, endAbs: unit.end};
        return;
      }
      this.field = {kind: 'enddefinitions', command: unit.text, args: [], startAbs: unit.start, endAbs: unit.end};
      return;
    }
    if (unit.text === '$timescale' || unit.text === '$scope' || unit.text === '$upscope' || unit.text === '$var') {
      const kind = unit.text.slice(1);
      if (afterDefinitions) {
        this.issue('declaration-after-definitions', `${unit.text}出现在$enddefinitions之后，未作声明解释`, unit.start, unit.end);
        this.field = {kind: 'unsupported', command: unit.text, args: [], startAbs: unit.start, endAbs: unit.end};
        return;
      }
      this.field = {kind, command: unit.text, args: [], startAbs: unit.start, endAbs: unit.end};
      return;
    }
    this.issue('unsupported-command', `未声明的命令：${unit.text}`, unit.start, unit.end);
    this.field = {kind: 'unsupported', command: unit.text, args: [], startAbs: unit.start, endAbs: unit.end};
  }

  handleWord(unit) {
    const field = this.field;
    if (!field) {
      this.issue('unsupported-token', `未声明的语法片段：${unit.text}`, unit.start, unit.end);
      return;
    }
    if (unit.text === '$end') {
      this.field = null;
      this.closeField(field, unit);
      return;
    }
    field.args.push(unit.text);
    field.endAbs = unit.end;
    if (field.args.length > 12) {
      this.issue('command-too-long', `${field.command}参数过多`, field.startAbs, unit.end);
      this.field = {kind: 'unsupported', command: field.command, args: [], startAbs: field.startAbs, endAbs: unit.end};
    }
  }

  closeField(field, closing) {
    if (field.kind === 'unsupported') return;
    if (field.kind === 'enddefinitions') {
      if (field.args.length > 0) {
        this.issue('invalid-enddefinitions', '$enddefinitions不得带参数', field.startAbs, closing.end);
      }
      this.seenDefinitions = true;
      if (this.scopes.length > 0) {
        this.reportedUnclosedScope = true;
        this.issue('unclosed-scope', '声明区结束时仍有未$upscope的层次作用域', field.startAbs, closing.end);
      }
      return;
    }
    if (field.kind === 'timescale') {
      this.closeTimescale(field, closing);
      return;
    }
    if (field.kind === 'scope') {
      this.closeScope(field, closing);
      return;
    }
    if (field.kind === 'upscope') {
      if (field.args.length > 0) {
        this.issue('invalid-upscope', '$upscope不得带参数', field.startAbs, closing.end);
      }
      if (this.scopes.length === 0) {
        this.issue('unmatched-upscope', '$upscope没有对应的$scope', field.startAbs, closing.end);
        return;
      }
      this.scopes.pop();
      return;
    }
    if (field.kind === 'var') this.closeVar(field, closing);
  }

  closeTimescale(field, closing) {
    let amount;
    let unit;
    if (field.args.length !== 2) {
      this.issue('invalid-timescale', '$timescale需要数值和时间单位', field.startAbs, closing.end);
      this.timescaleConflict = true;
      return;
    }
    [amount, unit] = field.args;
    if (!/^\d+$/.test(amount) || !UNIT_PS.has(unit) || BigInt(amount) <= 0n) {
      this.issue('invalid-timescale', `不支持的时间单位或数值：${amount} ${unit}`, field.startAbs, closing.end);
      this.timescaleConflict = true;
      return;
    }
    if (this.timescale || this.timescaleConflict) {
      this.issue('duplicate-timescale', '$timescale重复出现，时间换算未确定', field.startAbs, closing.end);
      this.timescaleConflict = true;
      return;
    }
    const factor = UNIT_PS.get(unit);
    const value = BigInt(amount);
    this.timescale = {
      text: `${amount} ${unit}`,
      value: amount,
      unit,
      psPerUnit: value * factor
    };
  }

  closeScope(field, closing) {
    const [type, name, ...rest] = field.args;
    const span = this.span(field.startAbs, closing.end);
    if (!type || !name || rest.length > 0 || type !== 'module') {
      this.issue('unsupported-scope', `仅支持$scope module NAME $end`, field.startAbs, closing.end);
      this.scopes.push({name: name ?? '', supported: false, span});
      return;
    }
    this.scopes.push({name, supported: true, span});
  }

  closeVar(field, closing) {
    const [type, widthText, code, name, ...rest] = field.args;
    const span = this.span(field.startAbs, closing.end);
    if (!type || !widthText || !code || !name || rest.length > 0) {
      this.issue('invalid-var', '$var需要wire、宽度、短代码和一个信号名', field.startAbs, closing.end);
      return;
    }
    if (type !== 'wire') {
      this.issue('unsupported-var-type', `未声明的信号类型：${type}`, field.startAbs, closing.end);
      return;
    }
    if (!/^\d+$/.test(widthText) || BigInt(widthText) <= 0n || BigInt(widthText) > BigInt(MAX_WIDTH)) {
      this.issue('invalid-width', `信号宽度无效：${widthText}`, field.startAbs, closing.end);
      return;
    }
    const width = Number(widthText);
    if (this.scopes.some(scope => !scope.supported)) {
      this.issue('unsupported-scope-member', `信号${code}位于未支持的层次中，未作声明解释`, field.startAbs, closing.end, {code});
      return;
    }
    const path = [...this.scopes.map(scope => scope.name), name].join('.');
    let entry = this.codes.get(code);
    if (!entry) {
      entry = {declarations: [], widths: new Set(), conflict: false};
      this.codes.set(code, entry);
    }
    const samePath = entry.declarations.find(declaration => declaration.path === path);
    if (samePath) {
      if (samePath.width !== width) {
        entry.conflict = true;
        this.issue('alias-width-conflict', `短代码${code}对应不兼容的宽度声明`, field.startAbs, closing.end, {code});
      }
      return;
    }
    entry.widths.add(width);
    entry.declarations.push({type, width, code, name, path, sourceSpan: span});
    if (entry.widths.size > 1) {
      entry.conflict = true;
      this.issue('alias-width-conflict', `短代码${code}对应不兼容的宽度声明`, field.startAbs, closing.end, {code});
    }
  }

  setTime(unit) {
    if (!/^\d+$/.test(unit.text)) {
      this.issue('invalid-timestamp', `时标不是非负整数：${unit.text}`, unit.start, unit.end);
      this.time = null;
      return;
    }
    this.time = BigInt(unit.text);
  }

  observe(unit) {
    if (!unit.terminated && !unit.code) {
      this.issue('incomplete-fragment', '信号值片段在资料结束时尚未闭合，未作解释', unit.start, unit.end, {code: unit.code});
      return;
    }
    if (!this.seenDefinitions) {
      this.issue('value-before-definitions', '信号值出现在$enddefinitions之前，未作解释', unit.start, unit.end, {code: unit.code});
      return;
    }
    if (!this.timescale) {
      this.issue('missing-timescale',
        this.timescaleConflict ? '时间换算未确定，信号值未作解释' : '缺少$timescale，无法换算时标',
        unit.start, unit.end, {code: unit.code});
      return;
    }
    if (this.time === null) {
      this.issue('missing-timestamp', '信号值之前缺少#时标', unit.start, unit.end, {code: unit.code});
      return;
    }
    const entry = this.codes.get(unit.code);
    if (!entry) {
      this.issue('undeclared-code', `短代码未声明：${unit.code}`, unit.start, unit.end, {code: unit.code});
      return;
    }
    if (entry.conflict) {
      this.issue('alias-width-conflict', `短代码${unit.code}的声明宽度不兼容，信号值未作解释`, unit.start, unit.end, {code: unit.code});
      return;
    }
    const width = entry.declarations[0].width;
    let bits;
    if (unit.kind === 'scalar') {
      if (width !== 1) {
        this.issue('scalar-width-mismatch', `标量值不能解释为${width}位信号`, unit.start, unit.end, {code: unit.code});
        return;
      }
      bits = unit.value;
    } else {
      const raw = unit.bits.toLowerCase();
      if (!raw || !/^[01xz]+$/.test(raw)) {
        this.issue('invalid-vector', `向量值无效：b${unit.bits}`, unit.start, unit.end, {code: unit.code});
        return;
      }
      if (raw.length > width) {
        this.issue('vector-width-overflow', `向量值b${unit.bits}超过声明宽度${width}`, unit.start, unit.end, {code: unit.code});
        return;
      }
      if (raw.length < width) {
        const fill = raw[0] === 'x' || raw[0] === 'z' ? raw[0] : '0';
        bits = fill.repeat(width - raw.length) + raw;
      } else {
        bits = raw;
      }
    }
    const timePs = (this.time * this.timescale.psPerUnit).toString();
    const sourceSpan = this.span(unit.start, unit.end);
    const aliases = entry.declarations.map(declaration => ({
      path: declaration.path,
      name: declaration.name,
      width: declaration.width,
      sourceSpan: cloneSpan(declaration.sourceSpan)
    }));
    for (const declaration of entry.declarations) {
      const key = declaration.path + '\u0000' + timePs;
      const occurrence = (this.occurrences.get(key) ?? 0) + 1;
      this.occurrences.set(key, occurrence);
      this.records.push({
        id: `wave:${this.runId}:${declaration.path}:${timePs}:${occurrence}`,
        runId: this.runId,
        signalPath: declaration.path,
        code: declaration.code,
        timePs,
        bits,
        status: this.dumpState,
        timescale: {
          text: this.timescale.text,
          value: this.timescale.value,
          unit: this.timescale.unit,
          psPerUnit: this.timescale.psPerUnit.toString()
        },
        declaration: {
          type: declaration.type,
          width: declaration.width,
          code: declaration.code,
          name: declaration.name,
          path: declaration.path,
          sourceSpan: cloneSpan(declaration.sourceSpan)
        },
        aliases,
        sourceSpan
      });
    }
  }
}

export function createVcdDecoder(options) {
  return new VcdDecoder(options);
}
