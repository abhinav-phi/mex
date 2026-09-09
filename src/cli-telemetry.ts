import type { Command } from "commander";
import { TELEMETRY_COMMANDS, type TelemetryAttributes, type TelemetryEventName } from "./telemetry/schema.js";

/** Only names registered by Commander enter telemetry; argument values never do. */
export function telemetryCommandPath(command: Command): string {
  const parts: string[] = [];
  for (let node: Command | null = command; node?.parent; node = node.parent) parts.unshift(node.name());
  return parts.join(".") || "mex";
}

export function isTelemetryExemptCommand(commandName: string, parentName?: string, fullPath?: string): boolean {
  const path = fullPath ?? (parentName && parentName !== "mex" ? `${parentName}.${commandName}` : commandName);
  return !(TELEMETRY_COMMANDS as readonly string[]).includes(path);
}

function telemetryStage(command: Command, path: string): TelemetryAttributes["stage"] {
  const options = command.opts();
  if (path === "relay.draft.save" && options.from !== undefined) return "direct";
  if (command.options.some((option) => option.attributeName() === "apply")) {
    return options.apply === undefined ? "preview" : "apply";
  }
  return options.dryRun === true ? "preview" : "direct";
}

/** One active invocation, completed once even when the action throws. */
export function createCliTelemetry(
  capture: (name: TelemetryEventName, attributes: TelemetryAttributes) => void,
  flush: () => Promise<void>,
  now: () => number = () => performance.now(),
) {
  let active: { command: string; stage: TelemetryAttributes["stage"]; started: number } | undefined;
  return {
    start(command: Command): void {
      try {
        const path = telemetryCommandPath(command);
        if (isTelemetryExemptCommand(command.name(), command.parent?.name(), path)) return;
        active = { command: path, stage: telemetryStage(command, path), started: now() };
        capture("cli.command_started", { command: active.command, stage: active.stage });
      } catch { /* Telemetry cannot change command behavior. */ }
    },
    async finish(exitCode: string | number | null | undefined): Promise<void> {
      const invocation = active;
      active = undefined;
      if (!invocation) return;
      try {
        capture("cli.command_completed", {
          command: invocation.command,
          stage: invocation.stage,
          outcome: exitCode == null || Number(exitCode) === 0 ? "success" : "failure",
          duration_ms: Math.min(86_400_000, Math.max(0, Math.floor(now() - invocation.started))),
        });
        await flush();
      } catch { /* Preserve the command's result and output if telemetry fails. */ }
    },
  };
}
