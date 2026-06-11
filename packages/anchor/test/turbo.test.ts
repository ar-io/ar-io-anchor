import { describe, expect, it } from "vitest";

import {
  FundingExhaustedError,
  UploadFailedError,
  UploadRejectedError,
} from "../src/errors";
import { TurboUploader } from "../src/turbo";

const ITEM = new Uint8Array([1, 2, 3]);

function fetchSequence(responses: (Response | Error)[]): {
  fetchImpl: typeof fetch;
  calls: { url: string; body: unknown }[];
} {
  const calls: { url: string; body: unknown }[] = [];
  let i = 0;
  const fetchImpl = (async (url: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ url: String(url), body: init?.body });
    const next = responses[Math.min(i++, responses.length - 1)]!;
    if (next instanceof Error) throw next;
    return next;
  }) as typeof fetch;
  return { fetchImpl, calls };
}

const noSleep = async () => {};

describe("TurboUploader", () => {
  it("POSTs the bytes to /v1/tx and returns the assigned txId", async () => {
    const { fetchImpl, calls } = fetchSequence([
      new Response(JSON.stringify({ id: "TX123", owner: "x" }), { status: 200 }),
    ]);
    const up = new TurboUploader({ baseUrl: "https://turbo.test/", fetchImpl, sleep: noSleep });
    const receipt = await up.upload(ITEM);
    expect(receipt.txId).toBe("TX123");
    expect(calls[0]!.url).toBe("https://turbo.test/v1/tx");
  });

  it("throws FundingExhaustedError on 402 with prescriptive guidance, no retry", async () => {
    const { fetchImpl, calls } = fetchSequence([
      new Response("insufficient balance", { status: 402 }),
    ]);
    const up = new TurboUploader({ fetchImpl, sleep: noSleep });
    const err = await up.upload(ITEM).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(FundingExhaustedError);
    expect((err as FundingExhaustedError).message).toMatch(/fund/i);
    expect((err as FundingExhaustedError).message).toContain("turbo.ardrive.io");
    expect(calls.length).toBe(1);
  });

  it("throws UploadRejectedError on terminal 4xx, no retry", async () => {
    const { fetchImpl, calls } = fetchSequence([
      new Response("Invalid Data Item!", { status: 400 }),
    ]);
    const up = new TurboUploader({ fetchImpl, sleep: noSleep });
    await expect(up.upload(ITEM)).rejects.toBeInstanceOf(UploadRejectedError);
    expect(calls.length).toBe(1);
  });

  it("retries 5xx/429/network faults then succeeds", async () => {
    const { fetchImpl, calls } = fetchSequence([
      new Response("boom", { status: 503 }),
      new TypeError("fetch failed"),
      new Response(JSON.stringify({ id: "TXOK" }), { status: 200 }),
    ]);
    const up = new TurboUploader({ fetchImpl, sleep: noSleep, maxRetries: 2 });
    const receipt = await up.upload(ITEM);
    expect(receipt.txId).toBe("TXOK");
    expect(calls.length).toBe(3);
  });

  it("gives up after maxRetries with UploadFailedError", async () => {
    const { fetchImpl, calls } = fetchSequence([new Response("down", { status: 500 })]);
    const up = new TurboUploader({ fetchImpl, sleep: noSleep, maxRetries: 1 });
    const err = await up.upload(ITEM).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(UploadFailedError);
    expect((err as UploadFailedError).attempts).toBe(2);
    expect(calls.length).toBe(2);
  });

  it("backs off exponentially between retries", async () => {
    const delays: number[] = [];
    const { fetchImpl } = fetchSequence([new Response("down", { status: 500 })]);
    const up = new TurboUploader({
      fetchImpl,
      maxRetries: 2,
      retryBaseDelayMs: 100,
      sleep: async (ms) => {
        delays.push(ms);
      },
    });
    await up.upload(ITEM).catch(() => {});
    expect(delays).toEqual([100, 200]);
  });

  it("rejects a success response missing the data item id", async () => {
    const { fetchImpl } = fetchSequence([
      new Response(JSON.stringify({ ok: true }), { status: 200 }),
    ]);
    const up = new TurboUploader({ fetchImpl, sleep: noSleep });
    await expect(up.upload(ITEM)).rejects.toBeInstanceOf(UploadRejectedError);
  });
});
