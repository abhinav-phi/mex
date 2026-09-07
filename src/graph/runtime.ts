import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { relative, resolve } from "node:path";
import { globSync } from "glob";
import type { MexConfig, Grounding } from "../types.js";
import { extractGroundings, findMexAnchors, rewriteMexAnchor, writeGroundings } from "../markdown.js";
import { createGroundingChecker, type GroundingChecker, type GroundedSource } from "./grounding.js";
import { createGraphEngine } from "./engine-impl.js";
import type { GraphEngine } from "./engine.js";
import {
  GRAPH_CORPUS_GLOB_OPTIONS,
  graphCorpusIgnoreGlobs,
  GRAPH_SUPPORTED_SOURCE_GLOB,
} from "./corpus-policy.js";
import { openGraphDatabase } from "./db/database.js";
import type { SqliteDatabase } from "./db/sqlite.js";
import { FingerprintStore } from "./fingerprint-store.js";
import { deserializeFingerprint, serializeFingerprint } from "./fingerprint.js";
import { acquireGraphMaintenanceLease } from "./maintenance.js";
import { MinHashReconciler } from "./reconcile-engine.js";
import type { Fingerprint, Reconciler } from "./reconcile.js";
import {
  inspectGraphSidecars,
  inspectGraphStatus,
  inspectGraphStatusWithFreshObservation,
  type InternalGraphStatusInspection,
} from "./status.js";
import {
  loadFreshGraphReadSession,
  openImmutableGraphReadSessionSync,
  type InternalGraphReadSession,
} from "./read-session.js";
import type { GraphStatus } from "../team/contracts/graph.js";

export interface GroundingRuntime {
  graph: GraphEngine;
  reconciler: MinHashReconciler;
  checker: GroundingChecker;
  fingerprints: FingerprintStore;
  /** Pre-sync fingerprints for inline ids that may disappear during a rename. */
  anchorFingerprints: ReadonlyMap<string, Fingerprint>;
  close(): void;
}

export interface GroundingBaselineCaptureResult {
  captured: number;
  skipped: number;
}

export interface GroundingBaselineCaptureOptions {
  /** Sync may normalize an agent's stale fingerprint to the current graph fact. */
  updateFingerprints?: boolean;
  warn?: (message: string) => void;
}

export interface ReadOnlyGroundingRuntimeResult {
  graphStatus: GraphStatus;
  runtime: GroundingRuntime | null;
}

export interface LoadReadOnlyGroundingRuntimeOptions {
  /** Internal seam for status/error-path tests. */
  inspectStatus?: typeof inspectGraphStatus;
  /** Internal seam for deterministic reader-handshake tests. */
  inspectSidecars?: typeof inspectGraphSidecars;
  /** Inspect status without opening graph readers when grounding is irrelevant. */
  loadRuntime?: boolean;
}

interface ReadOnlyGroundingRuntimeInternalHooks {
  inspectObservation?: typeof inspectGraphStatusWithFreshObservation;
  afterStatusInspection?: (
    inspection: InternalGraphStatusInspection,
  ) => void | Promise<void>;
  afterDatabaseIdentityRead?: () => void | Promise<void>;
  afterDatabaseOpen?: (database: SqliteDatabase) => void | Promise<void>;
  afterDatabaseDescriptorClose?: () => void;
}

type LoadReadOnlyGroundingRuntimeInternalOptions = LoadReadOnlyGroundingRuntimeOptions & {
  /** Module-private deterministic race seams; deliberately absent from declarations. */
  __internal?: ReadOnlyGroundingRuntimeInternalHooks;
};

/**
 * Load grounding readers without synchronizing or otherwise repairing the
 * graph. A non-fresh snapshot is reported to the caller and never used for
 * grounding, because doing so could incorrectly present stale facts as clean.
 */
