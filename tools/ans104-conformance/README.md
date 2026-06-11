# ans104-conformance (vendored)

`verify_dataitem.py` is vendored byte-for-byte from
[`ar-io-agent/tools/ans104-conformance`](https://github.com/ar-io/ar-io-agent/tree/main/tools/ans104-conformance)
(MIT — LICENSE included). It is the independent Python parser/verifier the
agent's CI runs against its Go ANS-104 builder; here it validates the TS
builder's output (PRD testing seam 3). Sync from the agent repo; never edit
in place.

Run by `packages/anchor/test/dataitem-python.test.ts` via `python3`
(requires the `cryptography` package; the test skips with a notice when
either is unavailable).
