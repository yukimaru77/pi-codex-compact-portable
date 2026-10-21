import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { Api, Context, Model, Tool } from "@earendil-works/pi-ai";
import * as piAi from "@earendil-works/pi-ai";
import * as piCodingAgent from "@earendil-works/pi-coding-agent";
import {
  buildContextEntries,
  buildSessionContext,
  convertToLlm,
  type ExtensionAPI,
  type ExtensionContext,
  type SessionBeforeCompactEvent,
  type SessionEntry,
  sessionEntryToContextMessages,
} from "@earendil-works/pi-coding-agent";
import {
  buildReplacementHistory,
  CHECKPOINT_KIND,
  type CodexCheckpointDetails,
  checkpointMarker,
  checkpointMarkerVariants,
  createCheckpointDetails,
  fallbackSummary,
  parseCheckpointDetails,
  projectCheckpointContext,
} from "./checkpoint.js";
import { hasCheckpointMarker, rewriteCheckpointMarker } from "./protocol.js";
import { requestRemoteCompaction } from "./remote.js";
import {
  type CodexCompactSettings,
  type CodexCompactSettingsRuntime,
  type CodexCompactSettingsState,
  createCodexCompactSettingsRuntime,
} from "./settings.js";
import { showCodexCompactMenu } from "./settings-menu.js";
import { comparableTools, sameTools, ToolStateTracker } from "./tool-state.js";

// Extension-owned reload handoff only. Weak keys retain neither sessions nor ctx;
// one scalar record per live manager, fenced by session identity + checkpoint ID.
const provenanceKey = Symbol.for("@signalridge/pi-codex-compact/retry-provenance/v1");
type TailProvenance = { checkpointId: string; mode: "full" | "runtime-omitted" };
const provenanceGlobal = globalThis as typeof globalThis & {
  [provenanceKey]?: WeakMap<object, TailProvenance>;
};
const tailProvenance = provenanceGlobal[provenanceKey] ?? new WeakMap<object, TailProvenance>();
provenanceGlobal[provenanceKey] = tailProvenance;
function provenanceId(ctx: ExtensionContext, checkpointId: string): string {
  return JSON.stringify([ctx.sessionManager.getSessionId(), checkpointId]);
}
function resetTailProvenance(ctx: ExtensionContext): void {
  tailProvenance.delete(ctx.sessionManager);
  const checkpoint = activeCheckpoint(ctx);
  if (checkpoint)
    tailProvenance.set(ctx.sessionManager, {
      checkpointId: provenanceId(ctx, checkpoint.details.checkpointId),
      mode: "full",
    });
}

const STATUS_KEY = "codex-compact";
const EXPERIMENTAL_WARNING =
  "Experimental: Codex Remote Compaction V2 uses an opaque, provider-specific checkpoint. Sessions require this extension and openai-codex for full replay.";

function isSupportedModel(model: Model<Api> | undefined): model is Model<"openai-codex-responses"> {
  return model?.provider === "openai-codex" && piAi.hasApi(model, "openai-codex-responses");
}

function activeCompaction(entries: SessionEntry[]) {
  // Pi places the effective compaction first, before any retained older entries.
  // Searching raw history (or scanning this list backwards) can resurrect a
  // superseded remote checkpoint after native fallback.
  const entry = buildContextEntries(entries, entries.at(-1)?.id ?? null)[0];
  return entry?.type === "compaction" ? entry : undefined;
}

function activeCheckpoint(ctx: ExtensionContext) {
  const entry = activeCompaction(ctx.sessionManager.getBranch());
  const details = parseCheckpointDetails(entry?.details);
  return entry && details ? { entry, details } : undefined;
}

function isCheckpointCompatible(
  details: CodexCheckpointDetails,
  model: Model<Api> | undefined,
): model is Model<"openai-codex-responses"> {
  return isSupportedModel(model) && model.id === details.modelId;
}

// Pi 0.87 exposes the canonical context-edit projection; older supported hosts
// have only raw context entries and must continue using that legacy path.
const piCodingAgentCompat: { buildSessionProjection?: typeof piCodingAgent.buildSessionProjection } = piCodingAgent;
const piAiCompat: {
  getCurrentSystemPrompt?: typeof piAi.getCurrentSystemPrompt;
  getCurrentTools?: typeof piAi.getCurrentTools;
} = piAi;

