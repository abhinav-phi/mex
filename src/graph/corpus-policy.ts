import { createHash } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import { globIterateSync, type GlobOptions } from "glob";
import { SUPPORTED_SOURCE_GLOB } from "./extraction/grammars.js";

/** One source of truth for repository files that participate in graph identity. */
export const GRAPH_CORPUS_IGNORE_GLOBS = Object.freeze([
  "**/node_modules/**",
  "**/.git/**",
  "**/dist/**",
  "**/build/**",
  "**/.mex/**",
  "**/coverage/**",
  "**/.next/**",
  "**/out/**",
] as const);

/**
 * Hard bounds on the additive ignore list a repository may configure.
 *
 * The list is read from an untrusted working-tree file on every corpus walk,
 * so it is bounded the same way every other corpus input is.
 */
export const GRAPH_IGNORE_CONFIG_LIMITS = Object.freeze({
  maxGlobs: 64,
  maxGlobLength: 256,
  maxConfigBytes: 256 * 1024,
} as const);

/**
 * Additional ignore globs a repository may configure, from
 * `.mex/config.json` -> `graph.ignore`.
 *
 * **Additive only.** The returned list is always appended to
 * {@link GRAPH_CORPUS_IGNORE_GLOBS}, never substituted for it, so no
 * configuration can un-ignore `node_modules`, `.git` or `.mex`. The frozen
 * defaults are the floor; this raises it.
 *
 * Read defensively and never thrown from: a missing, unreadable, oversized or
 * malformed config yields no extra globs rather than failing a build. A
 * repository that cannot be indexed because its own config file is malformed
 * would trade one hard abort for another.
 */
