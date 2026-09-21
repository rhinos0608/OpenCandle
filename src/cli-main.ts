import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import { fileURLToPath } from "node:url";
import {
  createAgentSessionRuntime,
  createAgentSessionServices,
  InteractiveMode,
  initTheme,
  ModelRegistry,
  ModelRuntime,
  SessionManager,
} from "@earendil-works/pi-coding-agent";
import { loadEnv, resolvePiAtlasHome } from "./config.js";
import { handleDoctorCommand } from "./doctor/cli-command.js";
import {
  createOpenCandlePiSettingsManager,
  getOpenCandlePiAgentDir,
  getOpenCandlePiSessionDir,
  OPENCANDLE_PI_PACKAGES,
  OPENCANDLE_PI_RESOURCE_POLICY,
} from "./pi/sandbox.js";
import { createOpenCandleSession } from "./pi/session.js";
import { continueOpenCandleSession } from "./pi/session-storage.js";
import {
  acquireWriterLock,
  migrateWriterLockScope,
  refreshWriterLock,
  releaseWriterLock,
  type WriterLock,
  writerLockScopeForSession,
} from "./pi/session-writer-lock.js";
import { startTuiSessionCoordinatorServer } from "./pi/tui-session-coordinator.js";

const require = createRequire(import.meta.url);
const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

async function handleManagedSandboxCommand(args: string[]): Promise<boolean> {
  const [command, ...rest] = args;
  if (!command || !["install", "remove", "uninstall", "list", "update"].includes(command)) {
    return false;
  }

  if (command === "list") {
    console.log("OpenCandle managed Pi sandbox:");
    console.log(`  Pi-Atlas: ${resolvePiAtlasHome()}`);
    for (const pkg of OPENCANDLE_PI_PACKAGES) console.log(`  ${pkg}`);
    return true;
  }

  if (command === "install" || command === "remove" || command === "uninstall") {
    console.error(
      "OpenCandle manages its isolated Pi integrations internally. " +
        "Only Pi-Atlas, pi-provider-antigravity, and pi-opencode-zen are registered.",
    );
    process.exitCode = 1;
    return true;
  }

  if (rest.length > 0) {
    console.error("Usage: opencandle update");
    process.exitCode = 1;
    return true;
  }

  const child = spawn("npm", ["run", "build"], {
    cwd: packageRoot,
    env: process.env,
    stdio: "inherit",
  });
  const exitCode = await new Promise<number>((resolveExit) => {
    child.on("close", (code, signal) => resolveExit(signal ? 1 : (code ?? 0)));
  });
  process.exitCode = exitCode;
  return true;
}

async function handleGuiCommand(args: string[], cwd: string): Promise<boolean> {
  if (args[0] !== "gui") return false;

  const compiledServerPath = resolve(packageRoot, "dist/gui/server/server.js");
  const sourceServerPath = resolve(packageRoot, "gui/server/server.ts");
  const commandArgs = existsSync(compiledServerPath)
    ? [compiledServerPath, ...args.slice(1)]
    : [require.resolve("tsx/cli"), sourceServerPath, ...args.slice(1)];
  const child = spawn(process.execPath, commandArgs, {
    cwd,
    env: process.env,
    stdio: "inherit",
  });

  const exitCode = await new Promise<number>((resolveExit) => {
    child.on("close", (code, signal) => {
      if (signal) {
        resolveExit(1);
      } else {
        resolveExit(code ?? 0);
      }
    });
  });
  process.exitCode = exitCode;
  return true;
}

async function handleMonitorCommand(args: string[], cwd: string): Promise<boolean> {
  if (args[0] !== "monitor") return false;

  const compiledMonitorPath = resolve(packageRoot, "dist/monitor.js");
  const sourceMonitorPath = resolve(packageRoot, "src/monitor.ts");
  const commandArgs = existsSync(compiledMonitorPath)
    ? [compiledMonitorPath, ...args.slice(1)]
    : [require.resolve("tsx/cli"), sourceMonitorPath, ...args.slice(1)];
  const child = spawn(process.execPath, commandArgs, {
    cwd,
    env: process.env,
    stdio: "inherit",
  });

  const exitCode = await new Promise<number>((resolveExit) => {
    child.on("close", (code, signal) => {
      if (signal) {
        resolveExit(1);
      } else {
        resolveExit(code ?? 0);
      }
    });
  });
  process.exitCode = exitCode;
  return true;
}

