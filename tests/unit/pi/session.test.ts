import { mkdtempSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionManager, SettingsManager } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createOpenCandleSession } from "../../../src/pi/session.js";
import {
  hydrateBoundExtensionModelProviders,
  preferAtlasWebSearchTool,
} from "../../../src/pi/session-core.js";
import { getOpenCandleToolDefinitions } from "../../../src/pi/tool-adapter.js";
import { createTestModelRuntime } from "../../helpers/pi-model-runtime.js";

describe("createOpenCandleSession", () => {
  const originalEnv = { ...process.env };
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    process.env = { ...originalEnv };
  });

  afterEach(() => {
    process.env = { ...originalEnv };
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it("prefers Pi-Atlas web_search over duplicate OpenCandle and Antigravity search tools", () => {
    const setActiveToolsByName = vi.fn();
    preferAtlasWebSearchTool({
      getAllTools: () =>
        ["web_search", "search_web", "antigravity_websearch", "fetch"].map((name) => ({
          name,
        })),
      getActiveToolNames: () => ["web_search", "search_web", "antigravity_websearch", "fetch"],
      setActiveToolsByName,
    } as any);

    expect(setActiveToolsByName).toHaveBeenCalledWith(["web_search", "fetch"]);
  });

  it("keeps fallback search tools active when Pi-Atlas web_search is unavailable", () => {
    const setActiveToolsByName = vi.fn();
    preferAtlasWebSearchTool({
      getAllTools: () => ["search_web", "antigravity_websearch"].map((name) => ({ name })),
      getActiveToolNames: () => ["search_web", "antigravity_websearch"],
      setActiveToolsByName,
    } as any);

    expect(setActiveToolsByName).not.toHaveBeenCalled();
  });

  it("keeps fallback search tools active when Pi-Atlas is registered but inactive", () => {
    const setActiveToolsByName = vi.fn();
    preferAtlasWebSearchTool({
      getAllTools: () =>
        ["web_search", "search_web", "antigravity_websearch"].map((name) => ({ name })),
      getActiveToolNames: () => ["search_web", "antigravity_websearch"],
      setActiveToolsByName,
    } as any);

    expect(setActiveToolsByName).not.toHaveBeenCalled();
  });

  it("awaits cache hydration for providers registered during extension binding", async () => {
    const refresh = vi.fn().mockResolvedValue({ aborted: false, errors: new Map() });
    await hydrateBoundExtensionModelProviders({
      getRegisteredProviderIds: () => ["antigravity", "opencode-zen"],
      refresh,
    } as any);

    expect(refresh).toHaveBeenCalledTimes(1);
    expect(refresh).toHaveBeenCalledWith({
      allowNetwork: false,
      providers: ["antigravity", "opencode-zen"],
    });
  });

  it("skips extension catalog hydration when no providers were registered", async () => {
    const refresh = vi.fn();
    await hydrateBoundExtensionModelProviders({
      getRegisteredProviderIds: () => [],
      refresh,
    } as any);

    expect(refresh).not.toHaveBeenCalled();
  });

  it("guards Pi API-key logins before creating the interactive session", async () => {
    globalThis.fetch = vi.fn(
      async () => new Response("Forbidden", { status: 403 }),
    ) as unknown as typeof fetch;
    const { credentials, modelRuntime } = await createTestModelRuntime();
    const result = await createOpenCandleSession({
      modelRuntime,
      settingsManager: SettingsManager.inMemory(),
      sessionManager: SessionManager.inMemory(),
      useInlineExtension: false,
    });

    await expect(
      modelRuntime.login("openai", "api_key", {
        prompt: vi.fn(async () => "bad-key"),
        notify: vi.fn(),
      }),
    ).rejects.toThrow("Key was rejected by OpenAI");
    expect(await credentials.read("openai")).toBeUndefined();

    result.session.dispose();
  });

  it("guards API-key login when Pi creates the model runtime", async () => {
    globalThis.fetch = vi.fn(
      async () => new Response("Forbidden", { status: 403 }),
    ) as unknown as typeof fetch;
    const agentDir = mkdtempSync(join(tmpdir(), "opencandle-login-guard-agent-"));
    try {
      const result = await createOpenCandleSession({
        agentDir,
        settingsManager: SettingsManager.inMemory(),
        sessionManager: SessionManager.inMemory(),
        useInlineExtension: false,
      });

      await expect(
        result.session.modelRuntime.login("openai", "api_key", {
          prompt: vi.fn(async () => "bad-key"),
          notify: vi.fn(),
        }),
      ).rejects.toThrow("Key was rejected by OpenAI");

      result.session.dispose();
    } finally {
      await rm(agentDir, { recursive: true, force: true });
    }
  });

  it("starts in finance-only mode and loads the bundled OpenCandle extension", async () => {
    process.env.GEMINI_API_KEY = "";
    process.env.OPENAI_API_KEY = "";
    process.env.ANTHROPIC_API_KEY = "";
    const agentDir = mkdtempSync(join(tmpdir(), "opencandle-finance-only-agent-"));

    try {
      const result = await createOpenCandleSession({
        cwd: process.cwd(),
        agentDir,
        settingsManager: SettingsManager.inMemory(),
        sessionManager: SessionManager.inMemory(),
      });

      expect(result.session.getActiveToolNames()).not.toContain("read");
      expect(result.session.getActiveToolNames()).not.toContain("bash");
      expect(result.session.getActiveToolNames()).toContain("get_stock_quote");
      expect(result.session.getActiveToolNames()).toContain("manage_watchlist");
      expect(result.session.getActiveToolNames()).toContain("ask_user");
      expect(result.session.getActiveToolNames()).not.toContain("trigger_twitter_login");
      expect(result.session.getActiveToolNames()).toHaveLength(
        getOpenCandleToolDefinitions().length + 1,
      );
      expect(result.coordinator).toBeDefined();
      await expect(result.waitForSettled()).resolves.toBeUndefined();
      if (result.modelFallbackMessage) {
        expect(result.modelFallbackMessage).toContain("No models available");
      }

      result.session.dispose();
    } finally {
      await rm(agentDir, { recursive: true, force: true });
    }
  });

  it("surfaces Pi provider availability from environment variables without OpenCandle-specific auth wiring", async () => {
    process.env.GEMINI_API_KEY = "gemini-key";
    process.env.OPENAI_API_KEY = "openai-key";
    process.env.ANTHROPIC_API_KEY = "anthropic-key";

    const { modelRuntime } = await createTestModelRuntime();
    const available = await modelRuntime.getAvailable();

    expect(available.some((model) => model.provider === "google")).toBe(true);
    expect(available.some((model) => model.provider === "openai")).toBe(true);
    expect(available.some((model) => model.provider === "anthropic")).toBe(true);
  });

  it("prefers the saved Pi default model over a resumed session model", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "opencandle-session-model-cwd-"));
    const sessionDir = mkdtempSync(join(tmpdir(), "opencandle-session-model-sessions-"));
    try {
      const previous = SessionManager.create(cwd, sessionDir);
      previous.appendModelChange("google", "gemini-2.5-flash");
      previous.appendMessage({ role: "user", content: "old prompt" });
      previous.appendMessage({
        role: "assistant",
        content: [{ type: "text", text: "old response" }],
        api: "google-generative-ai",
        provider: "google",
        model: "gemini-2.5-flash",
        usage: {
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 0,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
        stopReason: "stop",
        timestamp: Date.now(),
      });

      const { modelRuntime } = await createTestModelRuntime({
        google: { type: "api_key", key: "test-key" },
      });
      const settingsManager = SettingsManager.inMemory({
        defaultProvider: "google",
        defaultModel: "gemini-3.1-pro-preview",
      });

      const result = await createOpenCandleSession({
        cwd,
        modelRuntime,
        settingsManager,
        sessionManager: SessionManager.continueRecent(cwd, sessionDir),
      });

      expect(result.session.model?.provider).toBe("google");
      expect(result.session.model?.id).toBe("gemini-3.1-pro-preview");

      result.session.dispose();
    } finally {
      await rm(cwd, { recursive: true, force: true });
      await rm(sessionDir, { recursive: true, force: true });
    }
  });
});
