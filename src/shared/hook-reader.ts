// One relay frame: header newline, then JSON without an EOF requirement. Scan
// only arriving bytes; reparsing every growing prefix makes fragmented hooks quadratic.
export type HookFrame = { header: string; input: unknown };
export type HookRead = { kind: 'pending' } | { kind: 'too-large' } | { kind: 'frame'; frame: HookFrame };
const PENDING: HookRead = { kind: 'pending' };
const SPACE = (byte: number): boolean => byte === 32 || byte === 9 || byte === 10 || byte === 13;
const DIGIT = (byte: number): boolean => byte >= 48 && byte <= 57;
type NumberState = 'sign' | 'zero' | 'integer' | 'dot' | 'fraction' | 'exponent' | 'exponent-sign' | 'exponent-digits';

/** A completion detector, not a JSON validator: JSON.parse remains the oracle. */
class JsonBoundary {
  private kind: 'empty' | 'container' | 'string' | 'literal' | 'number' | 'closed' | 'invalid' = 'empty';
  private depth = 0;
  private quoted = false;
  private escaped = false;
  private literal = '';
  private literalAt = 0;
  private number: NumberState = 'sign';

  get complete(): boolean {
    return this.kind === 'closed' || (this.kind === 'number' && ['zero', 'integer', 'fraction', 'exponent-digits'].includes(this.number));
  }

  read(byte: number): void {
    if (this.kind === 'invalid') return;
    if (this.kind === 'closed') { if (!SPACE(byte)) this.kind = 'invalid'; return; }
    if (this.kind === 'empty') {
      if (SPACE(byte)) return;
      if (byte === 123 || byte === 91) { this.kind = 'container'; this.depth = 1; return; }
      if (byte === 34) { this.kind = 'string'; this.quoted = true; return; }
      if (byte === 116 || byte === 102 || byte === 110) {
        this.kind = 'literal'; this.literal = byte === 116 ? 'true' : byte === 102 ? 'false' : 'null'; this.literalAt = 1; return;
      }
      if (byte === 45 || DIGIT(byte)) {
        this.kind = 'number'; this.number = byte === 45 ? 'sign' : byte === 48 ? 'zero' : 'integer'; return;
      }
      this.kind = 'invalid'; return;
    }
    if (this.kind === 'literal') {
      if (byte !== this.literal.charCodeAt(this.literalAt++)) this.kind = 'invalid';
      else if (this.literalAt === this.literal.length) this.kind = 'closed';
      return;
    }
    if (this.kind === 'number') { this.readNumber(byte); return; }
    if (this.quoted) {
      if (this.escaped) this.escaped = false;
      else if (byte === 92) this.escaped = true;
      else if (byte === 34) { this.quoted = false; if (this.kind === 'string') this.kind = 'closed'; }
      return;
    }
    if (byte === 34) this.quoted = true;
    else if (byte === 123 || byte === 91) this.depth++;
    else if (byte === 125 || byte === 93) { if (--this.depth === 0) this.kind = 'closed'; }
  }

  private readNumber(byte: number): void {
    if (SPACE(byte)) { this.kind = this.complete ? 'closed' : 'invalid'; return; }
    const digit = DIGIT(byte);
    switch (this.number) {
      case 'sign': if (digit) { this.number = byte === 48 ? 'zero' : 'integer'; return; } break;
      case 'zero':
      case 'integer':
        if (digit && this.number === 'integer') return;
        if (byte === 46) { this.number = 'dot'; return; }
        if (byte === 101 || byte === 69) { this.number = 'exponent'; return; }
        break;
      case 'dot': if (digit) { this.number = 'fraction'; return; } break;
      case 'fraction':
        if (digit) return;
        if (byte === 101 || byte === 69) { this.number = 'exponent'; return; }
        break;
      case 'exponent':
        if (byte === 43 || byte === 45) { this.number = 'exponent-sign'; return; }
        if (digit) { this.number = 'exponent-digits'; return; }
        break;
      case 'exponent-sign': if (digit) { this.number = 'exponent-digits'; return; } break;
      case 'exponent-digits': if (digit) return; break;
    }
    this.kind = 'invalid';
  }
}

export class HookReader {
  private bytes = new Uint8Array();
  private size = 0;
  private headerEnd = -1;
  private readonly json = new JsonBoundary();
  // Buffer.toString, used by the previous receiver, preserves a UTF-8 BOM.
  private readonly decoder = new TextDecoder('utf8', { ignoreBOM: true });
  private readonly limit: number;
  private failed = false;
  private result: HookRead | null = null;

  constructor(limit: number) { this.limit = limit; }

  read(chunk: Uint8Array): HookRead {
    if (this.result) return this.result;
    if (chunk.byteLength > this.limit - this.size) return this.result = { kind: 'too-large' };
    const next = this.size + chunk.byteLength;
    if (next > this.bytes.length) {
      const grown = new Uint8Array(Math.min(this.limit, Math.max(next, this.bytes.length * 2, 4096)));
      grown.set(this.bytes.subarray(0, this.size));
      this.bytes = grown;
    }
    this.bytes.set(chunk, this.size);
    let position = this.size;
    for (const byte of chunk) {
      if (this.headerEnd < 0) { if (byte === 10) this.headerEnd = position; }
      else this.json.read(byte);
      position++;
    }
    this.size = next;
    // Check only after the whole chunk: a valid root followed by junk in this
    // same chunk was never accepted by the old receiver's JSON.parse either.
    if (!this.failed && this.headerEnd >= 0 && this.json.complete) {
      try { return this.frame(JSON.parse(this.decoder.decode(this.bytes.subarray(this.headerEnd + 1, this.size)))); }
      catch { this.failed = true; }
    }
    return PENDING;
  }

  /** Preserve the existing empty/malformed-body fallback, only at sender EOF. */
  end(): HookRead { return this.result ?? (this.headerEnd < 0 ? PENDING : this.frame({})); }

  private frame(input: unknown): HookRead {
    return this.result = { kind: 'frame', frame: { header: this.decoder.decode(this.bytes.subarray(0, this.headerEnd)), input } };
  }
}
