import { canonicalNodeIdentity, generateNodeId } from "../../extraction/node-id.js";
import type { GraphNode } from "../../types.js";
import type {
  FrameworkExtractionResult,
  FrameworkResolver,
  ResolvedRef,
  UnresolvedRef,
} from "../types.js";

const HTTP_METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS", "HEAD"] as const;

const NEXT_DEPENDENCY = /["']next["']\s*:/;
const EXPORTED_FUNCTION = /^\s*export\s+(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/;
const EXPORTED_ARROW = /^\s*export\s+const\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?(?:\([^)]*\)|[A-Za-z_$][\w$]*)\s*(?::[^=]*)?=>/;

/** Route files this resolver understands; everything else is another App Router concern. */
const ROUTE_FILE = /(?:^|\/)route\.(ts|tsx|js|jsx|mts|mjs|cts|cjs)$/;

export const nextjsResolver: FrameworkResolver = {
  name: "nextjs",
  languages: ["typescript", "javascript", "tsx", "jsx"],
  detect(context) {
    // Next.js route handlers live only in route files, so the files themselves
    // are the reliable observable. package.json is checked when present for a
    // stronger signal, but staged config globs already surface it when the
    // repository has one at the root.
    const pkg = context.readFile("package.json");
    if (pkg && NEXT_DEPENDENCY.test(pkg)) return true;
    return context.getAllFiles().some((filePath) => ROUTE_FILE.test(filePath.replace(/\\/g, "/")));
  },
  claimsReference: (name) => /^(GET|POST|PUT|PATCH|DELETE|OPTIONS|HEAD)$/.test(name),
  extract(filePath, content): FrameworkExtractionResult {
    const normalized = filePath.replace(/\\/g, "/");
    const routeMatch = ROUTE_FILE.exec(normalized);
    if (!routeMatch) return { nodes: [], references: [] };

    const language = languageFor(filePath);
    if (!language) return { nodes: [], references: [] };

    const routePath = deriveRoutePath(normalized);
    if (routePath === null) return { nodes: [], references: [] };

    const nodes: GraphNode[] = [];
    const references: UnresolvedRef[] = [];
    const lines = content.split(/\r?\n/);

    for (let lineIndex = 0; lineIndex < lines.length; lineIndex++) {
      const line = lines[lineIndex]!;
      const fnExport = EXPORTED_FUNCTION.exec(line);
      const arrowExport = fnExport ? null : EXPORTED_ARROW.exec(line);
      const handlerName = fnExport?.[1] ?? arrowExport?.[1];
      if (!handlerName || !isHttpMethod(handlerName)) continue;

      const routeName = `${handlerName} ${routePath}`;
      const signature = `${routeName} -> ${handlerName}`;
      const id = generateNodeId(filePath, "route", routeName, routeName, "nextjs-route", signature);
      nodes.push({
        id,
        identityKey: canonicalNodeIdentity(filePath, "route", routeName, "nextjs-route", signature),
        kind: "route",
        name: routeName,
        qualifiedName: routeName,
        filePath,
        language,
        startLine: lineIndex + 1,
        endLine: lineIndex + 1,
        startColumn: 0,
        endColumn: line.length,
        signature,
        isExported: true,
        updatedAt: 0,
      });
      references.push({
        fromNodeId: id,
        referenceName: handlerName,
        referenceKind: "function_ref",
        filePath,
        language,
        line: lineIndex,
        column: 0,
      });
    }

    return { nodes, references };
  },
  resolve(ref, context): ResolvedRef | null {
    if (ref.referenceKind !== "function_ref") return null;
    const candidates = context.getNodesInFile(ref.filePath).filter((node) => (
      (node.kind === "function" || node.kind === "method")
      && node.name === ref.referenceName
    ));
    // The export proves the handler name in this file; anything beyond one
    // same-file candidate is ambiguous and stays unresolved.
    if (candidates.length !== 1) return null;

    return {
      original: ref,
      targetNodeId: candidates[0]!.id,
      confidence: 1,
      resolvedBy: "framework",
    };
  },
};

/** True only for the seven explicitly supported App Router HTTP verbs. */
function isHttpMethod(name: string): name is (typeof HTTP_METHODS)[number] {
  return (HTTP_METHODS as readonly string[]).includes(name);
}

/**
 * The URL path a route file serves, derived from its directory.
 *
 * `app/api/users/route.ts` serves `/api/users`; a `src/app` root strips the
 * `src` prefix. Dynamic segment text such as `[id]` and catch-alls such as
 * `[...slug]` is preserved verbatim — the brackets are Next's own route
 * syntax and rewriting them would lose the distinction between routes.
 * Route groups `(marketing)` never appear in URLs, so their segment is
 * dropped the way Next itself resolves them.
 */
export function deriveRoutePath(normalizedFilePath: string): string | null {
  if (!ROUTE_FILE.test(normalizedFilePath)) return null;
  const withoutFile = normalizedFilePath.slice(0, normalizedFilePath.lastIndexOf("/"));
  const appRoot = /(^|\/)src\/app(\/|$)/.test(withoutFile)
    ? "src/app"
    : /(^|\/)app(\/|$)/.test(withoutFile)
      ? "app"
      : null;
  if (appRoot === null) return null;

  const start = withoutFile.indexOf(appRoot) + appRoot.length;
  const segments = withoutFile.slice(start)
    .split("/")
    .filter((segment) => segment.length > 0 && !segment.startsWith("("));
  const path = `/${segments.join("/")}`;
  return path === "/" ? "/" : path.replace(/\/+$/, "");
}

function languageFor(filePath: string): "typescript" | "javascript" | "tsx" | "jsx" | null {
  if (/\.(ts|mts|cts)$/.test(filePath)) return "typescript";
  if (/\.(js|mjs|cjs)$/.test(filePath)) return "javascript";
  if (/\.(tsx)$/.test(filePath)) return "tsx";
  if (/\.(jsx)$/.test(filePath)) return "jsx";
  return null;
}