function keptMessages(event: SessionBeforeCompactEvent): AgentMessage[] {
  const leafId = event.branchEntries.at(-1)?.id ?? null;
  const projection = piCodingAgentCompat.buildSessionProjection?.(event.branchEntries, leafId);
  if (projection) {
    // The cut point is a raw entry ID even when its model-visible contribution
    // was omitted or replaced. Keep its position; fingerprint only projected messages.
    const keptIndex = projection.entries.findIndex(
      (entry) => entry.sourceEntry.id === event.preparation.firstKeptEntryId,
    );
    if (keptIndex < 0) throw new Error("Pi compaction cut point is not present in the active context");
    // appendCompaction snapshots the resolved system state on the new compaction
    // entry; it does not retain earlier system entries from this raw cut point.
    return projection.entries
      .slice(keptIndex)
      .flatMap((entry) => entry.messages)
      .filter((message) => message.role !== "system");
  }
  const contextEntries = buildContextEntries(event.branchEntries, leafId);
  const keptIndex = contextEntries.findIndex((entry) => entry.id === event.preparation.firstKeptEntryId);
  if (keptIndex < 0) throw new Error("Pi compaction cut point is not present in the active context");
  return contextEntries.slice(keptIndex).flatMap(sessionEntryToContextMessages);
}

function activeTools(pi: ExtensionAPI): Tool[] {
  const enabled = new Set(pi.getActiveTools());
  return pi
    .getAllTools()
    .filter((tool) => enabled.has(tool.name))
    .map((tool) => ({
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters,
    }));
}

function transcriptMatchesLiveState(
  messages: AgentMessage[],
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  toolState: ToolStateTracker,
): boolean {
  // Older Pi hosts have no persisted system/tool projection: their provider
  // still uses the live shorthand, so retain that legacy compaction path.
  if (!piCodingAgentCompat.buildSessionProjection) return true;
  const { getCurrentSystemPrompt, getCurrentTools } = piAiCompat;
  if (!getCurrentSystemPrompt || !getCurrentTools) return false;
  return (
    getCurrentSystemPrompt(messages) === ctx.getSystemPrompt() &&
    toolState.matches(
      ctx.sessionManager,
      ctx.sessionManager.getSessionId(),
      comparableTools(getCurrentTools(messages)),
      activeTools(pi),
    )
  );
}

function sessionStateMatchesRequest(
  messages: AgentMessage[],
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  expectedLeafId: string | null,
  toolState: ToolStateTracker,
): boolean {
  if (!transcriptMatchesLiveState(messages, pi, ctx, toolState)) return false;
  if (!piCodingAgentCompat.buildSessionProjection) return true;
  const branch = ctx.sessionManager.getBranch();
  const currentLeafId = ctx.sessionManager.getLeafId?.() ?? branch.at(-1)?.id ?? null;
  if (currentLeafId !== expectedLeafId) return false;
  const latest = buildSessionContext(branch, currentLeafId).messages;
  return transcriptMatchesLiveState(latest, pi, ctx, toolState);
}

function projectedCurrentMessages(
  event: SessionBeforeCompactEvent,
  model: Model<"openai-codex-responses">,
): { messages: AgentMessage[]; transcript: AgentMessage[]; prior?: CodexCheckpointDetails } {
  const leafId = event.branchEntries.at(-1)?.id ?? null;
  const session = buildSessionContext(event.branchEntries, leafId);
  const compaction = activeCompaction(event.branchEntries);
  const prior = parseCheckpointDetails(compaction?.details);
  if (!prior) {
    const details = compaction?.details;
    if (
      (details && typeof details === "object" && "kind" in details && details.kind === CHECKPOINT_KIND) ||
      compaction?.summary.startsWith("OpenAI Codex Remote Compaction V2 checkpoint ")
    ) {
      throw new Error("The active opaque checkpoint is malformed");
    }
    return { messages: session.messages, transcript: session.messages };
  }
  if (prior.modelId !== model.id) {
    throw new Error("The active opaque checkpoint belongs to a different Codex model");
  }
  const projected = projectCheckpointContext(session.messages, prior, "full");
  if (!projected) {
    throw new Error("The previous opaque checkpoint could not be projected safely");
  }
  return { messages: projected, transcript: session.messages, prior };
}