export async function loadReadOnlyGroundingRuntime(
  config: MexConfig,
  options: LoadReadOnlyGroundingRuntimeOptions = {},
): Promise<ReadOnlyGroundingRuntimeResult> {
  const dbPath = resolve(config.projectRoot, ".mex", "graph.db");
  const internal = (options as LoadReadOnlyGroundingRuntimeInternalOptions).__internal;
  const statusOptions = { projectRoot: config.projectRoot, dbPath };
  const inspectObservation = options.inspectStatus
    ? async (): Promise<InternalGraphStatusInspection> => ({
        graphStatus: await options.inspectStatus!(statusOptions),
        freshObservation: null,
      })
    : internal?.inspectObservation ?? inspectGraphStatusWithFreshObservation;
  const loaded = await loadFreshGraphReadSession(config.projectRoot, {
    dbPath,
    loadSession: options.loadRuntime,
    inspectObservation,
    inspectSidecars: options.inspectSidecars,
    afterStatusInspection: internal?.afterStatusInspection,
    hooks: {
      afterDatabaseIdentityRead: internal?.afterDatabaseIdentityRead,
      afterDatabaseOpen: internal?.afterDatabaseOpen,
      afterDatabaseDescriptorClose: internal?.afterDatabaseDescriptorClose,
    },
  });
  if (!loaded.session) return { graphStatus: loaded.graphStatus, runtime: null };

  const session = loaded.session;
  try {
    const fingerprints = new FingerprintStore(session.db);
    const anchorFingerprints = snapshotAnchorFingerprints(config, fingerprints);
    const guard: GroundingRuntimeGuard = {
      validate: () => session.validate().valid,
      invalidate: () => {
        if (loaded.graphStatus.diagnostics.some((entry) => entry.code === "GRAPH_INDEX_READER_DATABASE_CHANGED")) {
          return;
        }
        loaded.graphStatus.status = "degraded";
        loaded.graphStatus.diagnostics = [
          ...loaded.graphStatus.diagnostics,
          {
            code: "GRAPH_INDEX_READER_DATABASE_CHANGED",
            severity: "warning",
            message: "The graph changed while grounding checks were running; graph-derived results were discarded.",
            remediation: [{ label: "Retry after graph maintenance finishes" }],
          },
        ];
      },
    };
    return {
      graphStatus: loaded.graphStatus,
      runtime: assembleGroundingRuntime(
        session.graph,
        null,
        fingerprints,
        anchorFingerprints,
        guard,
      ),
    };
  } catch {
    session.close();
    return {
      graphStatus: {
        ...loaded.graphStatus,
        status: "degraded",
        diagnostics: [
          ...loaded.graphStatus.diagnostics,
          {
            code: "GRAPH_INDEX_READER_OPEN_FAILED",
            severity: "warning",
            message: "The graph changed or became unavailable while immutable grounding readers were opening; grounding was skipped.",
            remediation: [{ label: "Retry after graph maintenance finishes" }],
          },
        ],
      },
      runtime: null,
    };
  }
}

/**
 * Load and synchronize grounding state for explicitly mutating setup/sync
 * workflows. Ordinary reads must use {@link loadReadOnlyGroundingRuntime}.
 */
