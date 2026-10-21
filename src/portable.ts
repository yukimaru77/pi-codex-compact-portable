import { createHash } from 'node:crypto';
import { platform, release, arch } from 'node:os';
import type { AgentMessage } from '@earendil-works/pi-agent-core';
import type { ExtensionContext, SessionEntry } from '@earendil-works/pi-coding-agent';
import type { Model, Usage } from '@earendil-works/pi-ai';
import {
  extractPortable, sendExtraction, accountIdFromAuth, MAX_TEXT_BYTES, PortableError, abortable,
  type Json, type PortableResult,
} from '../../codex-portable-compact/src/index.ts';
import { checkpointMarkerVariants, type CodexCheckpointDetails } from './checkpoint.js';

export const PORTABLE_CACHE = 'pi-codex-portable-extraction-v1';
// Same host UA as pi-ai; avoid its deep import because Pi's Jiti alias maps
// @earendil-works/pi-ai to a compat entrypoint, not a subpath package root.
const getPiUserAgent = () => `pi (${platform()} ${release()}; ${arch()})`;
export function portableModel(ctx: ExtensionContext, preferred = 'gpt-6-luna'): Model<'openai-codex-responses'> {
  const model = ctx.modelRegistry.find('openai-codex', preferred);
  if (!model || model.api !== 'openai-codex-responses') throw new PortableError('CODEX_MODEL_UNAVAILABLE');
  return model as Model<'openai-codex-responses'>;
}
export const checkpointKey = (details: CodexCheckpointDetails) => createHash('sha256')
  .update(JSON.stringify([details.checkpointId, details.modelId, details.replacementHistory])).digest('hex');
export function validPortableText(value: unknown): value is string {
  return typeof value === 'string' && !!value.trim() && Buffer.byteLength(value) <= MAX_TEXT_BYTES;
}
export function cachedText(details: CodexCheckpointDetails, branch: readonly SessionEntry[]): string | undefined {
  if (validPortableText(details.portableText)) return details.portableText;
  const key = checkpointKey(details);
  for (let i = branch.length - 1; i >= 0; i--) {
    const entry = branch[i];
    if (entry.type !== 'custom' || entry.customType !== PORTABLE_CACHE) continue;
    const data = entry.data as { key?: unknown; text?: unknown } | undefined;
    if (data?.key === key && validPortableText(data.text)) return data.text;
  }
  return undefined;
}
export function projectPortable(messages: AgentMessage[], details: CodexCheckpointDetails, text: string): AgentMessage[] {
  if (!validPortableText(text)) throw new PortableError('INVALID_SAVED_HANDOFF');
  const markers = new Set(checkpointMarkerVariants(details.checkpointId));
  let found = 0;
  const result = messages.map(message => {
    if (message.role !== 'user' || !Array.isArray(message.content) || message.content.length !== 1) return message;
    const part = message.content[0];
    if (part.type !== 'text' || !markers.has(part.text)) return message;
    found++;
    return { ...message, content: [{ type: 'text' as const, text }] };
  });
  if (found !== 1) throw new PortableError('CHECKPOINT_ANCHOR_MISMATCH');
  return result;
}
type AuthResult = Awaited<ReturnType<ExtensionContext['modelRegistry']['getApiKeyAndHeaders']>>;
export async function extractForPi(ctx: ExtensionContext, blob: Json, signal: AbortSignal,
  auth?: AuthResult, fetch?: typeof globalThis.fetch): Promise<PortableResult> {
  signal = AbortSignal.any([signal, AbortSignal.timeout(900_000)]);
  signal.throwIfAborted();
  const resolved = auth ?? await abortable(ctx.modelRegistry.getApiKeyAndHeaders(portableModel(ctx)), signal);
  signal.throwIfAborted();
  if (!resolved.ok || !resolved.apiKey) throw new PortableError('AUTH_UNAVAILABLE');
  const accountId = accountIdFromAuth(resolved);
  if (!accountId) throw new PortableError('AUTH_UNAVAILABLE');
  const headers = Object.fromEntries(Object.entries(resolved.headers ?? {}).filter((v): v is [string, string] => typeof v[1] === 'string'));
  // One immutable auth resolution owns the complete high/max extraction operation.
  return extractPortable(blob, {
    signal, available: id => ctx.modelRegistry.find('openai-codex', id)?.api === 'openai-codex-responses',
    send: (item, attempt, abort) => sendExtraction(item, attempt, {
      auth: { apiKey: resolved.apiKey!, accountId, headers }, signal: abort, fetch, userAgent: getPiUserAgent(),
    }),
  });
}
export function addExtractionUsage(base: Usage, result: PortableResult, ctx: ExtensionContext): Usage {
  const usage = structuredClone(base);
  for (const receipt of result.receipts) {
    const u = receipt.usage;
    const n = (v: unknown) => typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : 0;
    const cached = n(u.input_tokens_details?.cached_tokens);
    const input = Math.max(0, n(u.input_tokens) - cached), output = n(u.output_tokens);
    const cost = ctx.modelRegistry.find('openai-codex', receipt.model)?.cost;
    usage.input += input; usage.output += output; usage.cacheRead += cached;
    usage.totalTokens += n(u.input_tokens) + output;
    if (cost) {
      usage.cost.input += input * cost.input / 1e6;
      usage.cost.output += output * cost.output / 1e6;
      usage.cost.cacheRead += cached * cost.cacheRead / 1e6;
    }
  }
  usage.cost.total = usage.cost.input + usage.cost.output + usage.cost.cacheRead + usage.cost.cacheWrite;
  return usage;
}