async function main(): Promise<void> {
  const rawArgs = process.argv.slice(2);
  const cwd = process.cwd();
  const agentDir = getOpenCandlePiAgentDir();
  const sessionDir = getOpenCandlePiSessionDir();

  loadEnv();

  if (await handleGuiCommand(rawArgs, cwd)) {
    return;
  }

  if (await handleMonitorCommand(rawArgs, cwd)) {
    return;
  }

  if (await handleDoctorCommand(rawArgs, cwd, agentDir)) {
    return;
  }

  if (await handleManagedSandboxCommand(rawArgs)) {
    return;
  }

  // Default: start the OpenCandle interactive agent
  const settingsManager = await createOpenCandlePiSettingsManager(cwd);
  const modelRuntime = await ModelRuntime.create({
    authPath: resolve(agentDir, "auth.json"),
    modelsPath: resolve(agentDir, "models.json"),
  });
  const modelRegistry = new ModelRegistry(modelRuntime);
  const shouldSuppressFallbackMessage = modelRegistry.getAvailable().length === 0;

  initTheme(settingsManager.getTheme(), true);

  const sessionManager = continueOpenCandleSession(cwd, sessionDir);
  let activeSessionManager = sessionManager;
  const sessionWriterLockScope = writerLockScopeForSession(sessionManager);
  let runtime: Awaited<ReturnType<typeof createAgentSessionRuntime>> | undefined;
  const tuiCoordinator = await startTuiSessionCoordinatorServer({
    getSession: () => {
      if (!runtime) throw new Error("OpenCandle is still starting this session.");
      return runtime.session;
    },
    getSessionManager: () => activeSessionManager,
    getModelUnavailableMessage: () => {
      if (!runtime) return "OpenCandle is still starting this session.";
      const session = runtime.session;
      const model = session.model;
      if (!model) {
        return "Connect an AI model before chat can run. Paste a Google Gemini, OpenAI, or Anthropic API key in the setup panel.";
      }
      if (!session.modelRuntime.hasConfiguredAuth(model.provider)) {
        return "Connect an AI model before chat can run. Paste a Google Gemini, OpenAI, or Anthropic API key in the setup panel.";
      }
      return null;
    },
    syncWriterLockScope: () => syncActiveSessionWriterLockScope(),
  });
  const sessionWriterLock = await acquireWriterLock(sessionWriterLockScope, "tui", {
    coordinatorEndpoint: tuiCoordinator.endpoint,
    coordinatorSecret: tuiCoordinator.secret,
  });
  if (sessionWriterLock.role !== "writer") {
    await tuiCoordinator.close();
    if (await runFollowerTuiProxy(sessionWriterLock.lock, sessionManager, cwd)) return;
    console.error("OpenCandle is syncing this session in another window. Try again shortly.");
    process.exitCode = 1;
    return;
  }
  let activeSessionWriterLockScope = sessionWriterLockScope;
  let activeSessionWriterLockLost = false;
  function syncActiveSessionWriterLockScope(): void {
    if (activeSessionWriterLockLost) throw new Error("OpenCandle is reconnecting to this session.");
    const nextScope = writerLockScopeForSession(activeSessionManager);
    if (nextScope === activeSessionWriterLockScope) return;
    if (migrateWriterLockScope(activeSessionWriterLockScope, nextScope)) {
      activeSessionWriterLockScope = nextScope;
    } else {
      activeSessionWriterLockLost = true;
      throw new Error("OpenCandle is reconnecting to this session.");
    }
  }
  const writerLockHeartbeat = setInterval(() => {
    try {
      syncActiveSessionWriterLockScope();
      refreshWriterLock(activeSessionWriterLockScope);
    } catch {
      clearInterval(writerLockHeartbeat);
    }
  }, 5000);

  try {
    runtime = await createAgentSessionRuntime(
      async (opts) => {
        const services = await createAgentSessionServices({
          cwd: opts.cwd,
          agentDir: opts.agentDir,
          settingsManager,
          modelRuntime,
          resourceLoaderOptions: OPENCANDLE_PI_RESOURCE_POLICY,
        });
        const result = await createOpenCandleSession({
          cwd: opts.cwd,
          agentDir: opts.agentDir,
          settingsManager,
          modelRuntime,
          sessionManager: opts.sessionManager,
          bindExtensions: false,
        });
        return {
          ...result,
          services,
          diagnostics: services.diagnostics,
        };
      },
      { cwd, agentDir, sessionManager },
    );
    syncActiveSessionWriterLockScope();
    runtime.setRebindSession(async (nextSession) => {
      const nextSessionWriterLockScope = writerLockScopeForSession(nextSession.sessionManager);
      if (nextSessionWriterLockScope === activeSessionWriterLockScope) {
        activeSessionManager = nextSession.sessionManager;
        syncActiveSessionWriterLockScope();
        return;
      }
      const nextSessionWriterLock = await acquireWriterLock(nextSessionWriterLockScope, "tui", {
        coordinatorEndpoint: tuiCoordinator.endpoint,
        coordinatorSecret: tuiCoordinator.secret,
      });
      if (nextSessionWriterLock.role !== "writer") {
        throw new Error("OpenCandle is syncing this session in another window. Try again shortly.");
      }
      releaseWriterLock(activeSessionWriterLockScope);
      activeSessionWriterLockScope = nextSessionWriterLockScope;
      activeSessionManager = nextSession.sessionManager;
    });
    const interactiveMode = new InteractiveMode(runtime, {
      modelFallbackMessage: shouldSuppressFallbackMessage
        ? undefined
        : runtime.modelFallbackMessage,
    });
    await interactiveMode.run();
  } finally {
    clearInterval(writerLockHeartbeat);
    releaseWriterLock(activeSessionWriterLockScope);
    await tuiCoordinator.close();
    await runtime?.dispose();
  }
}

