#!/usr/bin/env python3
"""Cross-product validator for the agent's hand-rolled ANS-104 v1
data items. Reads a binary data item from a file, parses the header,
recomputes the deep hash, and verifies the signature against the
included owner public key.

Supports two signature types:
  - 1 (Arweave): RSA-PSS-SHA256 over SHA-256 of the 48-byte deep hash.
  - 2 (Solana):  raw Ed25519 over the 48-byte deep hash directly
                 (NO extra SHA-256 round — that round is RSA-specific).

This is the second cross-language conformance check (the first is
proof.CanonicalJSON / envelopes against ar-io-mlflow). It exists to
catch subtle bugs in the data-item serialization — historically the
agent had a real one (commit d43d432b: signature_type encoded as
decimal string in the deep hash vs little-endian binary on the wire)
that produced data items Turbo silently rejected as "invalid."

Format reference: ANS-104 v1 spec + arweave-js + goar implementations.

Usage:
    python3 verify_dataitem.py <path-to-binary-data-item>

Exits 0 on successful verify; non-zero with a clear message on any
failure. Stderr describes what was verified.

Dependencies (install in a venv):
    pip install cryptography
"""

from __future__ import annotations

import hashlib
import struct
import sys
from pathlib import Path

from cryptography.exceptions import InvalidSignature
from cryptography.hazmat.primitives import hashes
from cryptography.hazmat.primitives.asymmetric import padding, utils
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PublicKey
from cryptography.hazmat.primitives.asymmetric.rsa import RSAPublicNumbers


# Field lengths per ANS-104 v1.
SIG_TYPE_LEN = 2
ID_PRESENCE_LEN = 1       # 1 byte flag for target / anchor
ID_LEN = 32               # target / anchor body when present
TAG_COUNT_LEN = 8
TAG_BYTES_LEN = 8

# Per-signature-type (signature_len, owner_len). Mirrors arbundles' SIG_CONFIG.
#   1 = Arweave RSA-PSS-SHA256: 512-byte sig, 512-byte (RSA-4096) modulus.
#   2 = Solana ed25519:         64-byte sig,  32-byte public key.
SIG_CONFIG = {
    1: (512, 512),
    2: (64, 32),
}


def parse_dataitem(data: bytes) -> dict:
    """Parse an ANS-104 v1 binary data item into a dict of fields."""
    pos = 0

    def take(n: int, label: str) -> bytes:
        nonlocal pos
        if pos + n > len(data):
            raise ValueError(f"truncated at {label}: need {n} bytes at pos {pos}, have {len(data) - pos}")
        out = data[pos:pos + n]
        pos += n
        return out

    sig_type = struct.unpack("<H", take(SIG_TYPE_LEN, "signature_type"))[0]
    if sig_type not in SIG_CONFIG:
        raise ValueError(f"unsupported signature_type {sig_type} (supported: {sorted(SIG_CONFIG)})")
    signature_len, owner_len = SIG_CONFIG[sig_type]

    signature = take(signature_len, "signature")
    owner = take(owner_len, "owner")

    target_present = take(ID_PRESENCE_LEN, "target_presence")[0]
    target = b""
    if target_present:
        target = take(ID_LEN, "target")

    anchor_present = take(ID_PRESENCE_LEN, "anchor_presence")[0]
    anchor = b""
    if anchor_present:
        anchor = take(ID_LEN, "anchor")

    tag_count = struct.unpack("<Q", take(TAG_COUNT_LEN, "tag_count"))[0]
    tag_bytes_len = struct.unpack("<Q", take(TAG_BYTES_LEN, "tag_bytes_len"))[0]
    avro_tags = take(tag_bytes_len, "avro_tags")

    payload = data[pos:]

    return {
        "sig_type": sig_type,
        "signature": signature,
        "owner": owner,
        "target": target,
        "anchor": anchor,
        "tag_count": tag_count,
        "avro_tags": avro_tags,
        "payload": payload,
    }


def deep_hash_chunk(blob: bytes) -> bytes:
    """Arweave deep-hash leaf: sha384(sha384("blob" + str(len)) || sha384(blob))."""
    tag = f"blob{len(blob)}".encode()
    return hashlib.sha384(hashlib.sha384(tag).digest() + hashlib.sha384(blob).digest()).digest()


