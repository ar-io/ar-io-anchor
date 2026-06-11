// ANS-104 v1 data-item construction + signing. Byte-for-byte port of the
// agent's Go reference (internal/anchor/dataitem.go), cross-validated there
// against an independent Python parser and the arbundles KAT.
//
// Wire layout (no target, no anchor for our envelopes):
//
//   2 bytes  signature type (LE uint16)
//   S bytes  signature           (per sig-config)
//   O bytes  owner               (per sig-config)
//   1 byte   target presence = 0
//   1 byte   anchor presence = 0
//   8 bytes  tag count   (LE uint64)
//   8 bytes  tag bytes   (LE uint64)
//   N bytes  Avro-encoded tags
//   M bytes  data (the JCS-canonical envelope bytes)
//
// The SIGNATURE covers the deep hash of
//   [ "dataitem", "1", sig_type_DECIMAL_STRING, owner, target?, anchor?,
//     avro_tags, data ]
// — the decimal-string sigType is the historical footgun (agent commit
// d43d432b): the wire uses 2-byte LE, the deep hash uses the string form.
// ed25519 (sigType 2) signs the RAW 48-byte deep hash directly — the extra
// SHA-256 round seen on the Arweave path is RSA-PSS-specific.

import { sha256Bytes, utf8 } from "@ar.io/proof";

import { encodeAvroTags, type Tag } from "./avro.js";
import { deepHashList } from "./deephash.js";
import type { Signer } from "./types.js";

// Funding-chain signer for data items — distinct from (and never conflated
// with) the envelope identity Signer. Adding a chain (e.g. Ethereum
// secp256k1, sigType 3 — the KMS-custody expansion path) is a new
// implementation of this interface; core stays chain-agnostic.
export interface DataItemSigner {
  readonly sigType: number;
  readonly sigLength: number;
  readonly ownerLength: number;
  // Wire owner bytes (public key / modulus, per chain).
  owner(): Promise<Uint8Array>;
  // Sign the 48-byte deep hash (chain-specific pre-processing inside).
  sign(deepHash: Uint8Array): Promise<Uint8Array>;
}

export const SIGNATURE_TYPE_ARWEAVE = 1;
export const SIGNATURE_TYPE_SOLANA = 2;

// Per-signature-type wire field lengths (mirrors arbundles' SIG_CONFIG).
const SIG_CONFIG: Record<number, { sigLength: number; ownerLength: number }> = {
  [SIGNATURE_TYPE_ARWEAVE]: { sigLength: 512, ownerLength: 512 },
  [SIGNATURE_TYPE_SOLANA]: { sigLength: 64, ownerLength: 32 },
};

// Solana-chain data-item signer: raw ed25519 over the deep hash, 32-byte
// public key as the owner. Wraps any envelope-style Signer (local seed, KMS
// adapter) — the ed25519 math is identical; only the role differs.
export class SolanaWalletSigner implements DataItemSigner {
  readonly sigType = SIGNATURE_TYPE_SOLANA;
  readonly sigLength = 64;
  readonly ownerLength = 32;

  constructor(private readonly inner: Signer) {}

  async owner(): Promise<Uint8Array> {
    return this.inner.publicKey();
  }

  async sign(deepHash: Uint8Array): Promise<Uint8Array> {
    // Raw deep hash — NO extra SHA-256 round (RSA-specific, see header).
    return this.inner.sign(deepHash);
  }
}

export async function dataItemDeepHash(
  sigType: number,
  owner: Uint8Array,
  avroTags: Uint8Array,
  data: Uint8Array,
): Promise<Uint8Array> {
  return deepHashList([
    utf8("dataitem"),
    utf8("1"),
    utf8(String(sigType)), // DECIMAL STRING, never the LE wire form
    owner,
    new Uint8Array(0), // target absent
    new Uint8Array(0), // anchor absent
    avroTags,
    data,
  ]);
}

export async function buildSignedDataItem(
  signer: DataItemSigner,
  data: Uint8Array,
  tags: Tag[],
): Promise<Uint8Array> {
  if (data.length === 0) throw new Error("dataitem: empty data");
  const cfg = SIG_CONFIG[signer.sigType];
  if (!cfg || cfg.sigLength !== signer.sigLength || cfg.ownerLength !== signer.ownerLength) {
    throw new Error(`dataitem: unsupported signer config (sigType ${signer.sigType})`);
  }

  const avroTags = encodeAvroTags(tags);
  const owner = await signer.owner();
  if (owner.length !== cfg.ownerLength) {
    throw new Error(`dataitem: owner is ${owner.length} bytes, want ${cfg.ownerLength}`);
  }

  const dh = await dataItemDeepHash(signer.sigType, owner, avroTags, data);
  const sig = await signer.sign(dh);
  if (sig.length !== cfg.sigLength) {
    throw new Error(`dataitem: signature is ${sig.length} bytes, want ${cfg.sigLength}`);
  }

  const out = new Uint8Array(2 + sig.length + owner.length + 1 + 1 + 16 + avroTags.length + data.length);
  const view = new DataView(out.buffer);
  let pos = 0;
  view.setUint16(pos, signer.sigType, true);
  pos += 2;
  out.set(sig, pos);
  pos += sig.length;
  out.set(owner, pos);
  pos += owner.length;
  out[pos++] = 0; // target absent
  out[pos++] = 0; // anchor absent
  view.setBigUint64(pos, BigInt(tags.length), true);
  pos += 8;
  view.setBigUint64(pos, BigInt(avroTags.length), true);
  pos += 8;
  out.set(avroTags, pos);
  pos += avroTags.length;
  out.set(data, pos);
  return out;
}

// The TX ID Turbo will assign: base64url(SHA-256(signature)), unpadded.
// Lets the caller log the expected ID BEFORE uploading and detect
// post-upload divergence.
export async function txIdFromDataItem(dataItem: Uint8Array): Promise<string> {
  if (dataItem.length < 2) throw new Error("dataitem: too short to read signature type");
  const sigType = new DataView(dataItem.buffer, dataItem.byteOffset).getUint16(0, true);
  const cfg = SIG_CONFIG[sigType];
  if (!cfg) throw new Error(`dataitem: unsupported signature type ${sigType}`);
  if (dataItem.length < 2 + cfg.sigLength) {
    throw new Error("dataitem: too short to extract signature");
  }
  const sig = dataItem.subarray(2, 2 + cfg.sigLength);
  return base64Url(await sha256Bytes(sig));
}

function base64Url(bytes: Uint8Array): string {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}
