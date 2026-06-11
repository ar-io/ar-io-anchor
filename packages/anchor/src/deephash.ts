// Arweave's deep-hash algorithm — the message an ANS-104 data-item signature
// covers. Byte-for-byte port of the agent's Go reference
// (ar-io-agent internal/anchor/deephash.go), itself cross-validated against
// arweave-js / arbundles / goar. Output is a 48-byte SHA-384 digest.
//
//   chunk(data) = sha384( sha384("blob" + len(data)) || sha384(data) )
//   list(items) = fold( sha384(acc || chunk(item)),
//                       acc0 = sha384("list" + len(items)) )

const te = new TextEncoder();

async function sha384(bytes: Uint8Array): Promise<Uint8Array> {
  return new Uint8Array(
    await crypto.subtle.digest("SHA-384", bytes as unknown as BufferSource),
  );
}

function concat(a: Uint8Array, b: Uint8Array): Uint8Array {
  const out = new Uint8Array(a.length + b.length);
  out.set(a, 0);
  out.set(b, a.length);
  return out;
}

export async function deepHashChunk(data: Uint8Array): Promise<Uint8Array> {
  const tagHash = await sha384(te.encode(`blob${data.length}`));
  const dataHash = await sha384(data);
  return sha384(concat(tagHash, dataHash));
}

export async function deepHashList(items: Uint8Array[]): Promise<Uint8Array> {
  let acc = await sha384(te.encode(`list${items.length}`));
  for (const item of items) {
    acc = await sha384(concat(acc, await deepHashChunk(item)));
  }
  return acc;
}
