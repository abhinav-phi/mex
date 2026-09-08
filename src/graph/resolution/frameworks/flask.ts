import { canonicalNodeIdentity, generateNodeId } from "../../extraction/node-id.js";
import type { GraphNode } from "../../types.js";
import type {
  FrameworkExtractionResult,
  FrameworkResolver,
  ResolvedRef,
  UnresolvedRef,
} from "../types.js";

const FRAMEWORK_INSTANCE = /^\s*([A-Za-z_]\w*)\s*=\s*(?:Flask|Blueprint)\s*\(/gm;
const ROUTE_DECORATOR = /^(\s*)@([A-Za-z_]\w*)\.(route|get|post|put|patch|delete|options|head)\s*\((.*)\)\s*(?:#.*)?$/;
const METHODS_LIST = /(?:^|[,{\s])methods\s*=\s*\[([^\]]*)\]/;
const HANDLER = /^\s*(?:async\s+)?def\s+([A-Za-z_]\w*)\s*\(/;
const FLASK_IMPORT = /(?:^|\r?\n)\s*(?:from\s+flask(?:\.[\w.]+)?\s+import\s|import\s+flask\b)/;

/** A decorator line whose route has not yet met its handler. */
interface PendingRoute {
  method: string;
  path: string;
  line: number;
  startColumn: number;
  endColumn: number;
}

export const flaskResolver: FrameworkResolver = {
  name: "flask",
  languages: ["python"],
  detect(context) {
    // Detection runs against the staged corpus, and dependency manifests are
    // not staged files — only source is. A Flask project always has a Python
    // module importing flask, so the import is the reliable observable here;
    // `flask_restful` and friends do not match (`import flask` requires the
    // word boundary).
    return context.getAllFiles().some((filePath) => {
      if (!filePath.toLowerCase().endsWith(".py")) return false;
      const content = context.readFile(filePath);
      return content ? FLASK_IMPORT.test(content) : false;
    });
  },
  claimsReference: (name) => /^[A-Za-z_]\w*$/.test(name),
  extract(filePath, content): FrameworkExtractionResult {
    if (!filePath.toLowerCase().endsWith(".py")) {
      return { nodes: [], references: [] };
    }

    const nodes: GraphNode[] = [];
    const references: UnresolvedRef[] = [];
    const pendingRoutes: PendingRoute[] = [];
    const routeReceivers = new Set(
      [...content.matchAll(FRAMEWORK_INSTANCE)].map((match) => match[1]!),
    );
    const lines = content.split(/\r?\n/);

    for (let lineIndex = 0; lineIndex < lines.length; lineIndex++) {
      const line = lines[lineIndex]!;
      const decorator = ROUTE_DECORATOR.exec(line);
      if (decorator && routeReceivers.has(decorator[2]!)) {
        for (const route of parseRoute(decorator[3]!, decorator[4]!, lineIndex, decorator[1]!.length)) {
          pendingRoutes.push(route);
        }
        continue;
      }

      if (pendingRoutes.length === 0) continue;
      // Stacked decorators and blank/comment lines are legal between the
      // decorator and its def; only a real statement ends the wait.
      if (/^\s*@/.test(line)) continue;
      if (/^\s*(?:#.*)?$/.test(line)) continue;

      const handler = HANDLER.exec(line);
      if (handler) {
        emitRoutes(filePath, handler[1]!, pendingRoutes, nodes, references);
      }
      pendingRoutes.length = 0;
    }

    return { nodes, references };
  },
  resolve(ref, context): ResolvedRef | null {
    if (ref.referenceKind !== "function_ref") return null;
    const candidates = context.getNodesInFile(ref.filePath).filter((node) => (
      (node.kind === "function" || node.kind === "method")
      && node.name === ref.referenceName
    ));
    // The decorator proves the handler name, not a repository-global target;
    // same-file is the only context that binds it unambiguously.
    if (candidates.length !== 1) return null;

    return {
      original: ref,
      targetNodeId: candidates[0]!.id,
      confidence: 1,
      resolvedBy: "framework",
    };
  },
};

/**
 * Turn one decorator's arguments into 1..n routes.
 *
 * `@app.route("/x")` means GET by default. `methods=["POST", "PUT"]` fans out
 * to one route per explicitly declared method. Shortcut decorators
 * (`@app.get("/x")`) carry their method in the name. Path converters such as
 * `/users/<int:user_id>` are preserved verbatim — they are the route's
 * identity, and normalizing them would collide distinct routes.
 */
function parseRoute(
  decoratorName: string,
  argsText: string,
  lineIndex: number,
  startColumn: number,
): PendingRoute[] {
  const path = firstStringArgument(argsText);
  if (path === null) return [];

  const methods = decoratorName === "route"
    ? declaredMethods(argsText) ?? ["GET"]
    : [decoratorName.toUpperCase()];
  return methods.map((method) => ({
    method,
    path,
    line: lineIndex,
    startColumn,
    endColumn: startColumn + argsText.length,
  }));
}

/** The first positional string-literal argument, or null when absent/dynamic. */
function firstStringArgument(argsText: string): string | null {
  const match = /^\s*(["'])([^"'\\]*)\1/.exec(argsText);
  return match ? match[2]! : null;
}

/** Methods from `methods=[...]`, each validated as an uppercase identifier. */
function declaredMethods(argsText: string): string[] | null {
  const match = METHODS_LIST.exec(argsText);
  if (!match) return null;
  const methods: string[] = [];
  for (const literal of match[1]!.matchAll(/(["'])([^"'\\]*)\1/g)) {
    const method = literal[2]!.trim().toUpperCase();
    if (/^[A-Z]+$/.test(method)) methods.push(method);
  }
  return methods.length > 0 ? methods : null;
}

function emitRoutes(
  filePath: string,
  handler: string,
  routes: PendingRoute[],
  nodes: GraphNode[],
  references: UnresolvedRef[],
): void {
  for (const route of routes) {
    const name = `${route.method} ${route.path}`;
    const signature = `${name} -> ${handler}`;
    const id = generateNodeId(filePath, "route", name, name, "flask-route", signature);
    nodes.push({
      id,
      identityKey: canonicalNodeIdentity(filePath, "route", name, "flask-route", signature),
      kind: "route",
      name,
      qualifiedName: name,
      filePath,
      language: "python",
      startLine: route.line + 1,
      endLine: route.line + 1,
      startColumn: route.startColumn,
      endColumn: route.endColumn,
      signature,
      isExported: false,
      updatedAt: 0,
    });
    references.push({
      fromNodeId: id,
      referenceName: handler,
      referenceKind: "function_ref",
      filePath,
      language: "python",
      line: route.line,
      column: route.startColumn,
    });
  }
}