function notifyFailure(ctx: ExtensionContext, settings: CodexCompactSettings): void {
  if (!ctx.hasUI || !settings.notifyOnFallback) return;
  ctx.ui.notify("Codex remote compaction failed; using Pi compaction.", "warning");
}

function sessionStillOwned(ctx: ExtensionContext, sessionId: string, signal: AbortSignal): boolean {
  return !signal.aborted && ctx.sessionManager.getSessionId() === sessionId;
}

async function awaitCompactionAuth(
  ctx: ExtensionContext,
  model: Model<"openai-codex-responses">,
  signal: AbortSignal,
  deadline: number,
) {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  let onAbort = () => {};
  try {
    if (signal.aborted) throw new DOMException("Compaction aborted", "AbortError");
    const remainingMs = deadline - performance.now();
    if (remainingMs <= 0) throw new Error("OpenAI Codex compaction deadline exceeded");
    const interrupted = new Promise<never>((_resolve, reject) => {
      onAbort = () => reject(new DOMException("Compaction aborted", "AbortError"));
      signal.addEventListener("abort", onAbort, { once: true });
      timeout = setTimeout(() => reject(new Error("OpenAI Codex compaction deadline exceeded")), remainingMs);
    });
    // Race only our wait. Pi owns token refresh and persistence, which must be
    // allowed to finish after cancellation. Promise.race observes late rejection.
    return await Promise.race([ctx.modelRegistry.getApiKeyAndHeaders(model), interrupted]);
  } catch {
    // Authentication errors and abort reasons can contain credentials.
    throw new Error("OpenAI Codex authentication failed");
  } finally {
    clearTimeout(timeout);
    signal.removeEventListener("abort", onAbort);
  }
}

async function compactRemotely(
  pi: ExtensionAPI,
  event: SessionBeforeCompactEvent,
  ctx: ExtensionContext,
  settings: CodexCompactSettings,
  toolState: ToolStateTracker,
  fetch?: typeof globalThis.fetch,
) {
  const model = ctx.model;
  if (!settings.enabled || !isSupportedModel(model)) return undefined;
  const deadline = performance.now() + settings.requestTimeoutMs;
  const sessionId = ctx.sessionManager.getSessionId();
  ctx.ui.setStatus(STATUS_KEY, "Codex remote compaction…");
  try {
    const auth = await awaitCompactionAuth(ctx, model, event.signal, deadline);
    if (!sessionStillOwned(ctx, sessionId, event.signal)) return { cancel: true };
    if (!auth.ok || !auth.apiKey) {
      throw new Error("OpenAI Codex OAuth token is unavailable");
    }
    const provider = ctx.modelRegistry.getProvider(model.provider);
    if (!provider) throw new Error("OpenAI Codex provider is unavailable");
    const current = projectedCurrentMessages(event, model);
    const sourceLeafId = event.branchEntries.at(-1)?.id ?? null;
    if (!sessionStateMatchesRequest(current.transcript, pi, ctx, sourceLeafId, toolState)) {
      throw new Error("Live prompt or tools differ from the persisted transcript");
    }
    const requestTools = structuredClone(activeTools(pi));
    const context: Context = {
      systemPrompt: ctx.getSystemPrompt(),
      messages: convertToLlm(current.messages),
      tools: requestTools,
    };
    const remainingMs = deadline - performance.now();
    if (remainingMs <= 0) throw new Error("OpenAI Codex compaction deadline exceeded");
    const response = await requestRemoteCompaction({
      provider,
      model,
      context,
      validatePayload: toolState.payloadValidator(ctx.sessionManager, sessionId),
      apiKey: auth.apiKey,
      headers: auth.headers,
      env: auth.env,
      signal: event.signal,
      priorCheckpoint: current.prior
        ? {
            marker: checkpointMarker(current.prior.checkpointId),
            replacementHistory: current.prior.replacementHistory,
          }
        : undefined,
      requestTimeoutMs: remainingMs,
      maxRetries: settings.maxRetries,
      fetch,
    });
    if (!sessionStillOwned(ctx, sessionId, event.signal)) return { cancel: true };
    // appendCompaction will snapshot the session's resolved system/tool state;
    // never persist a checkpoint for a request that became stale while in flight.
    if (
      !sessionStateMatchesRequest(current.transcript, pi, ctx, sourceLeafId, toolState) ||
      (piCodingAgentCompat.buildSessionProjection && !sameTools(requestTools, activeTools(pi)))
    ) {
      throw new Error("Live prompt, tools, or session branch changed during remote compaction");
    }
    const replacementHistory = buildReplacementHistory(response.promptInput, response.item, {
      tokenBudget: settings.replacementTokenBudget,
    });
    const details = createCheckpointDetails({
      modelId: model.id,
      replacementHistory,
      keptMessages: keptMessages(event),
      // Canonical hosts persist recovery omissions before this hook. Retained
      // projected messages are full lineage, never a tail to remove afterward.
      willRetry: !piCodingAgentCompat.buildSessionProjection && event.willRetry,
    });
    return {
      compaction: {
        summary: fallbackSummary(details.checkpointId),
        firstKeptEntryId: event.preparation.firstKeptEntryId,
        tokensBefore: event.preparation.tokensBefore,
        usage: response.usage,
        details,
      },
    };
  } catch {
    if (event.signal.aborted || ctx.sessionManager.getSessionId() !== sessionId) {
      return { cancel: true };
    }
    notifyFailure(ctx, settings);
    return undefined;
  } finally {
    if (ctx.sessionManager.getSessionId() === sessionId) ctx.ui.setStatus(STATUS_KEY, undefined);
  }
}