export function readConfiguredGraphIgnoreGlobs(root: string): string[] {
  let raw: string;
  try {
    const configPath = resolve(root, ".mex", "config.json");
    const stats = statSync(configPath);
    if (!stats.isFile() || stats.size > GRAPH_IGNORE_CONFIG_LIMITS.maxConfigBytes) return [];
    raw = readFileSync(configPath, "utf8");
  } catch {
    return [];
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return [];
  const graph = (parsed as Record<string, unknown>).graph;
  if (typeof graph !== "object" || graph === null || Array.isArray(graph)) return [];
  const ignore = (graph as Record<string, unknown>).ignore;
  if (!Array.isArray(ignore)) return [];
  const globs = new Set<string>();
  for (const entry of ignore) {
    if (typeof entry !== "string") continue;
    const glob = entry.trim();
    if (!glob || glob.length > GRAPH_IGNORE_CONFIG_LIMITS.maxGlobLength) continue;
    // Absolute paths and upward traversal describe files outside the corpus,
    // which discovery already refuses to walk. Accept only repo-relative globs.
    if (isAbsolute(glob) || glob.startsWith("../") || glob.startsWith("..\\")) continue;
    globs.add(glob.split("\\").join("/"));
    if (globs.size >= GRAPH_IGNORE_CONFIG_LIMITS.maxGlobs) break;
  }
  return [...globs].sort((left, right) => (left < right ? -1 : left > right ? 1 : 0));
}

/** The complete ignore list for one repository: frozen defaults, then config. */
export function graphCorpusIgnoreGlobs(root: string): string[] {
  return [...GRAPH_CORPUS_IGNORE_GLOBS, ...readConfiguredGraphIgnoreGlobs(root)];
}

export const GRAPH_CONFIG_GLOBS = Object.freeze([
  "package.json",
  "**/package.json",
  "tsconfig*.json",
  "**/tsconfig*.json",
  "jsconfig*.json",
  "**/jsconfig*.json",
] as const);

export const GRAPH_SUPPORTED_SOURCE_GLOB = SUPPORTED_SOURCE_GLOB;
export const GRAPH_CORPUS_GLOB_OPTIONS = Object.freeze({
  absolute: false,
  dot: false,
  follow: false,
  nodir: true,
} as const);

/**
 * Hard release ceilings for every graph corpus walk.
 *
 * These are safety bounds, not performance targets. Crossing one aborts the
 * observation or maintenance run; a partial corpus is never treated as a
 * complete graph. Keep them in the corpus-policy hash so an existing index is
 * explicitly rebuilt when discovery semantics change.
 */
export const GRAPH_CORPUS_LIMITS = Object.freeze({
  maxSourceFiles: 20_000,
  maxSourceFileBytes: 2 * 1024 * 1024,
  maxSourceBytes: 512 * 1024 * 1024,
  // The TypeScript compiler must see its TS/JS project as one semantic unit.
  // Keep that unavoidable in-memory batch substantially below the full,
  // disk-spooled multi-language corpus ceiling.
  maxCompilerSourceBytes: 128 * 1024 * 1024,
  // Compiler-only project inputs (for example extended configs and ambient
  // declarations) are retained by TypeScript for the duration of extraction.
  // Bound that indirect cache independently from the staged source batch.
  maxCompilerInputPaths: 20_000,
  maxSemanticInputFiles: 1_024,
  maxSemanticInputBytes: 64 * 1024 * 1024,
  // Inspectors reject an implausibly amplified disposable SQLite index before
  // opening it or materializing any persisted values.
  maxIndexBytes: 2 * 1024 * 1024 * 1024,
  maxSnapshotMetadataBytes: 8 * 1024 * 1024,
  maxConfigFiles: 2_000,
  maxConfigFileBytes: 2 * 1024 * 1024,
  maxConfigBytes: 64 * 1024 * 1024,
  maxDiagnostics: 100,
} as const);

export type GraphCorpusLimitName = keyof typeof GRAPH_CORPUS_LIMITS;

/**
 * Limits that describe **one file** rather than the whole corpus.
 *
 * The distinction has teeth. A corpus-wide ceiling says the repository is too
 * big for a bounded run and there is no honest partial answer, so it aborts.
 * A per-file ceiling says one file is too big to parse — every other file in
 * the repository is still perfectly indexable, so the file is skipped and
 * reported instead of taking the build down with it.
 */
export const GRAPH_PER_FILE_CORPUS_LIMITS: ReadonlySet<GraphCorpusLimitName> = new Set([
  "maxSourceFileBytes",
  "maxConfigFileBytes",
] as const);

export class GraphCorpusLimitError extends Error {
  readonly code = "GRAPH_CORPUS_LIMIT_EXCEEDED";

  constructor(
    readonly limit: GraphCorpusLimitName,
    /** Observed size, when the breach was measured against a single file. */
    readonly observedBytes?: number,
  ) {
    super(
      observedBytes === undefined
        ? `The graph corpus exceeded the configured ${limit} safety bound.`
        : `The graph corpus exceeded the configured ${limit} safety bound: `
          + `${observedBytes} bytes against a ${GRAPH_CORPUS_LIMITS[limit]}-byte limit.`,
    );
    this.name = "GraphCorpusLimitError";
  }

  /** True when only this one file is affected and the run may continue. */
  get perFile(): boolean {
    return GRAPH_PER_FILE_CORPUS_LIMITS.has(this.limit);
  }
}

/** Narrow an unknown error to a per-file corpus-limit breach. */
export function isPerFileCorpusLimitError(error: unknown): error is GraphCorpusLimitError {
  return error instanceof GraphCorpusLimitError && error.perFile;
}

/** Lazily consume glob results and stop before an unbounded path array forms. */
export function discoverBoundedGraphPaths(
  pattern: string | readonly string[],
  options: GlobOptions,
  maxFiles: number,
): string[] {
  const paths = new Set<string>();
  for (const match of globIterateSync(pattern as string | string[], options)) {
    paths.add(String(match).split("\\").join("/"));
    if (paths.size > maxFiles) throw new GraphCorpusLimitError(
      maxFiles === GRAPH_CORPUS_LIMITS.maxConfigFiles ? "maxConfigFiles" : "maxSourceFiles",
    );
  }
  return [...paths].sort((left, right) => left < right ? -1 : left > right ? 1 : 0);
}

export function addGraphCorpusBytes(
  total: number,
  fileBytes: number,
  kind: "source" | "config",
): number {
  const maxFile = kind === "source"
    ? GRAPH_CORPUS_LIMITS.maxSourceFileBytes
    : GRAPH_CORPUS_LIMITS.maxConfigFileBytes;
  const maxTotal = kind === "source"
    ? GRAPH_CORPUS_LIMITS.maxSourceBytes
    : GRAPH_CORPUS_LIMITS.maxConfigBytes;
  if (!Number.isSafeInteger(fileBytes) || fileBytes < 0 || fileBytes > maxFile) {
    throw new GraphCorpusLimitError(
      kind === "source" ? "maxSourceFileBytes" : "maxConfigFileBytes",
      Number.isSafeInteger(fileBytes) ? fileBytes : undefined,
    );
  }
  const next = total + fileBytes;
  if (!Number.isSafeInteger(next) || next > maxTotal) {
    throw new GraphCorpusLimitError(kind === "source" ? "maxSourceBytes" : "maxConfigBytes");
  }
  return next;
}

/** Bound the one source working set that cannot be streamed file-by-file. */
export function addGraphCompilerSourceBytes(total: number, fileBytes: number): number {
  if (!Number.isSafeInteger(fileBytes) || fileBytes < 0
    || fileBytes > GRAPH_CORPUS_LIMITS.maxSourceFileBytes) {
    throw new GraphCorpusLimitError(
      "maxSourceFileBytes",
      Number.isSafeInteger(fileBytes) ? fileBytes : undefined,
    );
  }
  const next = total + fileBytes;
  if (!Number.isSafeInteger(next) || next > GRAPH_CORPUS_LIMITS.maxCompilerSourceBytes) {
    throw new GraphCorpusLimitError("maxCompilerSourceBytes");
  }
  return next;
}

export interface GraphSemanticInputLedger {
  readonly paths: Set<string>;
  readonly semanticPaths: Set<string>;
  bytes: number;
}

export function createGraphSemanticInputLedger(): GraphSemanticInputLedger {
  return { paths: new Set(), semanticPaths: new Set(), bytes: 0 };
}

/**
 * Account one distinct compiler-only project input before TypeScript retains
 * it. Every missing probe counts toward the broader cache ceiling; callers can
 * exclude policy-covered misses from the tighter persisted-provenance count.
 */
export function addGraphSemanticInput(
  ledger: GraphSemanticInputLedger,
  path: string,
  fileBytes: number | null,
  recordsSemanticInput = true,
): void {
  if (ledger.paths.has(path)) return;
  if (ledger.paths.size >= GRAPH_CORPUS_LIMITS.maxCompilerInputPaths) {
    throw new GraphCorpusLimitError("maxCompilerInputPaths");
  }
  if (recordsSemanticInput
    && ledger.semanticPaths.size >= GRAPH_CORPUS_LIMITS.maxSemanticInputFiles) {
    throw new GraphCorpusLimitError("maxSemanticInputFiles");
  }
  if (fileBytes !== null) {
    if (!Number.isSafeInteger(fileBytes)
      || fileBytes < 0
      || fileBytes > GRAPH_CORPUS_LIMITS.maxSourceFileBytes) {
      throw new GraphCorpusLimitError("maxSourceFileBytes");
    }
    const next = ledger.bytes + fileBytes;
    if (!Number.isSafeInteger(next) || next > GRAPH_CORPUS_LIMITS.maxSemanticInputBytes) {
      throw new GraphCorpusLimitError("maxSemanticInputBytes");
    }
    ledger.bytes = next;
  }
  ledger.paths.add(path);
  if (recordsSemanticInput) ledger.semanticPaths.add(path);
}

/**
 * Stable identity for discovery semantics, independent of machine locale.
 * Changing this policy invalidates the existing graph through manifestHash.
 */
export const GRAPH_CORPUS_POLICY_HASH = createHash("sha256").update(JSON.stringify({
  version: 2,
  sourceGlob: GRAPH_SUPPORTED_SOURCE_GLOB,
  ignoreGlobs: GRAPH_CORPUS_IGNORE_GLOBS,
  configGlobs: GRAPH_CONFIG_GLOBS,
  globOptions: GRAPH_CORPUS_GLOB_OPTIONS,
  limits: GRAPH_CORPUS_LIMITS,
})).digest("hex");

/**
 * Discovery identity for one repository: the frozen policy, plus whatever the
 * repository additionally chose to ignore.
 *
 * A repository with no configured globs hashes to exactly
 * {@link GRAPH_CORPUS_POLICY_HASH}, so every index built before this existed
 * stays valid. Adding or removing a configured glob changes the corpus, so it
 * must change the manifest and force an explicit rebuild.
 */
export function graphCorpusPolicyHash(root: string): string {
  const configured = readConfiguredGraphIgnoreGlobs(root);
  if (configured.length === 0) return GRAPH_CORPUS_POLICY_HASH;
  return createHash("sha256").update(JSON.stringify({
    base: GRAPH_CORPUS_POLICY_HASH,
    configuredIgnoreGlobs: configured,
  })).digest("hex");
}
