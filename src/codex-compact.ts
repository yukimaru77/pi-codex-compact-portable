import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { Context, Model, Tool } from "@earendil-works/pi-ai";
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
  checkpointMarkerVariants,
  createCheckpointDetails,
  parseCheckpointDetails,
  projectCheckpointContext,
} from "./checkpoint.js";
import { hasCheckpointMarker } from "./protocol.js";
import { requestRemoteCompaction } from "./remote.js";
import {
  type CodexCompactSettings,
  type CodexCompactSettingsRuntime,
  type CodexCompactSettingsState,
  createCodexCompactSettingsRuntime,
} from "./settings.js";
import { showCodexCompactMenu } from "./settings-menu.js";
import { comparableTools, sameTools, ToolStateTracker } from "./tool-state.js";
import { portableModel, cachedText, projectPortable, extractForPi, addExtractionUsage,
  checkpointKey, PORTABLE_CACHE } from './portable.js';
import { abortable, PortableError, portableHandoff } from '../../codex-portable-compact/src/index.ts';

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
  "Experimental: every Codex compaction includes Luna plaintext extraction, on all models. This is model-generated, not guaranteed exact recovery.";

const COMPACTION_MODEL_ID = "gpt-6.1-sol";

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

function projectedCurrentMessages(
  event: SessionBeforeCompactEvent,
  portableText?: string,
): { messages: AgentMessage[]; transcript: AgentMessage[] } {
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
  if (!portableText) {
    throw new Error("The active checkpoint requires portable text");
  }
  const projected = projectCheckpointContext(session.messages, prior, "full");
  if (!projected) {
    throw new Error("The previous opaque checkpoint could not be projected safely");
  }
  return { messages: projectPortable(projected, prior, portableText), transcript: session.messages };
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
  if (!settings.enabled) return undefined;
  const selectedModel = ctx.model;
  // Manual compaction does not prepare a new assistant turn. After reload,
  // the live registry/base prompt legitimately differ from the last persisted
  // prepared loadout (including prepareLoadout description rewrites). Compress
  // the canonical transcript, not an invented mixture of old and live state.
  // Fence live state separately so changes DURING the operation still cancel.
  const livePrompt = ctx.getSystemPrompt();
  const liveTools = structuredClone(activeTools(pi));
  const deadline = performance.now() + settings.requestTimeoutMs;
  const sessionId = ctx.sessionManager.getSessionId();
  let stage = 'model/auth';
  ctx.ui.setStatus(STATUS_KEY, "Codex remote compaction…");
  try {
    const previous = activeCheckpoint(ctx);
    // Every Codex V2 compaction runs on Sol regardless of the session model;
    // requests always receive the Luna plaintext, never the opaque checkpoint.
    const model = portableModel(ctx, COMPACTION_MODEL_ID);
    const auth = await awaitCompactionAuth(ctx, model, event.signal, deadline);
    if (!sessionStillOwned(ctx, sessionId, event.signal)) return { cancel: true };
    if (!auth.ok || !auth.apiKey) {
      throw new Error("OpenAI Codex OAuth token is unavailable");
    }
    const provider = ctx.modelRegistry.getProvider(model.provider);
    if (!provider) throw new Error("OpenAI Codex provider is unavailable");
    let priorText = previous ? cachedText(previous.details, event.branchEntries) : undefined;
    if (previous && !priorText) {
      priorText = portableHandoff(previous.details.replacementHistory,
        (await extractForPi(ctx, previous.details.replacementHistory.at(-1)!, event.signal, auth, fetch)).text);
    }
    stage = 'checkpoint lineage projection';
    const current = projectedCurrentMessages(event, priorText);
    stage = 'transcript validation';
    const sourceLeafId = event.branchEntries.at(-1)?.id ?? null;
    const matches = () => {
      const branch = ctx.sessionManager.getBranch();
      return (ctx.sessionManager.getLeafId?.() ?? branch.at(-1)?.id ?? null) === sourceLeafId
        && ctx.getSystemPrompt() === livePrompt
        && sameTools(liveTools, activeTools(pi))
        && ctx.model?.provider === selectedModel?.provider && ctx.model?.id === selectedModel?.id;
    };
    if (!matches()) {
      // Report only structural differences, never prompt contents or credentials.
      const recorded = liveTools;
      const live = activeTools(pi);
      const recordedNames = new Set(recorded.map(t => t.name));
      const liveNames = new Set(live.map(t => t.name));
      const promptMatches = livePrompt === ctx.getSystemPrompt();
      const branch = ctx.sessionManager.getBranch();
      const leafMatches = (ctx.sessionManager.getLeafId?.() ?? branch.at(-1)?.id ?? null) === sourceLeafId;
      const missing = [...recordedNames].filter(n => !liveNames.has(n));
      const added = [...liveNames].filter(n => !recordedNames.has(n));
      stage += `; prompt=${promptMatches ? 'match' : 'changed'}, branch=${leafMatches ? 'match' : 'changed'}, tools=${sameTools(recorded, live) ? 'match' : 'changed'}, removed=${missing.join('|') || 'none'}, added=${added.join('|') || 'none'}`;
      throw new Error("Live prompt or tools differ from the persisted transcript");
    }
    const requestTools = structuredClone(piAiCompat.getCurrentTools?.(current.transcript) ?? liveTools);
    const context: Context = {
      systemPrompt: piAiCompat.getCurrentSystemPrompt?.(current.transcript) ?? livePrompt,
      messages: convertToLlm(current.messages),
      tools: requestTools,
    };
    const remainingMs = deadline - performance.now();
    if (remainingMs <= 0) throw new Error("OpenAI Codex compaction deadline exceeded");
    stage = 'remote V2';
    const response = await requestRemoteCompaction({
      provider,
      model,
      context,
      apiKey: auth.apiKey,
      headers: auth.headers,
      env: auth.env,
      signal: event.signal,
      requestTimeoutMs: remainingMs,
      maxRetries: settings.maxRetries,
      fetch,
    });
    if (!sessionStillOwned(ctx, sessionId, event.signal)) return { cancel: true };
    // appendCompaction will snapshot the session's resolved system/tool state;
    // never persist a checkpoint for a request that became stale while in flight.
    if (
      !matches()
    ) {
      throw new Error("Live prompt, tools, or session branch changed during remote compaction");
    }
    stage = 'checkpoint creation';
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
    let usage = response.usage;
    {
      ctx.ui.setStatus(STATUS_KEY, 'Codex checkpoint → Luna plaintext…');
      stage = 'Luna extraction';
      portableHandoff(replacementHistory, 'preflight');
      const portable = await extractForPi(ctx, response.item, event.signal, auth, fetch);
      if (!sessionStillOwned(ctx, sessionId, event.signal) || !matches()
        || ctx.model?.provider !== selectedModel?.provider || ctx.model?.id !== selectedModel?.id) return { cancel: true };
      details.portableText = portableHandoff(replacementHistory, portable.text);
      details.portableExtraction = { model: portable.selected.model, effort: portable.selected.effort,
        tokens: portable.tokens, targetTokens: portable.targetTokens, withinTolerance: portable.withinTolerance };
      usage = addExtractionUsage(usage, portable, ctx);
    }
    return {
      compaction: {
        summary: details.portableText!,
        firstKeptEntryId: event.preparation.firstKeptEntryId,
        tokensBefore: event.preparation.tokensBefore,
        usage,
        details,
      },
    };
  } catch (error) {
    if (event.signal.aborted || ctx.sessionManager.getSessionId() !== sessionId) {
      return { cancel: true };
    }
    {
      const reason = error instanceof PortableError ? `: ${error.code}` : '';
      if (ctx.hasUI && settings.notifyOnFallback) ctx.ui.notify(`Codex/Luna compaction failed (${stage}${reason}); history was not replaced.`, 'warning');
      return { cancel: true };
    }
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

    pi.on("context", async (event, ctx) => {
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
      if (!checkpoint) {
        const raw = activeCompaction(ctx.sessionManager.getBranch());
        if ((raw?.details as { kind?: string } | undefined)?.kind === CHECKPOINT_KIND
          || raw?.summary.startsWith('OpenAI Codex Remote Compaction V2 checkpoint ')) {
          ctx.abort();
          throw new PortableError('INVALID_CHECKPOINT_STOPPED');
        }
        return undefined;
      }
      {
        const owner = ctx.sessionManager.getSessionId();
        const leaf = ctx.sessionManager.getLeafId();
        const model = ctx.model;
        const signal = ctx.signal ? AbortSignal.any([sessionController.signal, ctx.signal]) : sessionController.signal;
        try {
          const provenance = tailProvenance.get(ctx.sessionManager);
          const mode = piCodingAgentCompat.buildSessionProjection ? 'full'
            : provenance?.checkpointId === provenanceId(ctx, checkpoint.details.checkpointId)
              ? provenance.mode : undefined;
          const projected = projectCheckpointContext(event.messages, checkpoint.details, mode);
          if (!projected) throw new PortableError('CHECKPOINT_LINEAGE_MISMATCH');
          let text = cachedText(checkpoint.details, ctx.sessionManager.getBranch());
          if (!text) {
            portableHandoff(checkpoint.details.replacementHistory, 'preflight');
            ctx.ui.setStatus(STATUS_KEY, 'Codex checkpoint → Luna plaintext…');
            const portable = await abortable(extractForPi(ctx, checkpoint.details.replacementHistory.at(-1)!, signal, undefined, options.fetch), signal);
            signal.throwIfAborted();
            if (!active || ctx.sessionManager.getSessionId() !== owner || ctx.sessionManager.getLeafId() !== leaf
              || ctx.model?.id !== model?.id || ctx.model?.provider !== model?.provider) throw new PortableError('SESSION_CHANGED');
            text = portableHandoff(checkpoint.details.replacementHistory, portable.text);
            // Metadata-only entry: original transcript/checkpoint is immutable. Cache follows its branch.
            pi.appendEntry(PORTABLE_CACHE, { key: checkpointKey(checkpoint.details), text,
              selected: portable.selected, tokens: portable.tokens, targetTokens: portable.targetTokens,
              withinTolerance: portable.withinTolerance, receipts: portable.receipts });
          }
          return { messages: projectPortable(projected, checkpoint.details, text) };
        } catch (error) {
          // Pi catches context-hook exceptions. Explicitly abort the request before returning,
          // otherwise a failed conversion could send only the fallback marker to another model.
          const cancelled = signal.aborted;
          ctx.abort();
          const reason = error instanceof PortableError ? ` (${error.code})` : '';
          if (ctx.hasUI && !cancelled) ctx.ui.notify(`Luna checkpoint conversion failed${reason}; this request was stopped without replacing history.`, 'error');
          throw new PortableError('CHECKPOINT_CONVERSION_STOPPED');
        } finally {
          if (ctx.sessionManager.getSessionId() === owner) ctx.ui.setStatus(STATUS_KEY, undefined);
        }
      }
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
      if (!checkpoint) return undefined;
      const markers = checkpointMarkerVariants(checkpoint.details.checkpointId);
      if (!hasCheckpointMarker(event.payload, markers)) return undefined;
      ctx.abort();
      throw new PortableError('OPAQUE_REPLAY_DISABLED');
    });

    pi.on("model_select", (event, ctx) => {
      if (!settingsRuntime.get().settings.enabled) return;
      const checkpoint = activeCheckpoint(ctx);
      if (!checkpoint || cachedText(checkpoint.details, ctx.sessionManager.getBranch())) return;
      const key = `${ctx.sessionManager.getSessionId()}:${event.model.provider}:${event.model.id}`;
      if (providerWarnings.has(key)) return;
      providerWarnings.add(key);
      if (ctx.hasUI) {
        ctx.ui.notify(
          "The Codex checkpoint needs portable text on this model. Luna conversion will run before the next request (or reuse the saved handoff).",
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