import { AI_TOOLS, type AiTool } from "./types.js";

export interface AgentCommand {
  readonly command: string;
  readonly args: string[];
}

/** Terminal and browser adapters share tool support and argument construction. */
export function buildAgentCommand(
  tool: AiTool,
  instruction: string,
  mode: "interactive" | "headless",
  options: { allowNonGit?: boolean } = {},
): AgentCommand | null {
  const meta = AI_TOOLS[tool];
  if (meta.cli === null) return null;
  if (mode === "headless" && tool === "claude") {
    return {
      command: meta.cli,
      args: ["-p", instruction, "--permission-mode", "acceptEdits", "--output-format", "stream-json", "--verbose", "--include-partial-messages"],
    };
  }
  if (mode === "headless" && tool === "codex") {
    // `exec` is non-interactive and defaults to never asking for approval.
    // Keep workspace confinement without the removed `--full-auto` shorthand.
    return {
      command: meta.cli,
      args: ["exec", "--json", "--sandbox", "workspace-write", ...(options.allowNonGit ? ["--skip-git-repo-check"] : []), instruction],
    };
  }
  return { command: meta.cli, args: [...meta.promptFlag, instruction] };
}