export async function loadGroundingRuntime(config: MexConfig): Promise<GroundingRuntime | null> {
  const lease = acquireGraphMaintenanceLease(config.projectRoot, "refresh");
  let priorSession: InternalGraphReadSession | null = null;
  let graph: GraphEngine | null = null;
  let db: SqliteDatabase | null = null;
  try {
    // Preserve fingerprints for inline ids before refresh can replace them.
    // The maintenance lease prevents a cooperating publisher from changing the
    // old snapshot between this read and the isolated refresh publication.
    priorSession = openImmutableGraphReadSessionSync(config.projectRoot, lease.databasePath);
    const anchorFingerprints = snapshotAnchorFingerprints(config, new FingerprintStore(priorSession.db));
    priorSession.close();
    priorSession = null;

    await lease.refresh();
    graph = createGraphEngine({ rootDir: config.projectRoot, dbPath: lease.databasePath });
    db = openGraphDatabase(lease.databasePath);
    const fingerprints = new FingerprintStore(db);
    const assembled = assembleGroundingRuntime(graph, db, fingerprints, anchorFingerprints);
    graph = null;
    db = null;
    let closed = false;
    return {
      ...assembled,
      close: () => {
        if (closed) return;
        closed = true;
        try {
          assembled.close();
        } finally {
          lease.release();
        }
      },
    };
  } catch (error) {
    try { priorSession?.close(); } catch { /* preserve the maintenance failure */ }
    try { graph?.close(); } catch { /* preserve the maintenance failure */ }
    try { db?.close(); } catch { /* preserve the maintenance failure */ }
    lease.release();
    throw error;
  }
}

/** Capture authored grounding against the current graph, shared by setup/migrate/sync. */
export async function captureGroundingBaselines(
  config: MexConfig,
  options: GroundingBaselineCaptureOptions = {},
): Promise<GroundingBaselineCaptureResult> {
  const runtime = await loadGroundingRuntime(config);
  if (!runtime) {
    options.warn?.("Code graph unavailable; grounding baselines were not captured.");
    return { captured: 0, skipped: 0 };
  }
  try {
    const scaffoldFiles = globSync("**/*.md", {
      cwd: config.scaffoldRoot,
      absolute: true,
      nodir: true,
    });
    return refreshGroundingBaselines(config, scaffoldFiles, runtime, {
      ...options,
      updateFingerprints: options.updateFingerprints ?? false,
    });
  } finally {
    runtime.close();
  }
}

/** Compare graph file metadata to disk; includes additions, edits, and deletions. */
export function findChangedSourceFiles(projectRoot: string, db: SqliteDatabase): string[] {
  const rows = db.prepare("SELECT path, size, modified_at FROM files").all() as Array<{
    path: string; size: number; modified_at: number;
  }>;
  const tracked = new Map(rows.map((row) => [row.path, row]));
  const current = globSync(GRAPH_SUPPORTED_SOURCE_GLOB, {
    ...GRAPH_CORPUS_GLOB_OPTIONS,
    cwd: projectRoot,
    ignore: graphCorpusIgnoreGlobs(projectRoot),
  })
    .map((path) => path.replaceAll("\\", "/"));
  const changed: string[] = [];
  for (const path of current) {
    const row = tracked.get(path);
    const stat = statSync(resolve(projectRoot, path));
    if (!row || row.size !== stat.size || row.modified_at !== stat.mtimeMs) changed.push(path);
    tracked.delete(path);
  }
  changed.push(...tracked.keys());
  return [...new Set(changed)].sort();
}

/**
 * Move a grounding's body hash onto the node it was just rebound to.
 *
 * Only called on a confirmed rebind, where identity has already been
 * re-established by fingerprint and the entity now points at a different node.
 * The old hash describes a symbol this grounding no longer names, so carrying
 * it forward would report drift on every rename — a symbol's name is part of
 * its body. Dropping the key instead would be worse: the grounding would fall
 * back to the structural comparator and stop detecting content drift for good.
 *
 * A node the graph cannot produce a hash for leaves the grounding as it was.
 */
function rebindBodyHash(grounding: Grounding, bodyHash: string | null): void {
  if (bodyHash !== null) grounding.bodyHash = bodyHash;
}

