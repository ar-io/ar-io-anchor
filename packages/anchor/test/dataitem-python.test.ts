// Independent ANS-104 validation (PRD testing seam 3, first half): the
// vendored Python parser from ar-io-agent re-parses our binary data item,
// recomputes the deep hash from the wire bytes, and verifies the ed25519
// signature — an implementation we didn't write, in a language we didn't
// write it in. Skips (loudly) when python3 + cryptography are unavailable.

import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { utf8 } from "@ar.io/proof";
import { afterAll, describe, expect, it } from "vitest";

import { buildSignedDataItem, SolanaWalletSigner } from "../src/dataitem";
import { LocalEd25519Signer } from "../src/signer";

const VALIDATOR = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "..",
  "tools",
  "ans104-conformance",
  "verify_dataitem.py",
);

function pythonAvailable(): boolean {
  const probe = spawnSync("python3", ["-c", "import cryptography"], { stdio: "ignore" });
  return probe.status === 0;
}

const available = pythonAvailable();
const tmp = mkdtempSync(join(tmpdir(), "ans104-"));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

describe.skipIf(!available)("independent Python ANS-104 validator", () => {
  it("parses and signature-verifies our sigType-2 data item", async () => {
    const item = await buildSignedDataItem(
      new SolanaWalletSigner(LocalEd25519Signer.generate()),
      utf8('{"spec_version":"ario.events/v1","payload_hash":"deadbeef"}'),
      [
        { name: "Content-Type", value: "application/json" },
        { name: "App-Name", value: "ario-anchor" },
      ],
    );
    const file = join(tmp, "item.bin");
    writeFileSync(file, item);

    // Exit 0 = parsed + deep hash recomputed + signature verified; non-zero
    // with a message on stderr otherwise.
    const run = spawnSync("python3", [VALIDATOR, file], { encoding: "utf8" });
    expect(run.status, run.stderr).toBe(0);
    expect(run.stderr.toLowerCase()).toContain("signature ok");
  });
});

if (!available) {
  // eslint-disable-next-line no-console
  console.warn(
    "dataitem-python.test.ts: SKIPPED — python3 + cryptography not available; " +
      "the independent ANS-104 validation did not run.",
  );
}
