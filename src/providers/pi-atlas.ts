import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { resolvePiAtlasHome } from "../config.js";
import { cache, STALE_LIMIT, TTL } from "../infra/cache.js";
import { rateLimiter } from "../infra/rate-limiter.js";
import type { WebSearchEnvelope, WebSearchResult } from "../types/sentiment.js";
import type { WebSearchOpts } from "./web-search.js";

const PI_ATLAS_TIMEOUT_MS = 45_000;
const PI_ATLAS_MAX_OUTPUT_CHARS = 1_000_000;

interface PiAtlasCliEnvelope {
  ok?: boolean;
  data?: {
    details?: {
      results?: unknown[];
    };
  };
  error?: {
    message?: string;
  };
}

export function isPiAtlasAvailable(home = resolvePiAtlasHome()): boolean {
  return existsSync(join(home, "bin", "pi-northstar.mjs"));
}

export function buildPiAtlasChildEnv(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const allowed = ["HOME", "PATH", "TMPDIR", "SHELL", "LANG", "LC_ALL", "TERM", "USER", "LOGNAME"];
  return Object.fromEntries(
    allowed.flatMap((key) => (typeof env[key] === "string" ? [[key, env[key]]] : [])),
  );
}

export function parsePiAtlasSearchOutput(
  stdout: string,
  query: string,
  category: WebSearchOpts["category"],
): WebSearchEnvelope {
  let envelope: PiAtlasCliEnvelope;
  try {
    envelope = JSON.parse(stdout) as PiAtlasCliEnvelope;
  } catch {
    throw new Error("Pi-Atlas returned invalid JSON");
  }

  if (envelope.ok !== true) {
    throw new Error(envelope.error?.message?.trim() || "Pi-Atlas search failed");
  }

  const rawResults = envelope.data?.details?.results;
  if (!Array.isArray(rawResults)) {
    throw new Error("Pi-Atlas search returned no normalized result set");
  }

  const results = rawResults.flatMap((raw): WebSearchResult[] => {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return [];
    const row = raw as Record<string, unknown>;
    if (
      typeof row.title !== "string" ||
      typeof row.url !== "string" ||
      typeof row.snippet !== "string"
    ) {
      return [];
    }

    return [
      {
        title: row.title,
        url: row.url,
        snippet: row.snippet,
        source: sourceDomain(row.url),
        published: null,
        category,
      },
    ];
  });

  return {
    query,
    results,
    resultCount: results.length,
    fetchedAt: new Date().toISOString(),
    provider: "pi-atlas",
  };
}

export async function piAtlasSearch(
  query: string,
  opts: WebSearchOpts,
): Promise<WebSearchEnvelope> {
  const home = resolvePiAtlasHome();
  if (!isPiAtlasAvailable(home)) throw new Error(`Pi-Atlas not found at ${home}`);

  const cacheKey = `web:pi-atlas:${query}:${opts.category}:${opts.freshness}:${opts.limit}`;
  const cached = cache.get<WebSearchEnvelope>(cacheKey);
  if (cached) return cached;

  try {
    await rateLimiter.acquire("pi_atlas");
    const stdout = await runPiAtlasCli(home, {
      query,
      limit: opts.limit,
      recency: mapRecency(opts.freshness),
    });
    const result = parsePiAtlasSearchOutput(stdout, query, opts.category);
    cache.set(cacheKey, result, TTL.WEB_SEARCH);
    return result;
  } catch (error) {
    const stale = cache.getStale<WebSearchEnvelope>(cacheKey, STALE_LIMIT.WEB_SEARCH);
    if (stale) return stale.value;
    throw error;
  }
}

function runPiAtlasCli(home: string, args: Record<string, unknown>): Promise<string> {
  const bin = join(home, "bin", "pi-northstar.mjs");
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [bin, "call", "web_search", JSON.stringify(args)], {
      cwd: home,
      env: buildPiAtlasChildEnv(),
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let settled = false;

    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      fn();
    };
    const timeout = setTimeout(() => {
      child.kill("SIGTERM");
      finish(() => reject(new Error(`Pi-Atlas search timed out after ${PI_ATLAS_TIMEOUT_MS}ms`)));
    }, PI_ATLAS_TIMEOUT_MS);

    child.stdout.on("data", (chunk: Buffer) => {
      if (settled) return;
      stdout += chunk.toString("utf8");
      if (stdout.length > PI_ATLAS_MAX_OUTPUT_CHARS) {
        child.kill("SIGTERM");
        finish(() => reject(new Error("Pi-Atlas search output exceeded the safety limit")));
      }
    });
    child.stderr.resume();
    child.on("error", (error) => finish(() => reject(error)));
    child.on("close", (code) =>
      finish(() => {
        if (code === 0) {
          resolve(stdout);
        } else {
          reject(new Error(`Pi-Atlas search exited with code ${code ?? 1}`));
        }
      }),
    );
  });
}

function mapRecency(freshness: WebSearchOpts["freshness"]): "day" | "week" | "month" {
  return freshness === "hours" ? "day" : freshness;
}

function sourceDomain(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
}