/** Persist only high-confidence MOVED repairs. AMBIGUOUS/GONE remain for the agent. */
export function persistMovedGroundings(
  config: MexConfig,
  scaffoldFiles: readonly string[],
  runtime: GroundingRuntime,
): number {
  let moved = 0;
  for (const filePath of scaffoldFiles) {
    const content = readFileSync(filePath, "utf-8");
    const groundings = extractGroundings(content);
    const scaffoldFile = relative(config.projectRoot, filePath).replaceAll("\\", "/");
    let dirty = false;
    for (const grounding of groundings) {
      const aliasedNode = runtime.graph.getNode(grounding.node);
      if (aliasedNode) {
        if (aliasedNode.id === grounding.node) continue;
        const oldId = grounding.node;
        grounding.node = aliasedNode.id;
        const fingerprint = runtime.reconciler.getFingerprint(aliasedNode.id);
        if (fingerprint) grounding.fingerprint = serializeFingerprint(fingerprint);
        rebindBodyHash(grounding, saveCurrentBaseline(config, scaffoldFile, grounding.node, grounding.fingerprint, runtime));
        runtime.fingerprints.deleteGroundedSource(scaffoldFile, oldId);
        dirty = true;
        moved += 1;
        continue;
      }
      const baselineSource = runtime.reconciler.getGroundedSource(scaffoldFile, grounding.node);
      const baseline = deserializeFingerprint(grounding.fingerprint)
        ?? (baselineSource ? deserializeFingerprint(baselineSource.fingerprint) : null);
      if (!baseline) continue;
      const resolution = runtime.reconciler.reconcile(grounding.node, baseline);
      if (resolution.kind !== "MOVED") continue;
      const oldId = grounding.node;
      grounding.node = resolution.nodeId;
      const fingerprint = runtime.reconciler.getFingerprint(resolution.nodeId);
      if (fingerprint) grounding.fingerprint = serializeFingerprint(fingerprint);
      rebindBodyHash(grounding, saveCurrentBaseline(config, scaffoldFile, grounding.node, grounding.fingerprint, runtime));
      runtime.fingerprints.deleteGroundedSource(scaffoldFile, oldId);
      dirty = true;
      moved += 1;
    }
    const groundedContent = dirty ? writeGroundings(content, groundings) : content;
    let anchoredContent = groundedContent;
    const anchors = findMexAnchors(anchoredContent);
    for (const anchor of [...anchors].reverse()) {
      const aliasedNode = runtime.graph.getNode(anchor.nodeId);
      if (aliasedNode) {
        if (aliasedNode.id === anchor.nodeId) continue;
        anchoredContent = rewriteMexAnchor(anchoredContent, anchor, aliasedNode.id);
        moved += 1;
        continue;
      }
      const baselineSource = runtime.reconciler.getGroundedSource(scaffoldFile, anchor.nodeId);
      const baseline = runtime.anchorFingerprints.get(anchor.nodeId)
        ?? (baselineSource ? deserializeFingerprint(baselineSource.fingerprint) : null);
      if (!baseline) continue;
      const resolution = runtime.reconciler.reconcile(anchor.nodeId, baseline);
      if (resolution.kind !== "MOVED") continue;
      anchoredContent = rewriteMexAnchor(anchoredContent, anchor, resolution.nodeId);
      moved += 1;
    }
    if (anchoredContent !== content) writeFileSync(filePath, anchoredContent, "utf-8");
  }
  return moved;
}

interface GroundingReconcilerCapabilities {
  getGroundedSource(scaffoldFile: string, nodeId: string): GroundedSource | null;
  getFingerprint(nodeId: string): Fingerprint | null;
}

interface GroundingRuntimeGuard {
  validate(): boolean;
  invalidate(): void;
}

