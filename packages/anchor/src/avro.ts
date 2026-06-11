// ANS-104 tag encoding: an Avro array of {name, value} string records.
// Byte-for-byte port of the agent's Go reference (internal/anchor/avro.go),
// verified against arweave-js / turbo-sdk / goar. Single positive-count
// block + zero terminator; tag lists this size never need multi-block.

export interface Tag {
  name: string;
  value: string;
}

const te = new TextEncoder();

export function encodeAvroTags(tags: Tag[]): Uint8Array {
  if (tags.length === 0) return new Uint8Array([0x00]);
  if (tags.length > 127) {
    throw new Error("tag count > 127 not supported (single-block Avro encoder)");
  }

  const parts: number[] = [];
  writeAvroVarintLong(parts, tags.length);
  for (const t of tags) {
    writeAvroString(parts, t.name);
    writeAvroString(parts, t.value);
  }
  writeAvroVarintLong(parts, 0); // terminator: zero-count block
  return new Uint8Array(parts);
}

function writeAvroString(out: number[], s: string): void {
  const bytes = te.encode(s);
  writeAvroVarintLong(out, bytes.length);
  for (const b of bytes) out.push(b);
}

// Zigzag-encoded Avro varint (long): n*2 for non-negative n, then 7 bits per
// byte LSB-first with a continuation bit on every byte except the last.
function writeAvroVarintLong(out: number[], n: number): void {
  if (!Number.isInteger(n) || n < 0) {
    throw new Error(`avro varint: non-negative integer required, got ${n}`);
  }
  let u = n * 2; // zigzag for non-negative values; safe: tag/string sizes ≪ 2^52
  for (;;) {
    const b = u & 0x7f;
    u = Math.floor(u / 128);
    if (u !== 0) {
      out.push(b | 0x80);
    } else {
      out.push(b);
      return;
    }
  }
}
