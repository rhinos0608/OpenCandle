import { getConfig } from "../config.js";
import { cache, TTL } from "../infra/cache.js";
import { HttpError, httpGet } from "../infra/http-client.js";
import { rateLimiter } from "../infra/rate-limiter.js";

export const BLOCKCHAIR_CHAINS = [
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
] as const;

export type BlockchairChain = (typeof BLOCKCHAIR_CHAINS)[number];

type JsonObject = Record<string, unknown>;

interface BlockchairApiResponse {
  data?: unknown;
  context?: JsonObject;
}

export interface BlockchairAddressResult {
  chain: BlockchairChain;
  target: string;
  address: JsonObject;
  transactions: unknown[];
  calls: unknown[];
  context: JsonObject;
  fetchedAt: string;
}

export interface BlockchairTransactionResult {
  chain: BlockchairChain;
  hash: string;
  transaction: JsonObject;
  inputs: unknown[];
  outputs: unknown[];
  calls: unknown[];
  events: unknown[];
  privacyMeter?: JsonObject;
  context: JsonObject;
  fetchedAt: string;
}

export interface BlockchairStatsResult {
  chain: BlockchairChain;
  data: JsonObject;
  context: JsonObject;
  fetchedAt: string;
}

interface BlockchairOptions {
  apiKey?: string;
}

interface AddressOptions extends BlockchairOptions {
  limit?: number;
}

interface TransactionOptions extends BlockchairOptions {
  includeEvents?: boolean;
  includePrivacyMeter?: boolean;
}

export async function getBlockchairAddress(
  chain: BlockchairChain,
  target: string,
  options: AddressOptions = {},
): Promise<BlockchairAddressResult> {
  const limit = Math.max(0, Math.min(Math.trunc(options.limit ?? 50), 100));
  const params = new URLSearchParams({ limit: String(limit) });
  if (chain === "ethereum") params.set("transactions_instead_of_calls", "true");
  addApiKey(params, options.apiKey);

  const url = `https://api.blockchair.com/${chain}/dashboards/address/${encodeURIComponent(target)}?${params.toString()}`;
  const response = await fetchBlockchair(url, `blockchair:address:${chain}:${target}:${limit}`);
  const item = singleEntity(response.data, target);

  return {
    chain,
    target,
    address: asObject(item.address),
    transactions: asArray(item.transactions),
    calls: asArray(item.calls),
    context: asObject(response.context),
    fetchedAt: new Date().toISOString(),
  };
}

export async function getBlockchairTransaction(
  chain: BlockchairChain,
  hash: string,
  options: TransactionOptions = {},
): Promise<BlockchairTransactionResult> {
  const params = new URLSearchParams();
  if (options.includePrivacyMeter && chain !== "ethereum") {
    params.set("privacy-o-meter", "true");
  }
  if (options.includeEvents && chain === "ethereum") params.set("events", "true");
  addApiKey(params, options.apiKey);

  const suffix = params.size > 0 ? `?${params.toString()}` : "";
  const url = `https://api.blockchair.com/${chain}/dashboards/transaction/${encodeURIComponent(hash)}${suffix}`;
  const response = await fetchBlockchair(
    url,
    `blockchair:transaction:${chain}:${hash}:events=${Boolean(options.includeEvents)}:privacy=${Boolean(options.includePrivacyMeter)}`,
  );
  const item = singleEntity(response.data, hash);
  const privacyMeter = asOptionalObject(item["privacy-o-meter"]);

  return {
    chain,
    hash,
    transaction: asObject(item.transaction),
    inputs: asArray(item.inputs).slice(0, 100),
    outputs: asArray(item.outputs).slice(0, 100),
    calls: asArray(item.calls).slice(0, 100),
    events: asArray(item.events).slice(0, 100),
    ...(privacyMeter ? { privacyMeter } : {}),
    context: asObject(response.context),
    fetchedAt: new Date().toISOString(),
  };
}

export async function getBlockchairStats(
  chain: BlockchairChain,
  options: BlockchairOptions = {},
): Promise<BlockchairStatsResult> {
  const params = new URLSearchParams();
  addApiKey(params, options.apiKey);
  const suffix = params.size > 0 ? `?${params.toString()}` : "";
  const url = `https://api.blockchair.com/${chain}/stats${suffix}`;
  const response = await fetchBlockchair(url, `blockchair:stats:${chain}`);

  return {
    chain,
    data: asObject(response.data),
    context: asObject(response.context),
    fetchedAt: new Date().toISOString(),
  };
}

async function fetchBlockchair(url: string, cacheKey: string): Promise<BlockchairApiResponse> {
  const cached = cache.get<BlockchairApiResponse>(cacheKey);
  if (cached) return cached;

  try {
    await rateLimiter.acquire("blockchair");
    const response = await httpGet<BlockchairApiResponse>(url, {
      headers: {
        Accept: "application/json",
        "User-Agent": "OpenCandle/0.15 blockchain-investigation",
      },
    });
    cache.set(cacheKey, response, TTL.QUOTE);
    return response;
  } catch (error) {
    if (error instanceof HttpError && error.status === 430) {
      throw new Error(
        "Blockchair keyless access is rate-limited or unavailable (HTTP 430). Set BLOCKCHAIR_API_KEY to use keyed access.",
      );
    }
    throw error;
  }
}

function addApiKey(params: URLSearchParams, explicit?: string): void {
  const apiKey = explicit?.trim() || getConfig().blockchairApiKey?.trim();
  if (apiKey) params.set("key", apiKey);
}

function singleEntity(data: unknown, target: string): JsonObject {
  const rows = asObject(data);
  const exact = rows[target];
  if (exact && typeof exact === "object" && !Array.isArray(exact)) return exact as JsonObject;
  const first = Object.values(rows).find((value): value is JsonObject =>
    Boolean(value && typeof value === "object" && !Array.isArray(value)),
  );
  if (!first) throw new Error(`Blockchair returned no data for ${target}`);
  return first;
}

function asObject(value: unknown): JsonObject {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as JsonObject) : {};
}

function asOptionalObject(value: unknown): JsonObject | undefined {
  const object = asObject(value);
  return Object.keys(object).length > 0 ? object : undefined;
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}