def deep_hash_list(items: list[bytes]) -> bytes:
    """Arweave deep-hash list: accumulates chunks per the reference algorithm."""
    tag = f"list{len(items)}".encode()
    acc = hashlib.sha384(tag).digest()
    for item in items:
        chunk = deep_hash_chunk(item)
        acc = hashlib.sha384(acc + chunk).digest()
    return acc


def compute_deep_hash(parsed: dict) -> bytes:
    """Build the deep hash a verifier expects to recover from the wire bytes.

    Note: signature_type goes in as the DECIMAL STRING form (e.g., b"1"),
    NOT the 2-byte little-endian binary. This mirrors arweave-js's
    stringToBuffer(item.signatureType.toString()) — getting it wrong
    silently yields "Invalid Data Item!" rejection from Turbo.
    """
    sig_type_for_hash = str(parsed["sig_type"]).encode()
    items = [
        b"dataitem",
        b"1",
        sig_type_for_hash,
        parsed["owner"],
        parsed["target"],
        parsed["anchor"],
        parsed["avro_tags"],
        parsed["payload"],
    ]
    return deep_hash_list(items)


def verify_signature(parsed: dict) -> None:
    """Verify the parsed data item's signature against the included owner
    pubkey, dispatching on signature_type. Raises InvalidSignature on
    mismatch.
    """
    deep = compute_deep_hash(parsed)
    sig_type = parsed["sig_type"]

    if sig_type == 1:
        _verify_arweave(parsed, deep)
    elif sig_type == 2:
        _verify_solana(parsed, deep)
    else:
        raise ValueError(f"unsupported signature_type {sig_type}")


def _verify_arweave(parsed: dict, deep: bytes) -> None:
    """RSA-PSS-SHA256 (signature_type=1).

    The signed message is SHA-256 of the 48-byte deep hash digest
    (Arweave's signing wrapper takes a 32-byte input, but the deep hash
    output is 48 bytes — one extra SHA-256 round bridges them).
    """
    digest = hashlib.sha256(deep).digest()

    # Reconstruct RSA public key from the 512-byte modulus + e=65537.
    n = int.from_bytes(parsed["owner"], "big")
    pub = RSAPublicNumbers(e=65537, n=n).public_key()

    # PSS with salt length = hash length, MGF1-SHA256 (Arweave convention).
    # IMPORTANT: pass utils.Prehashed(...) so cryptography verifies the
    # signature against `digest` AS-IS rather than hashing it first.
    # The Go side signs the pre-computed 32-byte SHA-256 of the deep
    # hash; double-hashing in Python would never verify.
    pub.verify(
        parsed["signature"],
        digest,
        padding.PSS(
            mgf=padding.MGF1(hashes.SHA256()),
            salt_length=hashes.SHA256.digest_size,
        ),
        utils.Prehashed(hashes.SHA256()),
    )


def _verify_solana(parsed: dict, deep: bytes) -> None:
    """Raw Ed25519 (signature_type=2) over the 48-byte deep hash directly.

    NO extra SHA-256 round — that round is RSA-specific to the Arweave
    path. The owner is the raw 32-byte ed25519 public key.
    """
    pub = Ed25519PublicKey.from_public_bytes(parsed["owner"])
    # Raises InvalidSignature on mismatch.
    pub.verify(parsed["signature"], deep)


def main(argv: list[str]) -> int:
    if len(argv) != 2:
        print("usage: verify_dataitem.py <data-item-binary-file>", file=sys.stderr)
        return 2
    data = Path(argv[1]).read_bytes()
    try:
        parsed = parse_dataitem(data)
    except ValueError as e:
        print(f"parse error: {e}", file=sys.stderr)
        return 1

    print(f"parsed: sig_type={parsed['sig_type']} owner_len={len(parsed['owner'])} "
          f"tag_count={parsed['tag_count']} avro_bytes={len(parsed['avro_tags'])} "
          f"payload_bytes={len(parsed['payload'])}", file=sys.stderr)

    try:
        verify_signature(parsed)
    except InvalidSignature:
        print("signature INVALID — wire bytes do not verify against included owner pubkey", file=sys.stderr)
        return 1
    except Exception as e:
        print(f"verify error: {e}", file=sys.stderr)
        return 1

    print("signature OK", file=sys.stderr)
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
