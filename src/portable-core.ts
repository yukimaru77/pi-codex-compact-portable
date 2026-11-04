/** KB-compatible, model-generated plaintext extraction. No credential store or harness state.
 * Merged from the former sibling package codex-portable-compact so this extension is self-contained. */
export type Json = Record<string, any>;
export const CODEX_URL = 'https://chatgpt.com/backend-api/codex/responses';
export const KB_INSTRUCTIONS = 'Follow the user instructions.';
export const KB_PROMPT = 'I want to create a handoff document. Using only the supplied compacted context, '
  + 'output every piece of knowledge contained in it exactly word for word. Do not '
  + 'summarize, paraphrase, omit, translate, or add anything. Preserve the original '
  + 'order and formatting. If the context uses a private language, machine-oriented encoding, '
  + 'or any unusual format, preserve it exactly; do not translate or make it human-friendly. '
  + 'It only needs to remain readable to an AI. Do not optimize for human comfort. '
  + 'Output only the handoff material.';
export const WAVES = [
  [['gpt-6-luna', 'high', 1], ['gpt-6-luna', 'max', 1]],
  [['gpt-6-luna', 'high', 2], ['gpt-6-luna', 'max', 2]],
  [['gpt-5.6-luna', 'high', 1], ['gpt-5.6-luna', 'max', 1]],
  [['gpt-5.6-luna', 'high', 2], ['gpt-5.6-luna', 'max', 2]],
  // Last resort, as in kb-repomap's kb_decrypt: gpt-6.1-terra also reproduces compaction blobs.
  [['gpt-6.1-terra', 'high', 1], ['gpt-6.1-terra', 'max', 1]],
] as const;
export const MAX_TEXT_BYTES = 8 * 1024 * 1024;
const MAX_BLOB_BYTES = 2 * 1024 * 1024;
const MAX_STREAM_BYTES = 24 * 1024 * 1024;
const encoder = new TextEncoder();
const size = (s: string) => encoder.encode(s).byteLength;
const object = (v: unknown): v is Json => !!v && typeof v === 'object' && !Array.isArray(v);
const count = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0;

export class PortableError extends Error {
  constructor(readonly code: string) { super(`Codex portable extraction: ${code}`); this.name = 'PortableError'; }
}
export interface Auth { apiKey: string; accountId: string; headers?: Record<string, string> }
export interface Attempt { model: string; effort: 'high' | 'max'; repeat: number; order: number }
export interface Extraction { text: string; tokens?: number; blobTokens?: number; usage: Json; complete: boolean }
export interface Receipt extends Attempt { tokens?: number; blobTokens?: number; usage: Json; complete: boolean }
export interface PortableResult {
  text: string; selected: Attempt; tokens: number; targetTokens: number;
  withinTolerance: boolean; receipts: Receipt[];
}

export function validateBlob(blob: unknown): asserts blob is Json {
  if (!object(blob) || !['compaction', 'compaction_summary', 'context_compaction'].includes(blob.type)
    || typeof blob.encrypted_content !== 'string' || !blob.encrypted_content
    || size(JSON.stringify(blob)) > MAX_BLOB_BYTES) throw new PortableError('INVALID_BLOB');
}

export function extractionPayload(blob: Json, attempt: Attempt): Json {
  validateBlob(blob);
  if (!WAVES.flat().some(([model, effort, repeat]) => attempt.model === model && attempt.effort === effort && attempt.repeat === repeat)) {
    throw new PortableError('INVALID_LUNA_ATTEMPT');
  }
  return {
    model: attempt.model, reasoning: { effort: attempt.effort }, service_tier: 'default',
    instructions: KB_INSTRUCTIONS,
    input: [structuredClone(blob), { type: 'message', role: 'user', content: [{ type: 'input_text', text: KB_PROMPT }] }],
    tools: [], stream: true, store: false, parallel_tool_calls: false,
  };
}

/** Await even an uncooperative injected transport without letting it publish later. */
export async function abortable<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) { void work.catch(() => {}); throw new PortableError('CANCELLED'); }
  let onAbort = () => {};
  try {
    return await Promise.race([work, new Promise<never>((_, reject) => {
      onAbort = () => reject(new PortableError('CANCELLED'));
      signal.addEventListener('abort', onAbort, { once: true });
      if (signal.aborted) onAbort();
    })]);
  } finally { signal.removeEventListener('abort', onAbort); }
}

