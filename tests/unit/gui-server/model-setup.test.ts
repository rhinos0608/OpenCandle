import type { Api, Model } from "@earendil-works/pi-ai";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  buildModelSetupState,
  createModelSetupController,
  type ModelSetupRegistry,
} from "../../../gui/server/model-setup.js";

function model(provider: string, id: string): Model<Api> {
  return { provider, id, name: id } as unknown as Model<Api>;
}

function registry(available: Model<Api>[], configured = new Set<string>()): ModelSetupRegistry {
  return {
    refresh() {},
    getAvailable() {
      return available;
    },
    hasConfiguredAuth(candidate) {
      return configured.has(`${candidate.provider}/${candidate.id}`);
    },
  };
}

describe("GUI model setup", () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    globalThis.fetch = vi.fn(
      async () => new Response("{}", { status: 200 }),
    ) as unknown as typeof fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it("requires auth when the active model is not configured and no models are available", () => {
    const active = model("google", "gemini-2.5-flash");

    const state = buildModelSetupState(registry([]), active);

    expect(state.requirement).toBe("connect_auth");
    // The placeholder model has no usable credentials, so it must not be
    // reported as the current model (the composer would render its raw id).
    expect(state.currentModel).toBeUndefined();
    expect(state.providers).toEqual([]);
  });

  it("asks the user to select a model when credentials already expose available models", () => {
    const available = [model("openai", "gpt-5-mini")];

    const state = buildModelSetupState(
      registry(available, new Set(["openai/gpt-5-mini"])),
      undefined,
    );

    expect(state.requirement).toBe("select_model");
    expect(state.availableModels).toEqual([
      { provider: "openai", id: "gpt-5-mini", label: "openai/gpt-5-mini" },
    ]);
  });

  it("requires auth when Pi exposes catalog models without configured credentials", () => {
    const available = [model("openai", "gpt-5-mini"), model("google", "gemini-2.5-flash")];

    const state = buildModelSetupState(registry(available), undefined);

    expect(state.requirement).toBe("connect_auth");
    expect(state.availableModels).toEqual([]);
  });

  it("includes authenticated Pi OAuth models outside the API-key setup providers", () => {
    const available = [model("openai-codex", "gpt-5.4")];

    const state = buildModelSetupState(
      registry(available, new Set(["openai-codex/gpt-5.4"])),
      undefined,
    );

    expect(state.requirement).toBe("select_model");
    expect(state.availableModels).toEqual([
      { provider: "openai-codex", id: "gpt-5.4", label: "openai-codex/gpt-5.4" },
    ]);
  });

  it("is ready when the active model has configured auth", () => {
    const active = model("anthropic", "claude-haiku-4-5");

    const state = buildModelSetupState(
      registry([active], new Set(["anthropic/claude-haiku-4-5"])),
      active,
    );

    expect(state.requirement).toBe("ready");
  });

  it("projects Pi thinking controls into the shared model setup state", () => {
    const active = model("openai", "gpt-5-mini");

    const state = buildModelSetupState(registry([active], new Set(["openai/gpt-5-mini"])), active, {
      current: "medium",
      available: ["off", "low", "medium", "high"],
    });

    expect(state).toMatchObject({
      currentThinkingLevel: "medium",
      availableThinkingLevels: ["off", "low", "medium", "high"],
    });
  });

  it("sets thinking through Pi and flushes its canonical settings", async () => {
    const setThinkingLevel = vi.fn();
    const flush = vi.fn(async () => undefined);
    const controller = createModelSetupController({
      role: "writer",
      getSession: () =>
        ({
          modelRuntime: {},
          getAvailableThinkingLevels: () => ["off", "high"],
          setThinkingLevel,
          settingsManager: { flush },
        }) as never,
      getSessionManager: () => ({ appendCustomMessageEntry: vi.fn() }),
      broadcastState: vi.fn(),
    });

    await controller.handleSetThinkingLevel?.("high");

    expect(setThinkingLevel).toHaveBeenCalledWith("high");
    expect(flush).toHaveBeenCalledOnce();
  });

  it("rejects direct model API-key writes in the local GUI", async () => {
    const controller = createModelSetupController({
      role: "writer",
      getSession: () => {
        throw new Error("direct model-key writes must not access the session");
      },
      getSessionManager: () => ({ appendCustomMessageEntry: vi.fn() }),
      broadcastState: vi.fn(),
    });

    await expect(controller.handleSaveModelApiKey("openai", "some-key")).rejects.toThrow(
      "Model credentials are managed by Pi",
    );
  });

  it("rejects selection of a model whose Pi provider is not authenticated", async () => {
    const candidate = model("openai", "gpt-5-mini");
    const controller = createModelSetupController({
      role: "writer",
      getSession: () =>
        ({
          modelRuntime: {
            refresh: vi.fn(async () => undefined),
            getModel: vi.fn(() => candidate),
            hasConfiguredAuth: vi.fn(() => false),
          },
          setModel: vi.fn(),
          settingsManager: { flush: vi.fn(async () => undefined) },
        }) as never,
      getSessionManager: () => ({ appendCustomMessageEntry: vi.fn() }),
      broadcastState: vi.fn(),
    });

    await expect(controller.handleSelectModel("openai", "gpt-5-mini")).rejects.toThrow(
      "Authenticate openai through Pi",
    );
  });

  it("does not advertise or record a provider key when its shared probe cannot verify it", async () => {
    globalThis.fetch = vi.fn(async () => {
      throw new Error("offline");
    }) as unknown as typeof fetch;
    const appendCustomMessageEntry = vi.fn();
    const broadcastState = vi.fn();
    const controller = createModelSetupController({
      role: "writer",
      // Provider admission must fail before it can touch the Pi session.
      getSession: () => {
        throw new Error("provider validation must not access the session");
      },
      getSessionManager: () => ({ appendCustomMessageEntry }),
      broadcastState,
    });

    await expect(controller.handleSaveProviderApiKey("fred", "unverified-key")).rejects.toThrow(
      "Couldn't verify the FRED key",
    );

    expect(appendCustomMessageEntry).not.toHaveBeenCalled();
    expect(broadcastState).not.toHaveBeenCalled();
  });

  it("rejects model selection in follower mode", async () => {
    const controller = createModelSetupController({
      role: "follower",
      getSession: () => {
        throw new Error("should not read session");
      },
      getSessionManager: () => {
        throw new Error("should not read session manager");
      },
      broadcastState: () => {},
    });

    await expect(controller.handleSelectModel("google", "gemini-2.5-flash")).rejects.toThrow(
      "Read-only follower mode",
    );
  });
});
