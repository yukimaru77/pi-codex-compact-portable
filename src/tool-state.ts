import { isDeepStrictEqual } from "node:util";
import type { Tool } from "@earendil-works/pi-ai";
import * as piAi from "@earendil-works/pi-ai";

// ToolInfo does not expose prepareLoadout's effective descriptions or sampling
// metadata. Compare only fields available on both sides of the public API.
export function comparableTools(tools: readonly Tool[]): Tool[] {
  return tools.map(({ name, description, parameters }) => ({ name, description, parameters }));
}

const compat: { getToolStateChanges?: typeof piAi.getToolStateChanges } = piAi;

export function sameTools(previous: Tool[], current: Tool[]): boolean {
  const changes = compat.getToolStateChanges?.(previous, current);
  return !!changes && changes.toolsAdded.length === 0 && changes.toolsRemoved.length === 0;
}

type PreparedTools = { sessionId: string; recorded: Tool[]; registry: Tool[] };
type ObservedTools = PreparedTools & { accepted: boolean; wire: unknown[] };

function wireTools(payload: unknown): unknown[] | undefined {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return undefined;
  const tools = "tools" in payload ? payload.tools : [];
  return Array.isArray(tools) ? tools : undefined;
}

function matchesDeclarations(recorded: Tool[], wire: unknown[]): boolean {
  if (recorded.length !== wire.length) return false;
  const remaining = new Map(recorded.map((tool) => [tool.name, tool.description]));
  if (remaining.size !== recorded.length) return false;
  for (const tool of wire) {
    if (!tool || typeof tool !== "object" || Array.isArray(tool)) return false;
    if (!("name" in tool) || typeof tool.name !== "string" || !remaining.has(tool.name)) return false;
    if (!("description" in tool) || tool.description !== remaining.get(tool.name)) return false;
    remaining.delete(tool.name);
  }
  return remaining.size === 0;
}

/**
 * The agent-core context hook prepares fresh evidence; cached provider callbacks
 * alone cannot admit a changed registry. Validate actual wire declarations before
 * accepting the pair, then compare each public surface against its frozen copy.
 * Reload and tree navigation discard both prepared and accepted evidence.
 */
export class ToolStateTracker {
  private readonly prepared = new WeakMap<object, PreparedTools>();
  private readonly observed = new WeakMap<object, ObservedTools>();

  reset(owner: object): void {
    this.prepared.delete(owner);
    this.observed.delete(owner);
  }

  prepare(owner: object, sessionId: string, recorded: Tool[], registry: Tool[]): void {
    this.prepared.set(owner, structuredClone({ sessionId, recorded, registry }));
  }

  observe(owner: object, sessionId: string, recorded: Tool[], registry: Tool[], payload: unknown): void {
    const prepared = this.prepared.get(owner);
    if (
      !prepared ||
      prepared.sessionId !== sessionId ||
      !sameTools(prepared.recorded, recorded) ||
      !sameTools(prepared.registry, registry)
    ) {
      return;
    }
    // Description rewrites are allowed only at the prepared boundary. Hidden,
    // missing, duplicate, or rewritten wire declarations cannot prove equality.
    const withoutDescriptions = (tools: Tool[]) => tools.map((tool) => ({ ...tool, description: "" }));
    const wire = wireTools(payload);
    const accepted =
      !!wire &&
      matchesDeclarations(recorded, wire) &&
      sameTools(withoutDescriptions(recorded), withoutDescriptions(registry));
    this.observed.set(owner, structuredClone({ ...prepared, accepted, wire: wire ?? [] }));
  }

  matches(owner: object, sessionId: string, recorded: Tool[], registry: Tool[]): boolean {
    const observed = this.observed.get(owner);
    if (!observed || observed.sessionId !== sessionId) return sameTools(recorded, registry);
    return observed.accepted && sameTools(observed.recorded, recorded) && sameTools(observed.registry, registry);
  }

  payloadValidator(owner: object, sessionId: string): ((payload: unknown) => boolean) | undefined {
    const observed = this.observed.get(owner);
    if (!observed || observed.sessionId !== sessionId || !observed.accepted) return undefined;
    const expected = structuredClone(observed.wire);
    // Preserve provider-specific schema normalization and sampling metadata
    // without reimplementing its serializer. Freeze evidence for this request.
    return (payload) => isDeepStrictEqual(expected, wireTools(payload));
  }
}
