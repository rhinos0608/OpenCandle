import type { Api, AuthEvent, AuthPrompt, AuthType, Model } from "@earendil-works/pi-ai";
import {
  type ExtensionAPI,
  type ExtensionContext,
  LoginDialogComponent,
  type ModelRuntime,
} from "@earendil-works/pi-coding-agent";
import { sortModels } from "./model-provider-catalog.js";

type SetupMode = "startup" | "manual";
type SetupRequirement = "ready" | "select_model" | "connect_auth";
type SetupResult = "ready" | "shutdown" | "cancelled";

interface LoginOption {
  providerId: string;
  providerName: string;
  authType: AuthType;
  label: string;
}

function getAvailableModels(ctx: ExtensionContext, preferredProvider?: string): Model<Api>[] {
  ctx.modelRegistry.refresh();
  return sortModels(
    ctx.modelRegistry.getAvailable().filter((model) => ctx.modelRegistry.hasConfiguredAuth(model)),
    preferredProvider,
  );
}
export function getLlmSetupRequirement(
  ctx: Pick<ExtensionContext, "model" | "modelRegistry">,
): SetupRequirement {
  if (ctx.model && ctx.modelRegistry.hasConfiguredAuth(ctx.model)) {
    return "ready";
  }
  return ctx.modelRegistry
    .getAvailable()
    .some((model) => ctx.modelRegistry.hasConfiguredAuth(model))
    ? "select_model"
    : "connect_auth";
}

function getPiLoginOptions(modelRuntime: ModelRuntime): LoginOption[] {
  const options: LoginOption[] = [];
  for (const provider of modelRuntime.getProviders()) {
    const oauth = provider.auth.oauth;
    if (oauth) {
      options.push({
        providerId: provider.id,
        providerName: provider.name,
        authType: "oauth",
        label: oauth.loginLabel ?? `${provider.name} — account sign-in`,
      });
    }
    const apiKey = provider.auth.apiKey;
    if (apiKey?.login) {
      options.push({
        providerId: provider.id,
        providerName: provider.name,
        authType: "api_key",
        label: `${provider.name} — ${apiKey.name}`,
      });
    }
  }
  return options.sort((a, b) => a.label.localeCompare(b.label));
}
async function choosePiLoginOption(
  ctx: ExtensionContext,
  modelRuntime: ModelRuntime,
): Promise<LoginOption | undefined> {
  const options = getPiLoginOptions(modelRuntime);
  if (options.length === 0) {
    ctx.ui.notify("Pi reports no interactive model login methods in this runtime.", "warning");
    return undefined;
  }

  const labels = [...options.map((option) => option.label), "Cancel"];
  const choice = await ctx.ui.select("Connect a model provider through Pi", labels);
  if (!choice || choice === "Cancel") return undefined;
  return options.find((option) => option.label === choice);
}

async function runPiLogin(
  ctx: ExtensionContext,
  option: LoginOption,
  modelRuntime: ModelRuntime,
): Promise<boolean> {
  const success = await ctx.ui.custom<boolean>((tui, _theme, _keybindings, done) => {
    let finished = false;
    const finish = (value: boolean) => {
      if (finished) return;
      finished = true;
      done(value);
    };

    const dialog = new LoginDialogComponent(
      tui,
      option.providerId,
      () => {},
      option.providerName,
      `${option.providerName} setup`,
    );
    const prompt = async (request: AuthPrompt): Promise<string> => {
      if (request.type === "select") {
        const choices = request.options
          .map((entry, index) => `${index + 1}. ${entry.label}`)
          .join("\n");
        const answer = await dialog.showPrompt(
          `${request.message}\n\n${choices}`,
          "Enter a number",
        );
        const selectedIndex = Number.parseInt(answer.trim(), 10) - 1;
        return request.options[selectedIndex]?.id ?? "";
      }
      return dialog.showPrompt(request.message, request.placeholder);
    };

    const notify = (event: AuthEvent): void => {
      if (event.type === "auth_url") {
        dialog.showAuth(event.url, event.instructions);
      } else if (event.type === "device_code") {
        dialog.showDeviceCode({
          userCode: event.userCode,
          verificationUri: event.verificationUri,
        });
        dialog.showWaiting("Waiting for authentication...");
      } else if (event.type === "progress" || event.type === "info") {
        dialog.showProgress(event.message);
      }
    };

    void modelRuntime
      .login(option.providerId, option.authType, {
        prompt,
        notify,
        signal: dialog.signal,
      })
      .then(() => finish(true))
      .catch((error) => {
        const message = error instanceof Error ? error.message : String(error);
        if (message !== "Login cancelled") {
          ctx.ui.notify(`Failed to connect ${option.providerName}: ${message}`, "error");
        }
        finish(false);
      });

    return dialog;
  });

  if (!success) return false;

  try {
    await modelRuntime.refresh({ providers: [option.providerId] });
  } catch {
    // The credential is already Pi-managed; cached/static models can still be selected.
  }
  ctx.modelRegistry.refresh();
  ctx.ui.notify(`Connected ${option.providerName} through Pi.`, "info");
  return true;
}