function assembleGroundingRuntime(
  graph: GraphEngine,
  database: SqliteDatabase | null,
  fingerprints: FingerprintStore,
  anchorFingerprints: ReadonlyMap<string, Fingerprint>,
  guard?: GroundingRuntimeGuard,
): GroundingRuntime {
  const reconciler = new MinHashReconciler(fingerprints);
  const checkerReconciler: Reconciler & GroundingReconcilerCapabilities = {
    reconcile: (nodeId, baseline) => reconciler.reconcile(nodeId, baseline),
    getFingerprint: (nodeId) => anchorFingerprints.get(nodeId) ?? reconciler.getFingerprint(nodeId),
    getGroundedSource: (file, nodeId) => reconciler.getGroundedSource(file, nodeId),
  };
  const rawChecker = createGroundingChecker(graph, checkerReconciler);
  const checker: GroundingChecker = guard
    ? (...args) => {
        if (!guard.validate()) {
          guard.invalidate();
          return [];
        }
        let issues;
        try {
          issues = rawChecker(...args);
        } catch (error) {
          if (!guard.validate()) {
            guard.invalidate();
            return [];
          }
          throw error;
        }
        if (!guard.validate()) {
          guard.invalidate();
          return [];
        }
        return issues;
      }
    : rawChecker;
  let db: SqliteDatabase | null = database;
  return {
    graph,
    reconciler,
    checker,
    fingerprints,
    anchorFingerprints,
    close: () => { graph.close(); db?.close(); db = null; },
  };
}

function snapshotAnchorFingerprints(config: MexConfig, store: FingerprintStore): Map<string, Fingerprint> {
  const snapshots = new Map<string, Fingerprint>();
  const files = [
    ...globSync("**/*.md", { cwd: config.scaffoldRoot, absolute: true, nodir: true }),
    ...["CLAUDE.md", ".cursorrules", ".windsurfrules"]
      .map((file) => resolve(config.projectRoot, file))
      .filter(existsSync),
  ];
  for (const file of files) {
    let content: string;
    try { content = readFileSync(file, "utf-8"); } catch { continue; }
    for (const anchor of findMexAnchors(content)) {
      const fingerprint = store.get(anchor.nodeId);
      if (fingerprint) snapshots.set(anchor.nodeId, fingerprint);
    }
  }
  return snapshots;
}

/** Close the sync loop after an agent pass by refreshing ids' fingerprints and snapshots. */
export function refreshGroundingBaselines(
  config: MexConfig,
  scaffoldFiles: readonly string[],
  runtime: GroundingRuntime,
  options: GroundingBaselineCaptureOptions = {},
): GroundingBaselineCaptureResult {
  let captured = 0;
  let skipped = 0;
  for (const filePath of scaffoldFiles) {
    const content = readFileSync(filePath, "utf-8");
    const groundings = extractGroundings(content);
    const anchors = findMexAnchors(content);
    if (groundings.length === 0 && anchors.length === 0) continue;
    const scaffoldFile = relative(config.projectRoot, filePath).replaceAll("\\", "/");
    let dirty = false;
    const groundingByNode = new Map(groundings.map((grounding) => [grounding.node, grounding]));
    const nodeIds = new Set([
      ...groundingByNode.keys(),
      ...anchors.map((anchor) => anchor.nodeId),
    ]);
    for (const nodeId of nodeIds) {
      const grounding = groundingByNode.get(nodeId);
      const fingerprint = runtime.reconciler.getFingerprint(nodeId);
      if (!fingerprint || !runtime.graph.getNode(nodeId)) {
        skipped += 1;
        options.warn?.(`Skipped grounding baseline for unavailable node ${nodeId} in ${scaffoldFile}.`);
        continue;
      }
      const serialized = serializeFingerprint(fingerprint);
      if (grounding && grounding.fingerprint !== serialized) {
        if (options.updateFingerprints === false) {
          skipped += 1;
          options.warn?.(`Skipped grounding baseline for changed node ${nodeId} in ${scaffoldFile}.`);
          continue;
        }
        grounding.fingerprint = serialized;
        dirty = true;
      }
      const bodyHash = saveCurrentBaseline(config, scaffoldFile, nodeId, serialized, runtime);
      if (bodyHash === null) {
        skipped += 1;
        options.warn?.(`Skipped grounding baseline for non-body node ${nodeId} in ${scaffoldFile}.`);
        continue;
      }
      captured += 1;

      // Commit the change signal alongside the identity signal, so it survives
      // a `graph rebuild` and travels to a teammate who clones. Two cases only:
      //
      //  - **backfill**, when Markdown carries no hash at all. This asserts
      //    nothing new — the `_mex_grounded_source` row written a line above
      //    already records exactly this value, from exactly this moment. It
      //    only makes it durable.
      //  - **re-baseline**, when the caller has not forbidden updates. That is
      //    the post-authoring routine `mex sync` runs after an agent repairs
      //    the prose: the entity now describes the current code, so the
      //    baseline has to move with it or drift never clears.
      //
      // `updateFingerprints === false` — what `mex ground` and setup pass — is
      // the read-only posture, and there a hash that merely *differs* is left
      // alone. That difference is drift, it is the finding, and overwriting it
      // would erase the evidence and report `fresh` on the next run.
      //
      // **The authorization is the caller's flag, never whether the
      // fingerprint moved.** Gating this on a fingerprint change was the first
      // attempt and it was wrong in the one case that matters: editing a
      // constant changes the body and leaves the fingerprint identical, by
      // construction, which is the entire reason a body hash exists. The
      // re-baseline then never fired and drift was permanent. Using the
      // identity signal to decide a change question is the coupling this field
      // exists to break — including here, in the writer.
      const mayRebaseline = options.updateFingerprints !== false;
      if (grounding && (grounding.bodyHash === undefined || mayRebaseline) && grounding.bodyHash !== bodyHash) {
        grounding.bodyHash = bodyHash;
        dirty = true;
      }
    }
    if (dirty) writeFileSync(filePath, writeGroundings(content, groundings), "utf-8");
  }
  return { captured, skipped };
}

