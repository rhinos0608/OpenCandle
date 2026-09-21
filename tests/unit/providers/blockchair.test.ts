import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HttpError, httpGet } from "../../../src/infra/http-client.js";
import { rateLimiter } from "../../../src/infra/rate-limiter.js";
import {
  getBlockchairAddress,
  getBlockchairStats,
  getBlockchairTransaction,
} from "../../../src/providers/blockchair.js";
import bitcoinStats from "../../fixtures/blockchair/bitcoin-stats.json";
import bitcoinTransaction from "../../fixtures/blockchair/bitcoin-transaction.json";
import ethereumAddress from "../../fixtures/blockchair/ethereum-address.json";

vi.mock("../../../src/config.js", () => ({
  getConfig: vi.fn(() => ({ blockchairApiKey: undefined })),
}));

vi.mock("../../../src/infra/http-client.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../src/infra/http-client.js")>();
  return { ...actual, httpGet: vi.fn() };
});

const mockedHttpGet = vi.mocked(httpGet);

describe("Blockchair provider", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    rateLimiter.configure("blockchair", 1000, 1000);
  });

  afterEach(() => {
    rateLimiter.configure("blockchair", 2, 0.1);
    vi.restoreAllMocks();
  });

  it("fetches a Bitcoin transaction with Privacy-o-meter and an optional API key", async () => {
    mockedHttpGet.mockResolvedValue(bitcoinTransaction);

    const result = await getBlockchairTransaction("bitcoin", "abc123", {
      apiKey: "throwaway-key",
      includePrivacyMeter: true,
    });

    expect(mockedHttpGet).toHaveBeenCalledWith(
      "https://api.blockchair.com/bitcoin/dashboards/transaction/abc123?privacy-o-meter=true&key=throwaway-key",
      expect.any(Object),
    );
    expect(result.transaction).toMatchObject({ hash: "abc123", fee: 10000 });
    expect(result.privacyMeter).toMatchObject({ score: 42 });
  });

  it("uses transaction history instead of calls for Ethereum address investigation", async () => {
    mockedHttpGet.mockResolvedValue(ethereumAddress);

    const result = await getBlockchairAddress("ethereum", "0xabc", { limit: 25 });

    expect(mockedHttpGet).toHaveBeenCalledWith(
      "https://api.blockchair.com/ethereum/dashboards/address/0xabc?limit=25&transactions_instead_of_calls=true",
      expect.any(Object),
    );
    expect(result.address).toMatchObject({ transaction_count: 2 });
    expect(result.transactions).toEqual(["0xtx1", "0xtx2"]);
  });

  it("fetches chain stats", async () => {
    mockedHttpGet.mockResolvedValue(bitcoinStats);

    const result = await getBlockchairStats("bitcoin");

    expect(mockedHttpGet).toHaveBeenCalledWith(
      "https://api.blockchair.com/bitcoin/stats",
      expect.any(Object),
    );
    expect(result.data).toMatchObject({ blocks: 900000 });
  });

  it("turns Blockchair HTTP 430 into actionable keyed-access guidance", async () => {
    mockedHttpGet.mockRejectedValue(new HttpError(430, "Request Limit", ""));

    await expect(getBlockchairStats("litecoin")).rejects.toThrow(/BLOCKCHAIR_API_KEY/);
  });
});