export function createCodexCompactExtension(
  options: { fetch?: typeof globalThis.fetch; settingsRuntime?: CodexCompactSettingsRuntime } = {},
): (pi: ExtensionAPI) => void {
  return (pi) => {
    const providerWarnings = new Set<string>();
    const settingsRuntime = options.settingsRuntime ?? createCodexCompactSettingsRuntime();
    const toolState = new ToolStateTracker();
    let sessionController = new AbortController();
    let generation = 0;
    let active = true;

    pi.registerCommand("codex-compact", {
      description: "Compact now or configure experimental Codex Remote Compaction V2",
      handler: async (_args, ctx) => {
        const ownerGeneration = generation;
        await showCodexCompactMenu(settingsRuntime, ctx, {
          signal: sessionController.signal,
          isCurrent: () => ownerGeneration === generation && !sessionController.signal.aborted,
        });
      },
    });

    pi.on("session_start", async (event, ctx) => {
      active = true;
      toolState.reset(ctx.sessionManager);
      if (event.reason !== "reload") resetTailProvenance(ctx);
      sessionController.abort();
      sessionController = new AbortController();
      generation += 1;
      const ownerGeneration = generation;
      const sessionId = ctx.sessionManager.getSessionId();
      providerWarnings.clear();
      let state: Readonly<CodexCompactSettingsState>;
      try {
        state = await settingsRuntime.reload(sessionController.signal);
      } catch (error) {
        if (sessionController.signal.aborted || ownerGeneration !== generation) return;
        if (ctx.hasUI) {
          ctx.ui.notify(
            `Could not load pi-codex-compact.json; using defaults. ${error instanceof Error ? error.message : String(error)}`,
            "warning",
          );
        }
        return;
      }
      if (
        sessionController.signal.aborted ||
        ownerGeneration !== generation ||
        ctx.sessionManager.getSessionId() !== sessionId
      ) {
        return;
      }
      if (ctx.hasUI) {
        ctx.ui.notify(EXPERIMENTAL_WARNING, "warning");
        if (state.kind === "invalid") {
          ctx.ui.notify(
            `Invalid pi-codex-compact.json; using defaults without overwriting it. ${state.issue}`,
            "warning",
          );
        }
      }
    });

    pi.on("session_before_compact", (event, ctx) =>
      compactRemotely(pi, event, ctx, settingsRuntime.get().settings, toolState, options.fetch),
    );

    // Legacy hosts trim a recovery tail after compaction. Canonical hosts have
    // already persisted context edits before the hook and keep full provenance.
    pi.on("session_compact", (event, ctx) => {
      if (!active) return;
      resetTailProvenance(ctx);
      const checkpoint = activeCheckpoint(ctx);
      if (
        !piCodingAgentCompat.buildSessionProjection &&
        event.willRetry &&
        checkpoint?.entry.id === event.compactionEntry.id &&
        checkpoint.details.retryTrimmedTail
      ) {
        tailProvenance.set(ctx.sessionManager, {
          checkpointId: provenanceId(ctx, checkpoint.details.checkpointId),
          mode: "runtime-omitted",
        });
      }
    });

    pi.on("session_tree", (_event, ctx) => {
      toolState.reset(ctx.sessionManager);
      if (active) resetTailProvenance(ctx);
    });

    pi.on("context", (event, ctx) => {
      if (!active || !settingsRuntime.get().settings.enabled) return undefined;
      // Agent-core invokes context preparation for a new request. Cache warming
      // reuses the prepared context and only invokes provider callbacks.
      if (piCodingAgentCompat.buildSessionProjection && piAiCompat.getCurrentTools) {
        // The public context event hides system messages. Read the canonical
        // branch, whose prepared declarations were persisted before this hook.
        const branch = ctx.sessionManager.getBranch();
        const transcript = buildSessionContext(branch, branch.at(-1)?.id ?? null).messages;
        toolState.prepare(
          ctx.sessionManager,
          ctx.sessionManager.getSessionId(),
          comparableTools(piAiCompat.getCurrentTools(transcript)),
          activeTools(pi),
        );
      }
      const checkpoint = activeCheckpoint(ctx);
      if (!checkpoint || !isCheckpointCompatible(checkpoint.details, ctx.model)) return undefined;
      const provenance = tailProvenance.get(ctx.sessionManager);
      const mode = piCodingAgentCompat.buildSessionProjection
        ? "full"
        : provenance?.checkpointId === provenanceId(ctx, checkpoint.details.checkpointId)
          ? provenance.mode
          : undefined;
      const messages = projectCheckpointContext(event.messages, checkpoint.details, mode);
      return messages ? { messages } : undefined;
    });

    pi.on("before_provider_request", (event, ctx) => {
      if (!active || !settingsRuntime.get().settings.enabled) return undefined;
      // A provider callback must match fresh context preparation and the actual
      // wire declarations. Warming cannot bless an unsent registry edit; remote
      // compaction's own onPayload does not establish observations.
      if (
        piCodingAgentCompat.buildSessionProjection &&
        piAiCompat.getCurrentTools &&
        piAiCompat.getCurrentSystemPrompt
      ) {
        const branch = ctx.sessionManager.getBranch();
        const transcript = buildSessionContext(branch, branch.at(-1)?.id ?? null).messages;
        if (piAiCompat.getCurrentSystemPrompt(transcript) === ctx.getSystemPrompt()) {
          toolState.observe(
            ctx.sessionManager,
            ctx.sessionManager.getSessionId(),
            comparableTools(piAiCompat.getCurrentTools(transcript)),
            activeTools(pi),
            event.payload,
          );
        } else {
          toolState.reset(ctx.sessionManager);
        }
      }
      const checkpoint = activeCheckpoint(ctx);
      if (!checkpoint || !isCheckpointCompatible(checkpoint.details, ctx.model)) return undefined;
      const markers = checkpointMarkerVariants(checkpoint.details.checkpointId);
      if (!hasCheckpointMarker(event.payload, markers)) return undefined;
      return rewriteCheckpointMarker(event.payload, markers, checkpoint.details.replacementHistory);
    });

    pi.on("model_select", (event, ctx) => {
      if (!settingsRuntime.get().settings.enabled) return;
      const checkpoint = activeCheckpoint(ctx);
      if (!checkpoint || isCheckpointCompatible(checkpoint.details, event.model)) return;
      const key = `${ctx.sessionManager.getSessionId()}:${event.model.provider}:${event.model.id}`;
      if (providerWarnings.has(key)) return;
      providerWarnings.add(key);
      if (ctx.hasUI) {
        ctx.ui.notify(
          "The active Codex checkpoint cannot replay on this model; Pi will expose only its fallback marker and retained recent messages.",
          "warning",
        );
      }
    });

    pi.on("session_shutdown", async (event, ctx) => {
      active = false;
      toolState.reset(ctx.sessionManager);
      if (event.reason !== "reload") tailProvenance.delete(ctx.sessionManager);
      generation += 1;
      sessionController.abort();
      providerWarnings.clear();
      ctx.ui.setStatus(STATUS_KEY, undefined);
      await settingsRuntime.flush();
    });
  };
}

export default createCodexCompactExtension();
