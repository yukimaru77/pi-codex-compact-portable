import type { Context, Model, Provider, ProviderHeaders, Usage } from "@earendil-works/pi-ai";
import * as piAi from "@earendil-works/pi-ai";
import {
  CodexCompactionProtocolError,
  type CollectedCompaction,
  collectCompactionSse,
  type JsonObject,
  prepareRemoteCompactionPayload,
} from "./protocol.js";

interface PriorCheckpointPayload {
  marker: string;
  replacementHistory: readonly unknown[];
}

export interface RemoteCompactionRequest {
  provider: Provider;
  model: Model<"openai-codex-responses">;
  context: Context;
  apiKey?: string;
  headers?: ProviderHeaders;
  env?: Record<string, string>;
  signal: AbortSignal;
  priorCheckpoint?: PriorCheckpointPayload;
  validatePayload?: (payload: unknown) => boolean;
  requestTimeoutMs?: number;
  maxRetries?: number;
  fetch?: typeof globalThis.fetch;
}

export interface RemoteCompactionResponse {
  item: JsonObject;
  promptInput: JsonObject[];
  usage: Usage;
}

const EMPTY_USAGE: Usage = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

// Pi 0.87 requires a normalized transcript at the provider boundary; 0.84/0.85
// have no normalizeContext export and still accept the original Context there.
type ProviderContext = Parameters<Provider["stream"]>[1];
type ContextNormalizer = (context: Context) => ProviderContext;
const piAiCompat = piAi as typeof piAi & { normalizeContext?: ContextNormalizer };

export function contextForProvider(context: Context, normalize: ContextNormalizer | undefined): ProviderContext {
  if (!normalize) return context as ProviderContext;
  // The session transcript already carries the current prompt and tool loadout.
  // Adding the legacy shorthand here would replay the prompt twice and could
  // restore tools that a later system message removed.
  const canonical = context.messages.some((message) => message.role === "system")
    ? { messages: context.messages }
    : context;
  return normalize(canonical);
}

function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function abortError(): DOMException {
  return new DOMException("Compaction aborted", "AbortError");
}

export async function requestRemoteCompaction(request: RemoteCompactionRequest): Promise<RemoteCompactionResponse> {
  const controller = new AbortController();
  const onRequestAbort = () => controller.abort();
  let onOperationAbort = () => {};
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    if (request.signal.aborted) throw abortError();
    request.signal.addEventListener("abort", onRequestAbort, { once: true });
    const interrupted = new Promise<never>((_resolve, reject) => {
      onOperationAbort = () => reject(abortError());
      controller.signal.addEventListener("abort", onOperationAbort, { once: true });
    });
    // Provider timeouts can stop at response headers. Own the deadline through
    // body inspection and provider completion, even for an injected transport.
    timeout = setTimeout(() => controller.abort(), request.requestTimeoutMs ?? 5 * 60 * 1000);
    return await Promise.race([performRemoteCompaction({ ...request, signal: controller.signal }), interrupted]);
  } catch {
    // Provider and transport errors can echo credentials. Keep all failures at
    // this public boundary opaque, including inspection errors and abort reasons.
    if (request.signal.aborted) throw abortError();
    throw new Error("OpenAI Codex compaction request failed");
  } finally {
    clearTimeout(timeout);
    request.signal.removeEventListener("abort", onRequestAbort);
    controller.signal.removeEventListener("abort", onOperationAbort);
    controller.abort();
  }
}

async function performRemoteCompaction(request: RemoteCompactionRequest): Promise<RemoteCompactionResponse> {
  if (request.signal.aborted) throw abortError();
  let sentInput: JsonObject[] | undefined;
  const inspections: Promise<{ ok: true; value: CollectedCompaction } | { ok: false; error: unknown }>[] = [];
  const baseFetch = request.fetch ?? globalThis.fetch;
  const inspectedFetch: typeof globalThis.fetch = async (input, init) => {
    const signal = init?.signal ? AbortSignal.any([request.signal, init.signal]) : request.signal;
    const response = await baseFetch(input, { ...init, signal });
    if (signal.aborted) {
      void response.body?.cancel().catch(() => undefined);
      throw abortError();
    }
    if (!response.body) return response;
    // Abort the body independently of fetch: injected fetch implementations
    // need not honor signals, and a native fetch may only time out headers.
    const bridge = new TransformStream<Uint8Array, Uint8Array>();
    void response.body.pipeTo(bridge.writable, { signal }).catch(() => undefined);
    let providerBody = bridge.readable;
    if (response.ok) {
      const [providerBranch, inspectionBody] = providerBody.tee();
      providerBody = providerBranch;
      const inspection = collectCompactionSse(inspectionBody, { signal: request.signal }).then(
        (value) => ({ ok: true as const, value }),
        (error: unknown) => ({ ok: false as const, error }),
      );
      inspections.push(inspection);
    }
    return new Response(providerBody, {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    });
  };

  const stream = request.provider.stream(
    request.model,
    contextForProvider(request.context, piAiCompat.normalizeContext),
    {
      apiKey: request.apiKey,
      headers: request.headers,
      env: request.env,
      signal: request.signal,
      transport: "sse",
      cacheRetention: "none",
      timeoutMs: request.requestTimeoutMs ?? 5 * 60 * 1000,
      maxRetries: request.maxRetries ?? 2,
      fetch: inspectedFetch,
      onPayload: (payload) => {
        if (request.validatePayload && !request.validatePayload(payload)) {
          throw new CodexCompactionProtocolError("Compaction tool declarations differ from the observed request");
        }
        const prepared = prepareRemoteCompactionPayload(payload, request.priorCheckpoint);
        if (!Array.isArray(prepared.input) || !prepared.input.every(isObject)) {
          throw new CodexCompactionProtocolError("Prepared compaction payload has invalid input items");
        }
        sentInput = structuredClone(prepared.input.slice(0, -1)) as JsonObject[];
        return prepared;
      },
    },
  );

  let usage = EMPTY_USAGE;
  for await (const event of stream) {
    if (request.signal.aborted) throw abortError();
    if (event.type === "error") {
      throw new Error("OpenAI Codex compaction request failed");
    }
    if (event.type === "done") usage = event.message.usage;
  }
  if (request.signal.aborted) throw abortError();
  if (!sentInput) throw new CodexCompactionProtocolError("Provider did not expose a request payload");
  if (inspections.length === 0) {
    throw new CodexCompactionProtocolError("Provider response did not expose an SSE body");
  }
  const inspection = await inspections.at(-1);
  if (request.signal.aborted) throw abortError();
  if (!inspection?.ok) throw inspection?.error ?? new Error("Remote compaction inspection failed");
  return { item: inspection.value.item, promptInput: sentInput, usage };
}
