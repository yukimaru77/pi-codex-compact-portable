import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { zstdDecompressSync } from 'node:zlib';
import { getCurrentSystemPrompt } from '@earendil-works/pi-ai';
import { createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager } from '/opt/homebrew/lib/node_modules/@earendil-works/pi-coding-agent/dist/index.js';
import { createCheckpointDetails, fallbackSummary } from '../src/checkpoint.ts';

const root = new URL('../', import.meta.url).pathname;
const dir = await mkdtemp(join(tmpdir(), 'pi-portable-smoke-'));
const originalFetch = globalThis.fetch, originalDir = process.env.PI_CODING_AGENT_DIR;
let session;
try {
  const agentDir = join(dir, 'agent'); await mkdir(agentDir); process.env.PI_CODING_AGENT_DIR = agentDir;
  let foreignRequests = 0, extractionRequests = 0, compactionRequests = 0, succeed = false;
  const payloads = [];
  globalThis.fetch = async (url, init) => {
    if (String(url).startsWith('https://chatgpt.com/backend-api/codex/responses')) {
      const encoded = new Headers(init?.headers).get('content-encoding') === 'zstd';
      const body = JSON.parse(encoded ? zstdDecompressSync(init.body).toString() : String(init?.body));
      if (body.input.at(-1)?.type === 'compaction_trigger') {
        compactionRequests++;
        return new Response('data: ' + JSON.stringify({ type: 'response.completed', response: { status: 'completed', output: [
          { type: 'compaction', id: 'fresh', encrypted_content: 'fresh-synthetic-opaque', output_tokens: 100 },
        ], usage: { input_tokens: 100, output_tokens: 100 } } }) + '\n\n');
      }
      extractionRequests++;
      if (!succeed) return new Response('synthetic unauthorized', { status: 401 });
      return new Response('data: ' + JSON.stringify({ type: 'response.completed', response: { status: 'completed', output: [
        { type: 'message', id: 'text1', role: 'assistant', content: [{ type: 'output_text', text: 'Recovered synthetic handoff' }] },
      ], usage: { input_tokens: 100, output_tokens: 100, attribution: { items: { text1: { output_tokens: 100 } } } } } }) + '\n\n');
    }
    foreignRequests++;
    if (!succeed) throw new Error('Foreign request forbidden after extraction failure');
    payloads.push(JSON.parse(url instanceof Request ? await url.clone().text() : String(init?.body)));
    return new Response('data: ' + JSON.stringify({ type: 'response.completed', response: { id: 'response-fixture', status: 'completed', output: [],
      usage: { input_tokens: 10, output_tokens: 0, total_tokens: 10 } } }) + '\n\n', { headers: { 'content-type': 'text/event-stream' } });
  };
  const modelRuntime = await ModelRuntime.create({ authPath: join(agentDir, 'auth.json'), modelsPath: null,
    modelsStorePath: join(agentDir, 'models.json'), refreshOnCreate: false, allowModelNetwork: false });
  const fields = { input: ['text'], reasoning: false, contextWindow: 272000, maxTokens: 1000,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } };
  const key = 'x.' + Buffer.from(JSON.stringify({ 'https://api.openai.com/auth': { chatgpt_account_id: 'synthetic' } })).toString('base64url') + '.x';
  modelRuntime.registerProvider('openai-codex', { api: 'openai-codex-responses', apiKey: key,
    baseUrl: 'https://chatgpt.com/backend-api', models: [{ ...fields, id: 'gpt-6-luna', name: 'Luna fixture' }] });
  modelRuntime.registerProvider('portable-fixture', { api: 'openai-responses', apiKey: 'synthetic',
    baseUrl: 'https://foreign.invalid', models: [{ ...fields, id: 'foreign', name: 'Foreign fixture' }] });
  const manager = SessionManager.inMemory(dir);
  const msg = { role: 'user', content: [{ type: 'text', text: 'older requirement' }], timestamp: 1 };
  const keptId = manager.appendMessage(msg);
  const details = createCheckpointDetails({ modelId: 'gpt-6-luna', replacementHistory: [
    { type: 'compaction', encrypted_content: 'synthetic-opaque', output_tokens: 100 },
  ], keptMessages: [msg], willRetry: false });
  manager.appendCompaction(fallbackSummary(details.checkpointId), keptId, 1000, details, true);
  const settingsManager = SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false } });
  let promptVersion = 'Original synthetic system prompt';
  const resourceLoader = new DefaultResourceLoader({ cwd: dir, agentDir, settingsManager,
    systemPromptOverride: () => promptVersion,
    noExtensions: true, noSkills: true, noThemes: true, noPromptTemplates: true,
    additionalExtensionPaths: [join(root, 'src/index.ts')], agentsFilesOverride: () => ({ agentsFiles: [] }), appendSystemPromptOverride: () => [] });
  await resourceLoader.reload(); assert.deepEqual(resourceLoader.getExtensions().errors, []);
  ({ session } = await createAgentSession({ cwd: dir, agentDir, modelRuntime, model: modelRuntime.getModel('portable-fixture', 'foreign'),
    thinkingLevel: 'off', sessionManager: manager, settingsManager, resourceLoader }));
  const errors = []; await session.bindExtensions({ onError: e => errors.push(e) });
  await session.prompt('continue').catch(() => {});
  assert.ok(extractionRequests > 0, 'actual context hook attempted Luna with synthetic standard auth');
  assert.equal(foreignRequests, 0, 'ctx.abort really prevents foreign transport even though Pi catches hook exceptions');
  assert.ok(manager.getBranch().some(e => e.type === 'compaction' && e.details?.checkpointId === details.checkpointId));
  assert.ok(!manager.getBranch().some(e => e.type === 'custom' && e.customType === 'pi-codex-portable-extraction-v1'));
  assert.ok(JSON.stringify(errors).includes('CHECKPOINT_CONVERSION_STOPPED'), 'hook error is reported safely: ' + JSON.stringify(errors));
  succeed = true;
  await session.prompt('resume after decode failure');
  assert.equal(foreignRequests, 1);
  assert.ok(JSON.stringify(payloads).includes('Recovered synthetic handoff'));
  assert.ok(!JSON.stringify(payloads).includes('synthetic-opaque'));
  assert.ok(!JSON.stringify(payloads).includes('PI_CODEX_REMOTE_CHECKPOINT'));
  const callsAfterSuccess = extractionRequests;
  await session.prompt('one more turn');
  assert.equal(extractionRequests, callsAfterSuccess, 'durable handoff cache reused in real context dispatch');
  assert.equal(foreignRequests, 2);
  // Actual host reload changes its live prompt/loadout without persisting a new
  // turn. Manual compaction must still use the canonical previous transcript.
  manager.appendMessage({ role: 'user', content: 'Synthetic retained material. '.repeat(8000), timestamp: Date.now() });
  promptVersion = 'Changed synthetic system prompt after reload';
  await session.reload();
  assert.notEqual(getCurrentSystemPrompt(manager.buildSessionContext().messages), session.systemPrompt,
    'reproduce stale canonical prompt versus live reloaded prompt before manual compaction');
  // These isolated test providers are registered at runtime, not in auth files.
  modelRuntime.registerProvider('openai-codex', { api: 'openai-codex-responses', apiKey: key,
    baseUrl: 'https://chatgpt.com/backend-api', models: [{ ...fields, id: 'gpt-6-luna', name: 'Luna fixture' }] });
  const compacted = await session.compact();
  assert.match(compacted.summary, /Recovered synthetic handoff/);
  assert.equal(compactionRequests, 1, 'real manual compaction after reload ran V2');
  console.log('PI_PORTABLE_SDK_SMOKE_OK: real loader/auth, failure prevents send, subsequent successful handoff delivered and cached, checkpoint preserved');
} finally {
  if (session) { await session.extensionRunner.emit({ type: 'session_shutdown', reason: 'exit' }); session.dispose(); }
  globalThis.fetch = originalFetch;
  if (originalDir === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = originalDir;
  await rm(dir, { recursive: true, force: true });
}