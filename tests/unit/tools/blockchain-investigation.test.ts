import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../../src/providers/blockchair.js", () => ({
  BLOCKCHAIR_CHAINS: [
    "bitcoin",
    "bitcoin-cash",
    "litecoin",
    "bitcoin-sv",
    "dogecoin",
    "dash",
    "groestlcoin",
    "zcash",
    "ecash",
    "ethereum",
  ],
  getBlockchairAddress: vi.fn(),
  getBlockchairStats: vi.fn(),
  getBlockchairTransaction: vi.fn(),
}));

import {
  getBlockchairAddress,
  getBlockchairTransaction,
} from "../../../src/providers/blockchair.js";
import { blockchainInvestigationTool } from "../../../src/tools/market/blockchain-investigation.js";

describe("blockchain investigation tool", () => {
  beforeEach(() => vi.clearAllMocks());

  it("requires a target for address and transaction actions", async () => {
    const result = await blockchainInvestigationTool.execute("call-1", {
      action: "address",
      chain: "bitcoin",
    } as any);

    expect(result.content[0].text).toMatch(/target/i);
    expect(getBlockchairAddress).not.toHaveBeenCalled();
  });

  it("returns provider-backed transaction evidence with a raw-unit warning", async () => {
    vi.mocked(getBlockchairTransaction).mockResolvedValue({
      chain: "bitcoin",
      hash: "abc123",
      transaction: { hash: "abc123", fee: 10000 },
      inputs: [{ recipient: "bc1qin", value: 125000000 }],
      outputs: [{ recipient: "bc1qout", value: 124990000 }],
      privacyMeter: { score: 42 },
      context: { code: 200, state: 900000, request_cost: 11 },
      fetchedAt: "2026-09-21T00:00:00Z",
    });

    const result = await blockchainInvestigationTool.execute("call-2", {
      action: "transaction",
      chain: "bitcoin",
      target: "abc123",
      includePrivacyMeter: true,
    } as any);

    expect(result.content[0].text).toContain("provider-native units");
    expect(result.content[0].text).toContain("abc123");
    expect(result.details).toMatchObject({ chain: "bitcoin", hash: "abc123" });
  });
});
