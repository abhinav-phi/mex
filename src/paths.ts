import { sep } from "node:path";

/**
 * Normalize a filesystem path to forward slashes.
 *
 * `path.relative()` and `glob` return native separators (`\` on Windows). mex's
 * output contracts — drift issue `file` fields, heartbeat `staleFiles`, scanner
 * entry-point `path`s — are forward-slash strings: they're printed to users,
 * JSON-serialized, consumed by mex-agent, and compared with literals like
 * `source.includes("patterns/")`. Run every native path through this before it
 * crosses one of those boundaries so behavior is identical on every OS.
 */
export function toPosix(p: string): string {
  return sep === "/" ? p : p.split(sep).join("/");
}

/**
 * Compare two already-resolved absolute paths for pointing at the same name.
 *
 * A re-resolved path is compared against the one a file was opened by, to
 * prove the name still leads where it did. On Windows those two strings can
 * differ in case alone — `realpathSync` preserves the casing it was handed,
 * and a path that reached us through the TypeScript compiler host arrives
 * lowercased — while naming the identical file on a case-insensitive volume.
 * Comparing them as bytes rejected a file whose device, inode, size and
 * timestamps all matched, and one such file failed an entire repository's
 * build.
 *
 * This is a name comparison and nothing more. It never replaces the file
 * identity checks around it, which are what actually detect a path that was
 * repointed at different content.
 */
export function isSameResolvedPath(left: string | null, right: string | null): boolean {
  if (left === null || right === null) return left === right;
  if (left === right) return true;
  // Case-insensitive volumes: Windows, and macOS by default. Comparing
  // case-insensitively where the filesystem is case-sensitive would accept two
  // genuinely different files, so it stays exact everywhere else.
  if (process.platform !== "win32" && process.platform !== "darwin") return false;
  return left.toLowerCase() === right.toLowerCase();
}
