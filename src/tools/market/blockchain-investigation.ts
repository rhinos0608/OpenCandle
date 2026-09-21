import type { AgentTool } from "@earendil-works/pi-agent-core";
import { Type } from "@sinclair/typebox";
import {
  BLOCKCHAIR_CHAINS,
  type BlockchairAddressResult,
  type BlockchairStatsResult,
  type BlockchairTransactionResult,
  getBlockchairAddress,
  getBlockchairStats,
  getBlockchairTransaction,
} from "../../providers/blockchair.js";
import { renderUntrustedText, untrustedContentHeader } from "../sentiment/untrusted-text.js";

const chainSchema = Type.Union(BLOCKCHAIR_CHAINS.map((chain) => Type.Literal(chain)));

const params = Type.Object({
  action: Type.Union([Type.Literal("address"), Type.Literal("transaction"), Type.Literal("stats")]),
  chain: chainSchema,
  target: Type.Optional(
    Type.String({
      description: "Address or transaction hash. Required for address and transaction actions.",
    }),
  ),
  limit: Type.Optional(
    Type.Number({
      minimum: 0,
      maximum: 100,
      description: "Address history items to request. Default: 50.",
    }),
  ),
  includeEvents: Type.Optional(
    Type.Boolean({ description: "Include Ethereum transaction event data when available." }),
  ),
  includePrivacyMeter: Type.Optional(
    Type.Boolean({
      description:
        "Include Blockchair Privacy-o-meter evidence for supported Bitcoin-like transactions.",
    }),
  ),
});

type InvestigationResult =
  | BlockchairAddressResult
  | BlockchairTransactionResult
  | BlockchairStatsResult;

export const blockchainInvestigationTool: AgentTool<typeof params, InvestigationResult | null> = {
  name: "investigate_blockchain",
  label: "Blockchain Investigation",
  description:
    "Read-only on-chain investigation through Blockchair. Inspect an address, transaction, or chain stats across documented Bitcoin-like chains and Ethereum. Use this for blockchain evidence, flows, transaction structure, and address activity; it does not broadcast transactions.",

  parameters: params,

  async execute(_toolCallId, args) {
    const target = args.target?.trim();
    if (args.action !== "stats" && !target) {
      return {
        content: [
          {
            type: "text",
            text: "⚠ A target address or transaction hash is required for this blockchain investigation.",
          },
        ],
        details: null,
      };
    }

    const resolvedTarget = target ?? "";
    let result: InvestigationResult;
    if (args.action === "address") {
      result = await getBlockchairAddress(args.chain, resolvedTarget, { limit: args.limit });
    } else if (args.action === "transaction") {
      result = await getBlockchairTransaction(args.chain, resolvedTarget, {
        includeEvents: args.includeEvents,
        includePrivacyMeter: args.includePrivacyMeter,
      });
    } else {
      result = await getBlockchairStats(args.chain);
    }

    const label =
      args.action === "stats"
        ? `${args.chain} chain stats`
        : `${args.chain} ${args.action} ${target}`;
    const evidence = renderUntrustedText(JSON.stringify(result), 8_000);
    const text = [
      `**Blockchair blockchain evidence** — ${label}`,
      `Fetched: ${result.fetchedAt}`,
      "Numeric amounts are shown in provider-native units unless the field name explicitly states a currency such as USD; do not infer coin units from an unlabeled integer.",
      "",
      untrustedContentHeader("Blockchair blockchain fields"),
      evidence,
    ].join("\n");

    return {
      content: [{ type: "text", text }],
      details: result,
    };
  },
};
