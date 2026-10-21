import { test } from 'node:test';
import assert from 'node:assert/strict';
import { zstdDecompressSync } from 'node:zlib';
import { SessionManager } from '@earendil-works/pi-coding-agent';
import { openaiCodexProvider } from '@earendil-works/pi-ai/providers/openai-codex';
import { createCodexCompactExtension } from '../src/codex-compact.ts';
import { DEFAULT_CODEX_COMPACT_SETTINGS } from '../src/settings.ts';
import { createCheckpointDetails, fallbackSummary, projectCheckpointContext, parseCheckpointDetails } from '../src/checkpoint.ts';
import { cachedText, projectPortable } from '../src/portable.ts';
// @ts-expect-error Existing local JS integration has no declarations.
import { attachCompactionAdapter } from '../../pi-kb/compaction-adapter.mjs';

const provider = openaiCodexProvider();
const model: any = { ...provider.getModels().find(m => m.id === 'gpt-6-luna')!,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } };
const foreign = { ...model, id: 'deepseek-test', provider: 'deepseek', api: 'openai-completions' };
const blob = { type: 'compaction', id: 'blob1', encrypted_content: 'opaque-synthetic', output_tokens: 100 };
const user = { role: 'user', content: [{ type: 'input_text', text: 'retained requirement' }] };
const token = 'x.' + Buffer.from(JSON.stringify({ 'https://api.openai.com/auth': { chatgpt_account_id: 'fake-account' } })).toString('base64url') + '.x';
const usage = { input_tokens: 100, output_tokens: 100, total_tokens: 200,
  attribution: { items: { blob1: { input_tokens: 100 }, m1: { output_tokens: 100 } } } };
