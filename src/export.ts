import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  realpathSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join, relative, resolve } from "node:path";
import { DEFAULT_SCAFFOLD_PATTERNS, findScaffoldFiles } from "./drift/index.js";
import { toPosix } from "./paths.js";
import type { MexConfig } from "./types.js";

export interface ExportOpts {
  /** Write the bundle to this file instead of stdout. */
  out?: string;
}

/**
 * Hard caps so export refuses instead of exhausting the heap: the file list
 * is bounded before anything is read, each file is size-checked with `stat`
 * before its bytes are retained, and the running total is checked before the
 * joined document is allocated.
 */
export const MAX_EXPORT_FILES = 1000;
export const MAX_EXPORT_FILE_BYTES = 1024 * 1024;
export const MAX_EXPORT_TOTAL_BYTES = 8 * 1024 * 1024;

/**
 * First line of every bundle this command writes. An existing `--out` target
 * carrying this marker is a previous export, not project state, so repeating
 * the export overwrites it (after excluding it from its own inputs) instead
 * of refusing.
 */
const BUNDLE_MARKER = "# mex scaffold export\n";

/** Resolve symlinks as far as the path exists, keeping any missing tail literal. */
function realpathBestEffort(target: string): string {
  const missing: string[] = [];
  let current = target;
  while (!existsSync(current)) {
    const parent = dirname(current);
    if (parent === current) return target;
    missing.unshift(basename(current));
    current = parent;
  }
  return join(realpathSync(current), ...missing);
}

/** Whether an existing path is a previous export bundle (marker prefix, bounded read). */
function isPreviousExportBundle(target: string): boolean {
  let fd: number | undefined;
  try {
    fd = openSync(target, "r");
    const prefix = Buffer.alloc(BUNDLE_MARKER.length);
    const read = readSync(fd, prefix, 0, prefix.length, 0);
    return read === prefix.length && prefix.toString("utf-8") === BUNDLE_MARKER;
  } catch {
    // Missing or unreadable: not a previous bundle. The write itself will
    // surface permission errors; refusal logic only treats markers as outputs.
    return false;
  } finally {
    if (fd !== undefined) {
      try {
        closeSync(fd);
      } catch {
        // Best effort: the descriptor is already open read-only and unused.
      }
    }
  }
}

/**
 * Bundle the whole scaffold into one Markdown document (#56).
 *
 * Section headers name the source file so a pasted copy stays navigable, and
 * files are emitted in a deterministic order (sorted by path). Reuses the
 * drift scanner's own file discovery, so what gets exported is exactly what
 * `mex check` scans — nothing drifts between the two.
 *
 * Safety: `--out` never overwrites scaffold or configuration state (an
 * existing scaffold file, the project config, or a symlink alias of either
 * is refused before anything is written), a previous bundle inside the
 * scaffold is excluded from its own inputs, and file-count, per-file, and
 * aggregate byte limits are enforced before any content is retained.
 */
export async function runExport(config: MexConfig, opts: ExportOpts = {}): Promise<void> {
  let files = findScaffoldFiles(config.projectRoot, config.scaffoldRoot, DEFAULT_SCAFFOLD_PATTERNS)
    .sort((left, right) => (left < right ? -1 : left > right ? 1 : 0));

  if (files.length === 0) {
    throw new Error("No scaffold files found. Run: mex setup");
  }

  const configPath = resolve(config.scaffoldRoot, "config.json");
  if (opts.out) {
    const target = resolve(config.projectRoot, opts.out);
    const targetReal = realpathBestEffort(target);
    // A previous bundle is output, not project state: allow overwriting it
    // (it is still excluded from its own inputs below).
    const previousBundle = isPreviousExportBundle(target);
    assertExportTarget(config, files, configPath, opts.out, previousBundle ? targetReal : undefined);
    // A previous bundle inside the scaffold must not become an input:
    // repeated exports would otherwise duplicate the whole scaffold.
    files = files.filter((file) => realpathBestEffort(file) !== targetReal);
  }

  if (files.length === 0) {
    throw new Error("No scaffold files found. Run: mex setup");
  }
  if (files.length > MAX_EXPORT_FILES) {
    throw new Error(
      `Scaffold has ${files.length} files; export supports at most ${MAX_EXPORT_FILES}.`
    );
  }

  let totalBytes = 0;
  for (const file of files) {
    const size = statSync(file).size;
    if (size > MAX_EXPORT_FILE_BYTES) {
      throw new Error(
        `${toPosix(relative(config.scaffoldRoot, file))} is ${size} bytes; ` +
          `export supports at most ${MAX_EXPORT_FILE_BYTES} bytes per file.`
      );
    }
    totalBytes += size;
    if (totalBytes > MAX_EXPORT_TOTAL_BYTES) {
      throw new Error(
        `Scaffold totals more than ${MAX_EXPORT_TOTAL_BYTES} bytes; ` +
          `export supports at most ${MAX_EXPORT_TOTAL_BYTES} bytes in total.`
      );
    }
  }

  const bundle: string[] = ["# mex scaffold export", ""];
  for (const file of files) {
    const relativePath = toPosix(relative(config.scaffoldRoot, file));
    bundle.push(`## ${relativePath}`, "", readFileSync(file, "utf-8").trimEnd(), "");
  }
  const document = bundle.join("\n");

  if (opts.out) {
    const target = resolve(config.projectRoot, opts.out);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, document, "utf-8");
    console.log(`Wrote ${files.length} scaffold file(s) to ${opts.out}`);
    return;
  }
  process.stdout.write(document);
}

/**
 * Refuse an `--out` target that would overwrite project state: an existing
 * scaffold file, the project configuration, or a symlink alias of either.
 * Throws before anything is written, so the original bytes always survive.
 * `excludeReal`, when given, names a previous bundle output, which is output
 * rather than project state and is therefore not protected.
 */
function assertExportTarget(
  config: MexConfig,
  files: string[],
  configPath: string,
  out: string,
  excludeReal?: string
): void {
  const target = resolve(config.projectRoot, out);
  const targetReal = realpathBestEffort(target);
  const protectedPaths = [...files, configPath];
  for (const protectedPath of protectedPaths) {
    const resolved = resolve(protectedPath);
    if (excludeReal !== undefined && realpathBestEffort(resolved) === excludeReal) continue;
    if (target === resolved || targetReal === realpathBestEffort(resolved)) {
      const label =
        resolve(protectedPath) === resolve(configPath)
          ? `project configuration ${toPosix(relative(config.projectRoot, resolved))}`
          : `scaffold file ${toPosix(relative(config.scaffoldRoot, resolved))}`;
      throw new Error(
        `Refusing to export: "${out}" would overwrite ${label}. Choose a different --out path.`
      );
    }
  }
}
