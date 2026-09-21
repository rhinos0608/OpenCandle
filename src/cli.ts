#!/usr/bin/env node
import { frontDoorCommand, renderFrontDoorCommand } from "./cli-options.js";
import { ensureOpenCandleNativeDependencies } from "./infra/native-dependencies.js";
import { assertSupportedNodeVersion } from "./infra/node-version.js";

const args = process.argv.slice(2);
const command = frontDoorCommand(args);

if (command) {
  console.log(renderFrontDoorCommand(command));
} else if (args[0] === "doctor") {
  const [{ loadEnv }, { handleDoctorCommand }, sandbox] = await Promise.all([
    import("./config.js"),
    import("./doctor/cli-command.js"),
    import("./pi/sandbox.js"),
  ]);
  loadEnv();
  sandbox.configureOpenCandlePiSandboxEnvironment();
  await handleDoctorCommand(args, process.cwd(), sandbox.getOpenCandlePiAgentDir());
} else {
  assertSupportedNodeVersion();
  const sandbox = await import("./pi/sandbox.js");
  sandbox.configureOpenCandlePiSandboxEnvironment();
  await ensureOpenCandleNativeDependencies();
  await import("./cli-main.js");
}
