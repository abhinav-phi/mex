import { z } from "zod";
import { HUB_LIMITS } from "./index.js";

const isoTimestamp = z.string().datetime({ offset: true });
const boundedReason = z.string().min(1).max(512);
const aiTool = z.enum(["claude", "cursor", "windsurf", "copilot", "opencode", "codex"]);

export const SETUP_STAGES = [
  "needs_git",
  "needs_setup",
  "needs_population",
  "needs_finalize",
  "ready",
] as const;

export const SETUP_PROGRESS_STEPS = [
  "detect",
  "scaffold",
  "tools",
  "skills",
  "identity",
  "scan",
  "graph",
  "population",
  "finalize",
] as const;

export const SetupStageSchema = z.enum(SETUP_STAGES);
export const SetupProgressStepSchema = z.enum(SETUP_PROGRESS_STEPS);

export const SetupToolStatusSchema = z.object({
  id: aiTool,
  name: z.string().min(1).max(64),
  selected: z.boolean(),
  cliAvailable: z.boolean(),
}).strict();

export const SetupStatusSchema = z.object({
  projectName: z.string().min(1).max(256),
  hasGit: z.boolean(),
  hasScaffold: z.boolean(),
  populated: z.boolean(),
  graphReady: z.boolean(),
  wikiReady: z.boolean(),
  state: z.enum(["existing", "fresh", "partial"]),
  stage: SetupStageSchema,
  configuredTools: z.array(aiTool).max(8),
  tools: z.array(SetupToolStatusSchema).max(8),
  ready: z.boolean(),
}).strict();

export const SetupStartRequestSchema = z.object({
  mode: z.enum(["code-repo", "agent-memory"]).default("code-repo"),
  tools: z.array(aiTool).max(8).default([]),
  confirmPopulation: z.boolean().optional(),
}).strict();

export const SetupProgressSchema = z.object({
  step: SetupProgressStepSchema,
  label: z.string().min(1).max(128),
  detail: z.string().min(1).max(HUB_LIMITS.maxIdentifierCharacters * 8).optional(),
}).strict();

export const SetupRunSchema = z.object({
  status: z.enum(["idle", "running", "succeeded", "failed", "paused"]),
  stage: SetupStageSchema,
  populated: z.boolean(),
  ready: z.boolean(),
  selectedTools: z.array(aiTool).max(8),
  prompt: z.string().max(HUB_LIMITS.maxJsonResponseBytes / 2).nullable(),
  populationTool: z.enum(["claude", "codex"]).nullable(),
  populationCompleted: z.boolean(),
  commitCommands: z.array(z.string().min(1).max(512)).max(16),
  anchorNotes: z.array(z.string().min(1).max(1_024)).max(16),
  message: z.string().min(1).max(2_048),
  progress: SetupProgressSchema.nullable(),
  error: boundedReason.nullable(),
  startedAt: isoTimestamp.nullable(),
  finishedAt: isoTimestamp.nullable(),
}).strict();

export type SetupStage = z.infer<typeof SetupStageSchema>;
export type SetupProgressStep = z.infer<typeof SetupProgressStepSchema>;
export type SetupToolStatus = z.infer<typeof SetupToolStatusSchema>;
export type SetupStatus = z.infer<typeof SetupStatusSchema>;
export type SetupStartRequest = z.infer<typeof SetupStartRequestSchema>;
export type SetupProgress = z.infer<typeof SetupProgressSchema>;
export type SetupRun = z.infer<typeof SetupRunSchema>;