function response(compact: boolean) {
  const output = compact ? [blob] : [{ type: 'message', role: 'assistant', id: 'm1', content: [{ type: 'output_text', text: 'decoded context' }] }];
  return new Response('data: ' + JSON.stringify({ type: 'response.completed', response: { status: 'completed', output, usage } }) + '\n\n', { headers: { 'content-type': 'text/event-stream' } });
}
function fixture(options: { native?: boolean; failure?: boolean; extractionFailure?: boolean; during?: () => void; recordedTools?: any[]; liveTools?: any[]; livePrompt?: string } = {}) {
  const manager = SessionManager.inMemory();
  manager.appendMessage({ role: 'system', content: 'Pi origin system prompt', toolsAdded: options.recordedTools ?? [], timestamp: 1 });
  const keptId = manager.appendMessage({ role: 'user', content: 'retained requirement', timestamp: 2 });
  const hooks = new Map<string, any>(); const notices: string[] = []; const calls: any[] = []; const providerErrors: string[] = [];
  let auths = 0, aborted = false;
  const pi: any = { on: (name: string, fn: any) => hooks.set(name, fn), registerCommand() {},
    getActiveTools: () => (options.liveTools ?? []).map(t => t.name), getAllTools: () => options.liveTools ?? [],
    appendEntry: (kind: string, data: any) => manager.appendCustomEntry(kind, data) };
  const state: any = { kind: 'loaded', path: '/tmp/synthetic-settings', settings: { ...DEFAULT_CODEX_COMPACT_SETTINGS, maxRetries: 0 }, document: {} };
  const ctx: any = { model: options.native ? model : foreign, hasUI: true, sessionManager: manager,
    getSystemPrompt: () => options.livePrompt ?? 'Pi origin system prompt', abort: () => { aborted = true; },
    ui: { setStatus() {}, notify: (message: string) => notices.push(message) },
    modelRegistry: { find: (_p: string, id: string) => id === model.id ? model : undefined,
      getApiKeyAndHeaders: async () => { auths++; return { ok: true, apiKey: token }; }, getProvider: () => ({ ...provider,
        stream: (...args: Parameters<typeof provider.stream>) => ({ async *[Symbol.asyncIterator]() {
          for await (const event of provider.stream(...args)) { if (event.type === 'error') providerErrors.push(event.error.errorMessage ?? 'unknown'); yield event; }
        } }),
      }) },
  };
  createCodexCompactExtension({ settingsRuntime: { get: () => state, reload: async () => state, update: async () => state, flush: async () => {} },
    fetch: async (_url, init) => {
      const encoded = new Headers(init?.headers).get('content-encoding') === 'zstd';
      const body = JSON.parse(encoded ? zstdDecompressSync(init!.body as Uint8Array).toString() : String(init?.body));
      calls.push(body); options.during?.();
      if (options.failure || (options.extractionFailure && body.input.at(-1)?.type !== 'compaction_trigger')) return new Response('private-secret', { status: 401 });
      return response(body.input.at(-1)?.type === 'compaction_trigger');
    } })(pi);
  const compact = () => hooks.get('session_before_compact')({ type: 'session_before_compact',
    branchEntries: manager.getBranch(), signal: new AbortController().signal, willRetry: false, reason: 'manual',
    preparation: { firstKeptEntryId: keptId, messagesToSummarize: [], turnPrefixMessages: [], isSplitTurn: false,
      tokensBefore: 1000, fileOps: { read: new Set(), written: new Set(), edited: new Set() }, settings: {} } }, ctx);
  const checkpoint = () => {
    const details = createCheckpointDetails({ modelId: model.id, replacementHistory: [user, blob],
      keptMessages: [manager.buildSessionContext().messages.find(m => m.role === 'user')!], willRetry: false });
    manager.appendCompaction(fallbackSummary(details.checkpointId), keptId, 1000, details, true);
    return details;
  };
  const context = () => hooks.get('context')({ type: 'context', messages: manager.buildSessionContext().messages }, ctx);
  return { manager, ctx, hooks, calls, compact, context, checkpoint, notices, providerErrors, auths: () => auths, aborted: () => aborted };
}
test('foreign model → real Codex serializer + KB-only extraction; one frozen auth lease', async () => {
  const f = fixture(); const result = await f.compact();
  assert.ok(result?.compaction, JSON.stringify({ result, notices: f.notices, calls: f.calls, errors: f.providerErrors }));
  assert.equal(f.calls.length, 3); assert.equal(f.auths(), 1);
  assert.equal(f.calls[0].instructions, 'Pi origin system prompt');
  assert.equal(f.calls[0].model, model.id); assert.deepEqual(f.calls[0].input.at(-1), { type: 'compaction_trigger' });
  for (const body of f.calls.slice(1)) { assert.equal(body.instructions, 'Follow the user instructions.'); assert.deepEqual(body.tools, []); assert.equal(body.input.length, 2); }
  assert.match(result.compaction.summary, /retained requirement/); assert.match(result.compaction.summary, /decoded context/);
  assert.ok(!JSON.stringify(result).includes(token));
  assert.equal(result.compaction.usage.totalTokens, 600);
  const c = result.compaction; f.manager.appendCompaction(c.summary, c.firstKeptEntryId, c.tokensBefore, c.details, true, c.usage);
  const projected = await f.context(); assert.ok(projected.messages);
  const text = JSON.stringify(projected.messages); assert.match(text, /decoded context/); assert.ok(!text.includes('opaque-synthetic'));
  assert.equal(f.calls.length, 3, 'saved handoff reused');
});
test('native checkpoint → foreign model lazily converts and durably caches; reload reuses cache', async () => {
  const f = fixture(); const details = f.checkpoint();
  const original = JSON.stringify(f.manager.getBranch());
  const projected = await f.context();
  assert.match(JSON.stringify(projected), /decoded context/); assert.match(JSON.stringify(projected), /retained requirement/);
  assert.equal(f.calls.length, 2); assert.equal(f.auths(), 1);
  assert.ok(cachedText(details, f.manager.getBranch()));
  assert.ok(JSON.stringify(f.manager.getBranch()).includes('opaque-synthetic'), 'original opaque checkpoint not destroyed');
  assert.ok(f.manager.getBranch().length > JSON.parse(original).length, 'metadata cache only');
  await f.hooks.get('session_start')({ reason: 'reload' }, f.ctx);
  await f.context(); assert.equal(f.calls.length, 2);
});
test('decode failure aborts foreign request; no cache/history replacement', async () => {
  const f = fixture({ failure: true }); f.checkpoint(); const before = structuredClone(f.manager.getBranch());
  await assert.rejects(f.context(), /CHECKPOINT_CONVERSION_STOPPED/);
  assert.equal(f.aborted(), true); assert.deepEqual(f.manager.getBranch(), before);
  assert.ok(!JSON.stringify(f.notices).includes('private-secret'));
});
test('foreign compaction failure cancels rather than passing opaque/missing text to generic summarizer', async () => {
  const f = fixture({ failure: true }); const before = structuredClone(f.manager.getBranch());
  assert.deepEqual(await f.compact(), { cancel: true }); assert.deepEqual(f.manager.getBranch(), before);
});
test('session mutation while extracting cannot publish cache or replacement', async () => {
  let f: ReturnType<typeof fixture>; let changed = false;
  f = fixture({ during: () => { if (!changed) { changed = true; f.manager.appendCustomEntry('concurrent-change', {}); } } });
  f.checkpoint(); await assert.rejects(f.context(), /CHECKPOINT_CONVERSION_STOPPED/);
  assert.equal(f.aborted(), true); assert.equal(f.manager.getBranch().filter(e => e.type === 'custom' && e.customType === 'pi-codex-portable-extraction-v1').length, 0);
});
test('legacy checkpoint converts even on same native model; switching back reuses plaintext', async () => {
  const f = fixture({ native: true }); f.checkpoint();
  assert.match(JSON.stringify(await f.context()), /decoded context/); assert.equal(f.calls.length, 2);
  f.ctx.model = foreign;
  assert.match(JSON.stringify(await f.context()), /decoded context/); assert.equal(f.calls.length, 2);
  f.ctx.model = { ...model, id: 'gpt-other' };
  assert.match(JSON.stringify(await f.context()), /decoded context/); assert.equal(f.calls.length, 2);
});
test('native compaction observes canonical tools and always completes Luna extraction', async () => {
  const f = fixture({ native: true });
  await f.context(); await f.hooks.get('before_provider_request')({ payload: { input: [], tools: [] } }, f.ctx);
  const result = await f.compact(); assert.ok(result?.compaction, JSON.stringify(f.notices));
  assert.match(result.compaction.details.portableText, /decoded context/); assert.equal(f.calls.length, 3);
  const c = result.compaction; f.manager.appendCompaction(c.summary, c.firstKeptEntryId, c.tokensBefore, c.details, true, c.usage);
  assert.match(JSON.stringify(await f.context()), /decoded context/);
  await f.hooks.get('before_provider_request')({ payload: { input: [], tools: [] } }, f.ctx);
  const again = await f.compact(); assert.ok(again?.compaction, JSON.stringify(f.notices));
  assert.ok(!JSON.stringify(f.calls[3]).includes('opaque-synthetic'), 'recompaction input uses text, not old blob');
});
test('native compaction failure cancels without ordinary summary fallback', async () => {
  const f = fixture({ native: true, failure: true });
  await f.context(); await f.hooks.get('before_provider_request')({ payload: { input: [], tools: [] } }, f.ctx);
  assert.deepEqual(await f.compact(), { cancel: true });
});
test('successful native V2 followed by failed Luna does not commit partial compaction', async () => {
  const f = fixture({ native: true, extractionFailure: true });
  await f.context(); await f.hooks.get('before_provider_request')({ payload: { input: [], tools: [] } }, f.ctx);
  const before = structuredClone(f.manager.getBranch());
  assert.deepEqual(await f.compact(), { cancel: true });
  assert.equal(f.calls.length, 3);
  assert.deepEqual(f.manager.getBranch(), before);
});
for (const native of [false, true]) test(`reload before manual compact uses recorded prepared prompt/tools, native=${native}`, async () => {
  const tool = { name: 'fixture_tool', description: 'Registry description after reload', parameters: { type: 'object', properties: {} } };
  const recorded = { ...tool, description: 'Actual prepared loadout description' };
  const f = fixture({ native, recordedTools: [recorded], liveTools: [tool], livePrompt: 'Reloaded base prompt' });
  const result = await f.compact();
  assert.ok(result?.compaction, JSON.stringify(f.notices));
  assert.equal(f.calls[0].instructions, 'Pi origin system prompt');
  assert.equal(f.calls[0].tools[0].description, recorded.description);
  assert.match(result.compaction.summary, /decoded context/);
});
test('live prompt changes during compaction still cancel without replacing history', async () => {
  let f: ReturnType<typeof fixture>;
  f = fixture({ native: true, during: () => { f.ctx.getSystemPrompt = () => 'concurrent prompt mutation'; } });
  const before = structuredClone(f.manager.getBranch());
  assert.deepEqual(await f.compact(), { cancel: true });
  assert.deepEqual(f.manager.getBranch(), before);
  assert.equal(f.calls.length, 1, 'no Luna call after ownership changes');
});
test('Pi KB existing provider.stream wrapper expands anchors BEFORE remote compaction; extraction does not reinsert KB', async () => {
  const f = fixture();
  const anchor = '[synthetic KB anchor]';
  f.manager.appendCustomMessageEntry('pi-kb-insertion-v2', anchor, false, { snapshot: { version: 1, name: 'fixture', items: [
    { type: 'compaction', encrypted_content: 'fixture-kb-opaque' },
  ] } });
  const runtime = { getProvider: f.ctx.modelRegistry.getProvider };
  const detach = attachCompactionAdapter(runtime, () => f.manager.getBranch());
  f.ctx.modelRegistry.getProvider = (...args: any[]) => runtime.getProvider(...args);
  try {
    const result = await f.compact(); assert.ok(result?.compaction, JSON.stringify(f.notices));
    assert.ok(JSON.stringify(f.calls[0]).includes('fixture-kb-opaque'));
    assert.ok(!JSON.stringify(f.calls[0]).includes(anchor));
    assert.ok(!JSON.stringify(f.calls.slice(1)).includes('fixture-kb-opaque'));
  } finally { detach(); }
});
test('portable projection refuses broken anchors and corrupted persisted text', () => {
  const f = fixture(); const d = f.checkpoint();
  assert.throws(() => projectPortable([], d, 'x'), /ANCHOR/);
  assert.equal(parseCheckpointDetails({ ...d, portableText: '' }), undefined);
  assert.equal(projectCheckpointContext([], d, 'full'), undefined);
});