/** Completed output only. Deltas are not a complete handoff and are never returned. */
export async function collectExtraction(body: ReadableStream<Uint8Array>, blob: Json, signal: AbortSignal): Promise<Extraction> {
  validateBlob(blob);
  const reader = body.getReader();
  const decoder = new TextDecoder('utf-8', { fatal: true });
  let buffer = '', bytes = 0, completed: Json | undefined;
  let terminal = false;
  const data: string[] = [];
  const event = () => {
    if (!data.length) return;
    const raw = data.splice(0).join('\n');
    if (raw === '[DONE]') return;
    let item: Json;
    try { item = JSON.parse(raw); } catch { throw new PortableError('MALFORMED_SSE'); }
    if (!object(item) || typeof item.type !== 'string') throw new PortableError('MALFORMED_EVENT');
    if (terminal) throw new PortableError('EVENT_AFTER_TERMINAL');
    if (['response.completed', 'response.incomplete', 'response.failed', 'error'].includes(item.type)) {
      terminal = true;
      if (!object(item.response)) throw new PortableError('INVALID_TERMINAL');
      completed = { ...item.response, _complete: item.type === 'response.completed' };
    }
  };
  const line = (s: string) => {
    if (s.endsWith('\r')) s = s.slice(0, -1);
    if (!s) event();
    else if (s.startsWith('data:')) data.push(s.slice(5).replace(/^ /, ''));
  };
  const onAbort = () => { void reader.cancel().catch(() => {}); };
  signal.addEventListener('abort', onAbort, { once: true });
  try {
    while (!terminal) {
      const chunk = await abortable(reader.read(), signal);
      signal.throwIfAborted();
      if (chunk.done) break;
      bytes += chunk.value.byteLength;
      if (bytes > MAX_STREAM_BYTES) throw new PortableError('STREAM_TOO_LARGE');
      buffer += decoder.decode(chunk.value, { stream: true });
      let end: number;
      while (!terminal && (end = buffer.indexOf('\n')) >= 0) { line(buffer.slice(0, end)); buffer = buffer.slice(end + 1); }
    }
    if (!terminal) {
      buffer += decoder.decode();
      if (buffer) line(buffer);
      event();
    }
    if (!completed) throw new PortableError('MISSING_TERMINAL');
    const usage = object(completed.usage) ? completed.usage : {};
    if (!completed._complete || (completed.status !== undefined && completed.status !== 'completed')) {
      return { text: '', usage, complete: false };
    }
    if (!Array.isArray(completed.output)) throw new PortableError('MISSING_OUTPUT');
    // Tool calls/refusals or mixed non-text output cannot masquerade as a KB handoff.
    if (completed.output.some((item: Json) => !object(item) || !['message', 'reasoning'].includes(item.type))) {
      throw new PortableError('UNEXPECTED_OUTPUT');
    }
    const messages = completed.output.filter((item: Json) => item.type === 'message');
    if (!messages.length || messages.some((item: Json) => item.role !== 'assistant' || !Array.isArray(item.content)
      || (item.status !== undefined && item.status !== 'completed')
      || item.content.some((part: Json) => !object(part) || part.type !== 'output_text' || typeof part.text !== 'string'))) {
      throw new PortableError('INVALID_TEXT_OUTPUT');
    }
    const text = messages.flatMap((item: Json) => item.content.map((part: Json) => part.text)).join('\n');
    if (!text.trim() || size(text) > MAX_TEXT_BYTES) throw new PortableError('EMPTY_OR_OVERSIZED_TEXT');
    const attribution = object(usage.attribution?.items) ? usage.attribution.items : {};
    const visible = messages.map((item: Json) => attribution[item.id]?.output_tokens);
    const target = attribution[blob.id]?.input_tokens;
    return { text, usage, complete: true,
      ...(visible.length && visible.every(count) ? { tokens: visible.reduce((a: number, b: number) => a + b, 0) } : {}),
      ...(count(target) ? { blobTokens: target } : {}) };
  } catch (error) {
    if (error instanceof PortableError) throw error;
    throw new PortableError(signal.aborted ? 'CANCELLED' : 'INVALID_STREAM');
  } finally {
    signal.removeEventListener('abort', onAbort);
    void reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

/** Only existing harness credentials may be supplied. Auth is never put in payloads or receipts. */
export async function sendExtraction(blob: Json, attempt: Attempt, options: {
  auth: Auth; signal: AbortSignal; fetch?: typeof fetch; userAgent: string; attribution?: Record<string, string>;
}): Promise<Extraction> {
  const payload = extractionPayload(blob, attempt);
  if (!options.auth.apiKey || !options.auth.accountId) throw new PortableError('AUTH_UNAVAILABLE');
  const headers = new Headers(options.auth.headers);
  headers.set('originator', 'pi'); headers.set('user-agent', options.userAgent);
  for (const [name, value] of Object.entries(options.attribution ?? {})) headers.set(name, value);
  headers.set('authorization', `Bearer ${options.auth.apiKey}`);
  headers.set('chatgpt-account-id', options.auth.accountId);
  headers.set('content-type', 'application/json'); headers.set('accept', 'text/event-stream');
  headers.set('openai-beta', 'responses=experimental');
  // No inherited session/prefix cache: these are independent one-shot extraction calls.
  for (const name of ['session-id', 'x-client-request-id', 'x-codex-turn-metadata']) headers.delete(name);
  headers.set('session-id', crypto.randomUUID());
  try {
    options.signal.throwIfAborted();
    const pending = (options.fetch ?? globalThis.fetch)(CODEX_URL, {
      method: 'POST', body: JSON.stringify(payload), headers, signal: options.signal, redirect: 'error',
    });
    void pending.then(response => { if (options.signal.aborted) void response.body?.cancel().catch(() => {}); }, () => {});
    const response = await abortable(pending, options.signal);
    if (options.signal.aborted || !response.ok || !response.body) {
      void response.body?.cancel().catch(() => {});
      throw new PortableError(options.signal.aborted ? 'CANCELLED' : response.status === 401 || response.status === 403
        ? 'AUTH_REJECTED' : `HTTP_${response.status}`);
    }
    return await collectExtraction(response.body, blob, options.signal);
  } catch (error) {
    if (error instanceof PortableError) throw error;
    throw new PortableError(options.signal.aborted ? 'CANCELLED' : 'TRANSPORT_FAILED');
  }
}

function targetCount(blob: Json, receipts: Receipt[]): number | undefined {
  if (count(blob.output_tokens)) return blob.output_tokens;
  const frequencies = new Map<number, number>();
  for (const r of receipts) if (count(r.blobTokens)) frequencies.set(r.blobTokens, (frequencies.get(r.blobTokens) ?? 0) + 1);
  return [...frequencies].sort((a, b) => b[1] - a[1])[0]?.[0];
}
export const withinTolerance = (tokens: number, target: number) => target > 0 && Math.abs(tokens - target) <= target * 0.02;

/** Same four high/max waves and closest-count policy as kb_decrypt.py, bounded as one operation. */
export async function extractPortable(blob: Json, options: {
  send: (blob: Json, attempt: Attempt, signal: AbortSignal) => Promise<Extraction>;
  available: (model: string) => boolean;
  signal?: AbortSignal; timeoutMs?: number;
}): Promise<PortableResult> {
  validateBlob(blob);
  const timeoutMs = options.timeoutMs ?? 900_000;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 3_600_000) throw new PortableError('INVALID_TIMEOUT');
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const onAbort = () => controller.abort();
  options.signal?.addEventListener('abort', onAbort, { once: true });
  if (options.signal?.aborted) controller.abort();
  const signal = controller.signal;
  const receipts: Receipt[] = [];
  const candidates: Array<{ attempt: Attempt; result: Extraction }> = [];
  try {
    for (const [waveIndex, wave] of WAVES.entries()) {
      signal.throwIfAborted();
      const attempts = wave.map(([model, effort, repeat], n) => ({ model, effort, repeat, order: waveIndex * 2 + n }))
        .filter(a => options.available(a.model));
      if (!attempts.length) continue;
      const results = await abortable(Promise.all(attempts.map(async attempt => {
        try { return { attempt, result: await abortable(options.send(blob, attempt, signal), signal) }; }
        catch (error) {
          if (signal.aborted) throw new PortableError(options.signal?.aborted ? 'CANCELLED' : 'TIMEOUT');
          if (error instanceof PortableError && ['AUTH_UNAVAILABLE', 'AUTH_REJECTED'].includes(error.code)) throw error;
          return { attempt, result: undefined };
        }
      })), signal);
      for (const { attempt, result } of results) {
        if (!result) continue;
        receipts.push({ ...attempt, tokens: result.tokens, blobTokens: result.blobTokens, usage: numericUsage(result.usage), complete: result.complete });
        if (result.complete && result.text.trim() && size(result.text) <= MAX_TEXT_BYTES && count(result.tokens)) candidates.push({ attempt, result });
      }
      const target = targetCount(blob, receipts);
      if (target !== undefined && candidates.some(c => withinTolerance(c.result.tokens!, target))) break;
    }
    signal.throwIfAborted();
    const target = targetCount(blob, receipts);
    if (!count(target) || !candidates.length) throw new PortableError('NO_COMPLETE_COUNTED_HANDOFF');
    const chosen = candidates.sort((a, b) => Math.abs(a.result.tokens! - target) - Math.abs(b.result.tokens! - target) || a.attempt.order - b.attempt.order)[0];
    return { text: chosen.result.text, selected: chosen.attempt, tokens: chosen.result.tokens!, targetTokens: target,
      withinTolerance: withinTolerance(chosen.result.tokens!, target), receipts };
  } catch (error) {
    if (signal.aborted) throw new PortableError(options.signal?.aborted ? 'CANCELLED' : 'TIMEOUT');
    if (error instanceof PortableError) throw error;
    throw new PortableError('EXTRACTION_FAILED');
  } finally {
    clearTimeout(timer); options.signal?.removeEventListener('abort', onAbort); controller.abort();
  }
}

/** Keep only accounting numbers, never server text, opaque output or credentials. */
export function numericUsage(raw: Json): Json {
  const result: Json = {};
  for (const key of ['input_tokens', 'output_tokens', 'total_tokens']) if (count(raw[key])) result[key] = raw[key];
  for (const [key, field] of [['input_tokens_details', 'cached_tokens'], ['output_tokens_details', 'reasoning_tokens']]) {
    if (count(raw[key]?.[field])) result[key] = { [field]: raw[key][field] };
  }
  return result;
}

/** Native checkpoints also retain raw user inputs OUTSIDE the blob. Never drop them.
 * Text-only durable handoffs cannot safely carry image/audio inputs; refuse rather
 * than silently discarding media or rendering base64 as if it were natural language. */
export function portableHandoff(history: Json[], decoded: string): string {
  if (!decoded.trim() || size(decoded) > MAX_TEXT_BYTES) throw new PortableError('INVALID_HANDOFF');
  validateBlob(history.at(-1));
  const users = history.slice(0, -1).map(item => {
    if (item.role !== 'user' || !Array.isArray(item.content)
      || item.content.some((p: Json) => p?.type !== 'input_text' || typeof p.text !== 'string')) {
      throw new PortableError('NON_TEXT_RETAINED_INPUT');
    }
    return item.content.map((p: Json) => p.text).join('\n');
  });
  const result = users.length ? 'Retained user inputs from the prior conversation (JSON string array):\n'
    + JSON.stringify(users) + '\n\nLuna handoff from the compacted context:\n' + decoded : decoded;
  if (size(result) > MAX_TEXT_BYTES) throw new PortableError('HANDOFF_TOO_LARGE');
  return result;
}

/** OAuth account metadata only. Tokens never escape this helper. */
export function accountIdFromAuth(auth: { apiKey?: string; headers?: Record<string, unknown> }): string | undefined {
  const header = Object.entries(auth.headers ?? {}).find(([key]) => key.toLowerCase() === 'chatgpt-account-id')?.[1];
  if (typeof header === 'string' && header) return header;
  try {
    const value = JSON.parse(Buffer.from(auth.apiKey?.split('.')[1] ?? '', 'base64url').toString('utf8'));
    const id = value['https://api.openai.com/auth']?.chatgpt_account_id;
    return typeof id === 'string' && id ? id : undefined;
  } catch { return undefined; }
}