async function selectModel(
  api: ExtensionAPI,
  ctx: ExtensionContext,
  preferredProvider?: string,
): Promise<boolean> {
  const models = getAvailableModels(ctx, preferredProvider);
  if (models.length === 0) {
    ctx.ui.notify("No authenticated Pi models are available yet.", "warning");
    return false;
  }
  const labels = models.map((model) => `${model.provider}/${model.id}`);
  const choice = await ctx.ui.select("Choose a model", labels);
  if (!choice) return false;

  const model = models.find((candidate) => `${candidate.provider}/${candidate.id}` === choice);
  if (!model) return false;

  const ok = await api.setModel(model);
  if (!ok) {
    ctx.ui.notify("Unable to activate the selected model.", "error");
    return false;
  }

  ctx.ui.notify(`Model selected: ${model.provider}/${model.id}`, "info");
  return true;
}

async function connectProvider(
  api: ExtensionAPI,
  ctx: ExtensionContext,
  modelRuntime: ModelRuntime | undefined,
): Promise<boolean> {
  if (!modelRuntime) {
    ctx.ui.notify("Pi model authentication is unavailable in this session.", "error");
    return false;
  }

  const option = await choosePiLoginOption(ctx, modelRuntime);
  if (!option) return false;
  if (!(await runPiLogin(ctx, option, modelRuntime))) return false;
  return selectModel(api, ctx, option.providerId);
}
async function runLlmSetup(
  api: ExtensionAPI,
  ctx: ExtensionContext,
  mode: SetupMode,
  modelRuntime?: ModelRuntime,
): Promise<SetupResult> {
  while (true) {
    const requirement = getLlmSetupRequirement(ctx);

    if (requirement === "ready") {
      if (mode === "startup") return "ready";
      const action = await ctx.ui.select("OpenCandle model setup", [
        "Choose model",
        "Connect another provider through Pi",
        "Cancel",
      ]);
      if (action === "Choose model") {
        return (await selectModel(api, ctx)) ? "ready" : "cancelled";
      }
      if (action === "Connect another provider through Pi") {
        return (await connectProvider(api, ctx, modelRuntime)) ? "ready" : "cancelled";
      }
      return "cancelled";
    }

    if (requirement === "select_model") {
      if (await selectModel(api, ctx)) return "ready";
      if (mode === "manual") return "cancelled";
    } else if (await connectProvider(api, ctx, modelRuntime)) {
      return "ready";
    } else if (mode === "manual") {
      return "cancelled";
    }

    const retry = await ctx.ui.select("OpenCandle needs an authenticated Pi model.", [
      "Try again",
      "Exit setup",
    ]);
    if (retry === "Try again") continue;
    ctx.shutdown();
    return "shutdown";
  }
}
export async function runOpenCandleSetup(
  api: ExtensionAPI,
  ctx: ExtensionContext,
  options: { mode: SetupMode } = { mode: "startup" },
  modelRuntime?: ModelRuntime,
): Promise<SetupResult> {
  const initialRequirement = getLlmSetupRequirement(ctx);
  if (initialRequirement !== "ready" || options.mode === "manual") {
    return runLlmSetup(api, ctx, options.mode, modelRuntime);
  }
  return "ready";
}
