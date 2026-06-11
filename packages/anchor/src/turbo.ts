// Turbo upload: a plain HTTP POST of the signed ANS-104 bytes to
// <baseUrl>/v1/tx — deliberately no SDK and no relay/bundler tier (the
// upload goes straight to the Turbo endpoint the caller configures; a
// relay in the data path is permanently out of scope). Mirrors the agent's
// Go TurboUploader: bounded HTTP-level retries on transient faults, typed
// terminal errors otherwise.

import { FundingExhaustedError, UploadFailedError, UploadRejectedError } from "./errors";

export interface UploadReceipt {
  txId: string;
  // Raw upstream response body, for callers that want Turbo's receipt
  // fields (deadlineHeight, fastFinalityIndexes, ...). Never load-bearing.
  raw: unknown;
}

// The upload plug point (PRD testing seam 4): all anchor/batch behavior
// tests run network-free against a stub implementing this.
export interface Uploader {
  upload(dataItem: Uint8Array): Promise<UploadReceipt>;
}

export const DEFAULT_TURBO_UPLOAD_URL = "https://upload.ardrive.io";

export interface TurboUploaderOptions {
  baseUrl?: string;
  // Per-upload retry ceiling for transient failures (5xx / 429 / network).
  // Default 2 (3 attempts total). Terminal rejections never retry.
  maxRetries?: number;
  // Injectable for tests: fetch implementation and backoff sleeper.
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  retryBaseDelayMs?: number;
}

export class TurboUploader implements Uploader {
  private readonly baseUrl: string;
  private readonly maxRetries: number;
  private readonly fetchImpl: typeof fetch;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly retryBaseDelayMs: number;

  constructor(opts: TurboUploaderOptions = {}) {
    this.baseUrl = (opts.baseUrl ?? DEFAULT_TURBO_UPLOAD_URL).replace(/\/+$/, "");
    this.maxRetries = opts.maxRetries ?? 2;
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.retryBaseDelayMs = opts.retryBaseDelayMs ?? 1000;
  }

  async upload(dataItem: Uint8Array): Promise<UploadReceipt> {
    let lastDetail = "";
    const attempts = this.maxRetries + 1;

    for (let attempt = 0; attempt < attempts; attempt++) {
      if (attempt > 0) await this.sleep(this.retryBaseDelayMs * 2 ** (attempt - 1));

      let res: Response;
      try {
        res = await this.fetchImpl(`${this.baseUrl}/v1/tx`, {
          method: "POST",
          headers: { "content-type": "application/octet-stream" },
          body: dataItem as unknown as BodyInit,
        });
      } catch (err) {
        lastDetail = err instanceof Error ? err.message : String(err);
        continue; // network fault — retry
      }

      if (res.ok) {
        const raw: unknown = await res.json();
        const txId = (raw as { id?: unknown })?.id;
        if (typeof txId !== "string" || txId.length === 0) {
          throw new UploadRejectedError(res.status, "response missing data item id");
        }
        return { txId, raw };
      }

      const body = await res.text().catch(() => "");
      if (res.status === 402) {
        throw new FundingExhaustedError(res.status, body.slice(0, 200));
      }
      if (res.status === 429 || res.status >= 500) {
        lastDetail = `HTTP ${res.status}: ${body.slice(0, 200)}`;
        continue; // transient — retry
      }
      throw new UploadRejectedError(res.status, body.slice(0, 200)); // terminal 4xx
    }

    throw new UploadFailedError(attempts, lastDetail);
  }
}