async function runFollowerTuiProxy(
  lock: WriterLock,
  sessionManager: ReturnType<typeof continueOpenCandleSession>,
  cwd: string,
): Promise<boolean> {
  if (!lock.coordinatorEndpoint || !lock.coordinatorSecret) return false;
  if (!process.stdin.isTTY) return false;

  const input = createInterface({ input: process.stdin, output: process.stdout });
  const follower = startFollowerTranscriptPrinter(sessionManager, cwd);
  try {
    console.log("Connected to the active OpenCandle session. Type /exit to close.");
    while (true) {
      const prompt = (await input.question("> ")).trim();
      if (!prompt) continue;
      if (prompt === "/exit" || prompt === "/quit") break;
      await forwardTuiPrompt(lock, sessionManager.getSessionId(), prompt);
      follower.markSeen();
    }
  } finally {
    follower.stop();
    input.close();
  }
  return true;
}

function startFollowerTranscriptPrinter(
  sessionManager: ReturnType<typeof continueOpenCandleSession>,
  cwd: string,
): { stop: () => void; markSeen: () => void } {
  const sessionFile = sessionManager.getSessionFile();
  if (!sessionFile) return { stop: () => {}, markSeen: () => {} };
  const seenEntryIds = new Set(
    sessionManager
      .getEntries()
      .map((entry) => entryId(entry))
      .filter((id): id is string => Boolean(id)),
  );
  const openFreshSession = () =>
    SessionManager.open(sessionFile, sessionManager.getSessionDir(), cwd);
  const markSeen = () => {
    try {
      for (const entry of openFreshSession().getEntries()) {
        const id = entryId(entry);
        if (id) seenEntryIds.add(id);
      }
    } catch {
      // The owner may be rotating the session file; the next poll will catch up.
    }
  };
  let polling = false;
  const poll = () => {
    if (polling) return;
    polling = true;
    try {
      for (const entry of openFreshSession().getEntries()) {
        const id = entryId(entry);
        if (!id || seenEntryIds.has(id)) continue;
        seenEntryIds.add(id);
        const text = followerEntryText(entry);
        if (text) process.stdout.write(`\n${text}\n`);
      }
    } catch {
      // The owner may be rotating the session file; the next poll will catch up.
    } finally {
      polling = false;
    }
  };
  const interval = setInterval(poll, 1000);
  return { stop: () => clearInterval(interval), markSeen };
}

function entryId(entry: unknown): string | null {
  const record = asRecord(entry);
  return typeof record.id === "string" ? record.id : null;
}

function followerEntryText(entry: unknown): string {
  const record = asRecord(entry);
  if (record.type === "message") {
    const message = asRecord(record.message);
    const role = typeof message.role === "string" ? message.role : "message";
    const text = contentText(message.content);
    return text ? `${role}: ${text}` : "";
  }
  if (record.type === "custom") {
    const text = contentText(record.message ?? record.text ?? record.content);
    return text ? `system: ${text}` : "";
  }
  return "";
}

async function forwardTuiPrompt(
  lock: WriterLock,
  sessionId: string,
  prompt: string,
): Promise<void> {
  if (!lock.coordinatorEndpoint || !lock.coordinatorSecret) return;
  const response = await fetch(
    new URL("/api/local-coordinator/chat-run", lock.coordinatorEndpoint),
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-opencandle-coordinator-secret": lock.coordinatorSecret,
      },
      body: JSON.stringify({
        prompt,
        sessionId,
        actionId: `tui-proxy-${randomUUID()}`,
      }),
    },
  );
  if (!response.ok) {
    const body = (await response.json().catch(() => ({}))) as { error?: string };
    console.error(body.error || response.statusText);
    return;
  }
  await printSseResponse(response);
}

async function printSseResponse(response: Response): Promise<void> {
  const reader = response.body?.getReader();
  if (!reader) return;
  const decoder = new TextDecoder();
  let buffer = "";
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let index = buffer.indexOf("\n\n");
    while (index !== -1) {
      const block = buffer.slice(0, index);
      buffer = buffer.slice(index + 2);
      printSseBlock(block);
      index = buffer.indexOf("\n\n");
    }
  }
}

function printSseBlock(block: string): void {
  const data = block
    .split("\n")
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice(5).trim())
    .join("\n");
  if (!data) return;
  const event = JSON.parse(data) as {
    type?: string;
    role?: string;
    text?: string;
    content?: Array<{ type?: string; text?: string }>;
    error?: { message?: string };
  };
  const text = sseEventText(event);
  if (event.type === "message.completed" && text) {
    process.stdout.write(`${text}\n`);
  } else if (event.type === "run.failed") {
    process.stderr.write(`${event.error?.message || "Run failed"}\n`);
  }
}

function sseEventText(event: {
  text?: string;
  content?: Array<{ type?: string; text?: string }>;
}): string {
  if (event.text) return event.text;
  return contentText(event.content);
}

function contentText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((part) => part.type === "text" && part.text)
    .map((part) => part.text)
    .join("");
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

await main();