export function groundingPromptContext(
  config: MexConfig,
  scaffoldFile: string,
  nodeId: string,
  runtime: GroundingRuntime,
  candidateId?: string,
): { nodeId: string; oldBody: string; newBody: string; candidateId?: string } | null {
  const baseline = runtime.reconciler.getGroundedSource(scaffoldFile, nodeId);
  const current = runtime.graph.getNode(candidateId ?? nodeId);
  if (!baseline || !current) return null;
  return {
    nodeId,
    oldBody: baseline.source,
    newBody: readNodeBody(config.projectRoot, current.filePath, current.startLine, current.endLine),
    candidateId,
  };
}

/**
 * Cache the node's current body beside its hash, and hand the hash back.
 *
 * The row it writes into `_mex_grounded_source` is a **cache of a canonical
 * value, not a second store of a fact.** `.mex/graph.db` is gitignored and
 * disposable by invariant — `mex graph rebuild` is offered as a routine repair
 * — so anything held only here is gone on the next rebuild and never reaches a
 * teammate who clones. The durable copy of `bodyHash` is the one the callers
 * write into the Markdown grounding, which is why this returns it rather than a
 * bare boolean. Keep the row: it also carries the body *text*, which drift
 * review needs for a diff and Markdown has no business holding.
 *
 * Returns the body hash on success, or null for a node the graph does not hold
 * or that has no body — the same condition the boolean used to report.
 */
function saveCurrentBaseline(
  config: MexConfig,
  scaffoldFile: string,
  nodeId: string,
  fingerprint: string,
  runtime: GroundingRuntime,
): string | null {
  const node = runtime.graph.getNode(nodeId);
  if (!node?.bodyHash) return null;
  const source: GroundedSource = {
    scaffoldFile,
    nodeId: node.id,
    source: readNodeBody(config.projectRoot, node.filePath, node.startLine, node.endLine),
    bodyHash: node.bodyHash,
    fingerprint,
  };
  runtime.fingerprints.saveGroundedSource(source);
  return node.bodyHash;
}

function readNodeBody(root: string, filePath: string, startLine: number, endLine: number): string {
  return readFileSync(resolve(root, filePath), "utf-8").split("\n").slice(startLine - 1, endLine).join("\n");
}
