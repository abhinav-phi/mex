import crossSpawn from "cross-spawn";
import { AI_TOOLS, type AiTool } from "../types.js";
import {
  launchSetupPopulation,
  type SetupPopulationLaunchResult,
} from "./population.js";

export interface HeadlessPopulationOptions {
  readonly selectedTools: readonly AiTool[];
  readonly prompt: string;
  readonly projectRoot: string;
}

/**
 * Same population launcher as CLI setup, without inheriting the Hub TTY.
 *
 * Claude Code uses `claude -p`; Codex uses `codex exec`. File edits are
 * auto-approved so a Hub job is not blocked on permission prompts.
 */
export function launchHeadlessSetupPopulation(
  options: HeadlessPopulationOptions,
): SetupPopulationLaunchResult {
  return launchSetupPopulation(
    options.selectedTools,
    options.prompt,
    options.projectRoot,
    { run: runHeadlessAgent },
  );
}

function runHeadlessAgent(tool: AiTool, instruction: string, cwd: string): boolean {
  const meta = AI_TOOLS[tool];
  if (meta.cli === null) return false;
  const result = crossSpawn.sync(meta.cli, headlessAgentArgs(tool, instruction), {
    cwd,
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
    encoding: "utf8",
  });
  if (result.error) return false;
  return result.status === 0;
}

function headlessAgentArgs(tool: AiTool, instruction: string): string[] {
  if (tool === "claude") {
    return ["-p", instruction, "--permission-mode", "acceptEdits", "--output-format", "text"];
  }
  if (tool === "codex") {
    return ["exec", "--full-auto", instruction];
  }
  if (tool === "opencode") {
    return ["run", instruction];
  }
  return [instruction];
}
