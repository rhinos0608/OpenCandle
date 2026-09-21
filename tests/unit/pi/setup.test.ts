import type { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";
import { getLlmSetupRequirement, runOpenCandleSetup } from "../../../src/pi/setup.js";
import { createTestModelRuntime } from "../../helpers/pi-model-runtime.js";

function createUi(overrides: Partial<any> = {}) {
  return {
    select: vi.fn(),
    input: vi.fn(),
    notify: vi.fn(),
    custom: vi.fn(),
    ...overrides,
  };
}

async function registerExtraProvider(
  modelRuntime: ModelRuntime,
  provider = "opencode-zen",
  id = "free-test",
): Promise<void> {
  modelRuntime.registerProvider(provider, {
    api: "openai-completions",
    baseUrl: "https://example.test/v1",
    apiKey: "sandbox",
    models: [
      {
        id,
        name: `${provider} test model`,
        reasoning: false,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 4096,
        maxTokens: 1024,
      },
    ],
  });
  await modelRuntime.refresh({ allowNetwork: false });
}

describe("OpenCandle Pi model setup", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("requires Pi auth when no provider is configured", async () => {
    const { modelRegistry } = await createTestModelRuntime();
    expect(getLlmSetupRequirement({ model: undefined, modelRegistry })).toBe("connect_auth");
  });

  it("accepts authenticated native Pi providers", async () => {
    const { modelRegistry } = await createTestModelRuntime({
      anthropic: { type: "api_key", key: "sk-ant-test" },
    });
    expect(getLlmSetupRequirement({ model: undefined, modelRegistry })).toBe("select_model");
  });

  it("accepts authenticated extension providers", async () => {
    const { modelRuntime, modelRegistry } = await createTestModelRuntime();
    await registerExtraProvider(modelRuntime);
    modelRegistry.refresh();
    expect(getLlmSetupRequirement({ model: undefined, modelRegistry })).toBe("select_model");
  });

  it("treats any authenticated current Pi model as ready", async () => {
    const { modelRegistry } = await createTestModelRuntime({
      anthropic: { type: "api_key", key: "sk-ant-test" },
    });
    modelRegistry.refresh();
    const current = modelRegistry.getAvailable().find((model) => model.provider === "anthropic");
    expect(current).toBeDefined();

    expect(getLlmSetupRequirement({ model: current, modelRegistry })).toBe("ready");
  });

  it("shows native and extension models together in the Pi model picker", async () => {
    const { modelRuntime, modelRegistry } = await createTestModelRuntime({
      google: { type: "api_key", key: "google-key" },
    });
    await registerExtraProvider(modelRuntime);
    modelRegistry.refresh();
    const ui = createUi({ select: vi.fn().mockResolvedValue("opencode-zen/free-test") });
    const setModel = vi.fn().mockResolvedValue(true);

    const result = await runOpenCandleSetup(
      { setModel } as any,
      { ui, modelRegistry, model: undefined, shutdown: vi.fn() } as any,
      { mode: "startup" },
      modelRuntime,
    );
    expect(result).toBe("ready");
    const labels = ui.select.mock.calls[0]?.[1] as string[];
    expect(labels).toContain("opencode-zen/free-test");
    expect(labels.some((label) => label.startsWith("google/"))).toBe(true);
    expect(setModel.mock.calls[0]?.[0]?.provider).toBe("opencode-zen");
  });

  it("manual setup can switch among all authenticated Pi models", async () => {
    const { modelRegistry, modelRuntime } = await createTestModelRuntime({
      anthropic: { type: "api_key", key: "sk-ant-test" },
    });
    modelRegistry.refresh();
    const current = modelRegistry.getAvailable().find((model) => model.provider === "anthropic");
    expect(current).toBeDefined();
    const target = `${current!.provider}/${current!.id}`;
    const ui = createUi({
      select: vi.fn().mockResolvedValueOnce("Choose model").mockResolvedValueOnce(target),
    });

    const result = await runOpenCandleSetup(
      { setModel: vi.fn().mockResolvedValue(true) } as any,
      { ui, modelRegistry, model: current, shutdown: vi.fn() } as any,
      { mode: "manual" },
      modelRuntime,
    );
    expect(result).toBe("ready");
    expect(ui.select.mock.calls[1]?.[1]).toContain(target);
    expect(ui.input).not.toHaveBeenCalled();
  });

  it("derives first-run login choices from Pi provider auth metadata", async () => {
    const { modelRegistry } = await createTestModelRuntime();
    const ui = createUi({
      select: vi.fn().mockResolvedValueOnce("Cancel").mockResolvedValueOnce("Exit setup"),
    });
    const modelRuntime = {
      getProviders: () => [
        {
          id: "native-oauth",
          name: "Native OAuth",
          auth: {
            oauth: {
              name: "Native OAuth account",
              loginLabel: "Sign in with Native OAuth",
              login: vi.fn(),
            },
          },
        },
        {
          id: "native-key",
          name: "Native Key",
          auth: {
            apiKey: {
              name: "Native API key",
              login: vi.fn(),
            },
          },
        },
        {
          id: "ambient-only",
          name: "Ambient Only",
          auth: {
            apiKey: {
              name: "Environment credentials",
            },
          },
        },
      ],
    };

    const result = await runOpenCandleSetup(
      { setModel: vi.fn() } as any,
      { ui, modelRegistry, model: undefined, shutdown: vi.fn() } as any,
      { mode: "startup" },
      modelRuntime as any,
    );

    expect(result).toBe("shutdown");
    expect(ui.select.mock.calls[0]?.[0]).toBe("Connect a model provider through Pi");
    expect(ui.select.mock.calls[0]?.[1]).toEqual([
      "Native Key — Native API key",
      "Sign in with Native OAuth",
      "Cancel",
    ]);
    expect(ui.input).not.toHaveBeenCalled();
  });
});
