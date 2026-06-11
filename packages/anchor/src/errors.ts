// Typed error family. The PRD makes one error first-class above all others:
// "wallet out of funds" with concrete funding instructions — the first
// failure a developer hits must be a conversion point, not a stack trace.

export type AnchorErrorCode =
  | "FUNDING_EXHAUSTED"
  | "UPLOAD_REJECTED"
  | "UPLOAD_FAILED"
  | "TXID_MISMATCH"
  | "PRODUCTION_CONFIG";

export class AnchorError extends Error {
  constructor(
    readonly code: AnchorErrorCode,
    message: string,
  ) {
    super(message);
    this.name = new.target.name;
  }
}

export class FundingExhaustedError extends AnchorError {
  constructor(
    readonly status: number,
    detail: string,
  ) {
    super(
      "FUNDING_EXHAUSTED",
      `Turbo rejected the upload for insufficient funds (HTTP ${status}). ` +
        `${detail ? detail + " " : ""}` +
        "Dev-mode free-tier wallets cover only small uploads and run dry. To fund: " +
        "top up Turbo Credits for your wallet at https://turbo.ardrive.io, or move to " +
        "production credentials (a funded, whitelisted wallet) via ar.io onboarding — " +
        "createAnchorer({ environment: \"production\", signer, wallet, subject }).",
    );
  }
}

export class UploadRejectedError extends AnchorError {
  constructor(
    readonly status: number,
    detail: string,
  ) {
    super("UPLOAD_REJECTED", `Turbo rejected the data item (HTTP ${status}): ${detail}`);
  }
}

export class UploadFailedError extends AnchorError {
  constructor(
    readonly attempts: number,
    detail: string,
  ) {
    super(
      "UPLOAD_FAILED",
      `Turbo upload failed after ${attempts} attempt(s): ${detail}. ` +
        "Transient upstream or network fault — safe to retry the anchor call.",
    );
  }
}

export class TxIdMismatchError extends AnchorError {
  constructor(
    readonly predicted: string,
    readonly returned: string,
  ) {
    super(
      "TXID_MISMATCH",
      `Turbo returned TX ID ${returned} but the data item's signature derives ${predicted}. ` +
        "This should never happen with an honest upstream; treat the upload as suspect.",
    );
  }
}

export class ProductionConfigError extends AnchorError {
  constructor(missing: string[]) {
    super(
      "PRODUCTION_CONFIG",
      `createAnchorer({ environment: "production" }) requires explicit ${missing.join(", ")}. ` +
        "Production structurally refuses auto-generated secrets — dev-mode identities and " +
        "auto-minted wallets cannot reach it. Obtain production credentials (API key, " +
        "registered signing key, funded wallet) via ar.io onboarding.",
    );
  }
}
