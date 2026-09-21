import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  configureOpenCandlePiSandboxEnvironment,
  createOpenCandlePiSettingsManager,
  getOpenCandlePiAgentDir,
  getOpenCandlePiSessionDir,
  getOpenCandleSystemPromptPath,
  OPENCANDLE_PI_PACKAGES,
  OPENCANDLE_PI_RESOURCE_POLICY,
  OPENCANDLE_SYSTEM_PROMPT,
} from "../../../src/pi/sandbox.js";

const ENV_KEYS = [
  "OPENCANDLE_HOME",
  "PI_ATLAS_HOME",
  "PI_CODING_AGENT_DIR",
  "PI_CODING_AGENT_SESSION_DIR",
] as const;

const originalEnv = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));
let root = "";

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "opencandle-pi-sandbox-"));
  process.env.OPENCANDLE_HOME = join(root, "home");
  process.env.PI_ATLAS_HOME = join(root, "Pi-Atlas");
});

afterEach(() => {
  for (const key of ENV_KEYS) {
    const value = originalEnv[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  if (root) rmSync(root, { recursive: true, force: true });
});

describe("OpenCandle Pi sandbox", () => {
  it("forces Pi agent and session state under OPENCANDLE_HOME", () => {
    process.env.PI_CODING_AGENT_DIR = "/tmp/normal-pi-agent";
    process.env.PI_CODING_AGENT_SESSION_DIR = "/tmp/normal-pi-sessions";

    const paths = configureOpenCandlePiSandboxEnvironment();

    expect(paths.agentDir).toBe(join(root, "home", "pi-agent"));
    expect(paths.sessionDir).toBe(join(root, "home", "pi-sessions"));
    expect(getOpenCandlePiAgentDir()).toBe(paths.agentDir);
    expect(getOpenCandlePiSessionDir()).toBe(paths.sessionDir);
    expect(process.env.PI_CODING_AGENT_DIR).toBe(paths.agentDir);
    expect(process.env.PI_CODING_AGENT_SESSION_DIR).toBe(paths.sessionDir);
  });

  it("persists only the approved packages and Pi-Atlas extension", async () => {
    const cwd = join(root, "foreign-project");
    const projectPiDir = join(cwd, ".pi");
    mkdirSync(projectPiDir, { recursive: true });
    writeFileSync(
      join(projectPiDir, "settings.json"),
      JSON.stringify({
        packages: ["npm:not-allowed"],
        extensions: ["/tmp/not-allowed.ts"],
      }),
    );

    const settings = await createOpenCandlePiSettingsManager(cwd);

    expect(settings.getProjectSettings()).toEqual({});
    expect(settings.getGlobalSettings()).toMatchObject({
      packages: [...OPENCANDLE_PI_PACKAGES],
      extensions: [join(root, "Pi-Atlas")],
      skills: [],
      prompts: [],
      themes: [],
      quietStartup: true,
      enableInstallTelemetry: false,
    });

    const persisted = JSON.parse(
      readFileSync(join(root, "home", "pi-agent", "settings.json"), "utf8"),
    );
    expect(persisted.packages).toEqual([...OPENCANDLE_PI_PACKAGES]);
    expect(persisted.extensions).toEqual([join(root, "Pi-Atlas")]);
    expect(JSON.stringify(persisted)).not.toContain("not-allowed");
  });

  it("bootstraps the isolated SYSTEM.md and repairs drift", async () => {
    const cwd = join(root, "project");
    mkdirSync(cwd, { recursive: true });

    await createOpenCandlePiSettingsManager(cwd);
    const systemPath = getOpenCandleSystemPromptPath();

    expect(systemPath).toBe(join(root, "home", "pi-agent", "SYSTEM.md"));
    expect(readFileSync(systemPath, "utf8")).toBe(OPENCANDLE_SYSTEM_PROMPT);
    if (process.platform !== "win32") {
      expect(statSync(systemPath).mode & 0o777).toBe(0o600);
    }

    writeFileSync(systemPath, "drifted prompt");
    await createOpenCandlePiSettingsManager(cwd);
    expect(readFileSync(systemPath, "utf8")).toBe(OPENCANDLE_SYSTEM_PROMPT);
  });

  it("disables inherited Pi skills, prompts, themes, and context files", () => {
    expect(OPENCANDLE_PI_RESOURCE_POLICY).toEqual({
      noSkills: true,
      noPromptTemplates: true,
      noThemes: true,
      noContextFiles: true,
    });
  });
});
