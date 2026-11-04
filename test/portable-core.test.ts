import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { extractPortable, extractionPayload, collectExtraction, sendExtraction, abortable,
  KB_PROMPT, KB_INSTRUCTIONS, WAVES, CODEX_URL, accountIdFromAuth, portableHandoff } from '../src/portable-core.ts';

const blob = { type: 'compaction', id: 'blob1', encrypted_content: 'synthetic-opaque', output_tokens: 100 };
const attempt = { model: 'gpt-6-luna', effort: 'high' as const, repeat: 1, order: 0 };
const signal = () => new AbortController().signal;
function terminal(overrides: any = {}) {
  return { type: 'response.completed', response: { status: 'completed',
    output: [{ type: 'message', id: 'm1', role: 'assistant', content: [{ type: 'output_text', text: 'handoff 日本語' }] }],
    usage: { input_tokens: 102, output_tokens: 110, attribution: { items: { m1: { output_tokens: 100 }, blob1: { input_tokens: 100 } } } }, ...overrides } };
}
function stream(value: any, closed = true) {
  const encoded = new TextEncoder().encode('data: ' + JSON.stringify(value) + '\r\n\r\n');
  return new ReadableStream<Uint8Array>({ start(c) {
    // Split every byte, including multi-byte UTF8 sequences.
    for (const b of encoded) c.enqueue(Uint8Array.of(b));
    if (closed) c.close();
  } });
}
// Optional parity check against a local kb-repomap checkout (KB_REPOMAP_DIR, default ~/kb-repomap).
const kbDecrypt = join(process.env.KB_REPOMAP_DIR ?? join(homedir(), 'kb-repomap'), 'kb_decrypt.py');
test('KB prompt and wave schedule exactly match installed Python AST (no KB execution/import)', { skip: !existsSync(kbDecrypt) && 'kb-repomap not found' }, () => {
  const script = 'import ast,json,sys; m=ast.parse(sys.stdin.read()); print(json.dumps({n.targets[0].id:ast.literal_eval(n.value) for n in m.body if isinstance(n,ast.Assign) and isinstance(n.targets[0],ast.Name) and n.targets[0].id in ["PROMPT","WAVES"]}))';
  const kb = JSON.parse(execFileSync('python3', ['-c', script], { input: readFileSync(kbDecrypt), encoding: 'utf8' }));
  assert.equal(KB_PROMPT, kb.PROMPT); assert.deepEqual(WAVES, kb.WAVES);
  const body = extractionPayload(blob, attempt);
  assert.equal(body.instructions, KB_INSTRUCTIONS);
  assert.deepEqual(body.input, [blob, { type: 'message', role: 'user', content: [{ type: 'input_text', text: kb.PROMPT }] }]);
  assert.deepEqual(body.tools, []); assert.equal(body.parallel_tool_calls, false); assert.equal(body.store, false);
  assert.ok(!('prompt_cache_key' in body)); assert.equal(body.service_tier, 'default');
});
test('SSE uses completed output + attribution; terminal need not wait for EOF', async () => {
  const result = await collectExtraction(stream(terminal(), false), blob, signal());
  assert.equal(result.text, 'handoff 日本語'); assert.equal(result.tokens, 100); assert.equal(result.blobTokens, 100);
});
test('partial output, tools, refusals, missing terminal and malformed data fail closed', async () => {
  const incomplete = { ...terminal(), type: 'response.incomplete' };
  assert.equal((await collectExtraction(stream(incomplete), blob, signal())).text, '');
  for (const data of [terminal({ output: [{ type: 'function_call' }] }), terminal({ output: [] }),
    terminal({ output: [{ type: 'message', role: 'assistant', content: [{ type: 'refusal', refusal: 'No' }] }] }),
    { type: 'response.output_text.delta', delta: 'partial' }]) {
    await assert.rejects(collectExtraction(stream(data), blob, signal()));
  }
  await assert.rejects(collectExtraction(new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode('data: {\n\n')); c.close(); } }), blob, signal()), /MALFORMED_SSE/);
});
test('header/auth boundaries: exact destination, redirect refusal, fresh session, no inherited context', async () => {
  let body: any, headers!: Headers;
  const result = await sendExtraction(blob, attempt, { auth: { apiKey: 'fake-token', accountId: 'fake-account', headers: { authorization: 'wrong', 'session-id': 'old', 'x-codex-turn-metadata': 'secret-context' } },
    signal: signal(), userAgent: 'test-agent', attribution: { 'x-dsh': 'fixture' }, fetch: async (url, init) => {
      assert.equal(url, CODEX_URL); assert.equal(init?.redirect, 'error'); headers = new Headers(init?.headers); body = JSON.parse(String(init?.body));
      return new Response(stream(terminal()));
    } });
  assert.equal(headers.get('authorization'), 'Bearer fake-token'); assert.equal(headers.get('chatgpt-account-id'), 'fake-account');
  assert.notEqual(headers.get('session-id'), 'old'); assert.equal(headers.get('x-codex-turn-metadata'), null);
  assert.equal(headers.get('x-dsh'), 'fixture'); assert.ok(!JSON.stringify(body).includes('fake-token'));
  assert.equal(result.tokens, 100);
});
test('auth error never exposes response body or tokens', async () => {
  await assert.rejects(sendExtraction(blob, attempt, { auth: { apiKey: 'secret', accountId: 'private' }, signal: signal(), userAgent: 'test',
    fetch: async () => new Response('secret private server', { status: 401 }) }), e => String(e).includes('AUTH_REJECTED') && !String(e).includes('secret'));
});
test('waves run high/max concurrently, early-stop ±2%, sanitize accounting receipts', async () => {
  const calls: number[] = [];
  const result = await extractPortable(blob, { available: () => true, send: async (_b, a) => {
    calls.push(a.order); await Promise.resolve(); assert.equal(calls.length % 2, 0);
    return { text: 'text' + a.order, tokens: a.order === 0 ? 102 : 99, usage: { input_tokens: 100, output_tokens: 100, unknown: 'private' }, complete: true };
  } });
  assert.deepEqual(calls, [0, 1]); assert.equal(result.selected.order, 1); assert.equal(result.withinTolerance, true);
  assert.ok(!JSON.stringify(result.receipts).includes('private'));
});
test('all five waves (luna x4, then terra) choose closest counted complete result; incomplete/uncounted never selected', async () => {
  const calls: number[] = [];
  const result = await extractPortable({ ...blob, output_tokens: undefined }, { available: () => true, send: async (_b, a) => {
    calls.push(a.order); return { text: 'chosen' + a.order, tokens: a.order === 0 ? undefined : a.order === 1 ? 100 : 120 - a.order,
      blobTokens: 100, usage: {}, complete: a.order !== 1 };
  } });
  assert.deepEqual(calls, [0,1,2,3,4,5,6,7,8,9]); assert.equal(result.selected.order, 9); assert.equal(result.selected.model, 'gpt-6.1-terra');
  assert.equal(result.withinTolerance, false);
});
test('unavailable Luna / missing counts refuse output; no guessed token counts', async () => {
  await assert.rejects(extractPortable(blob, { available: () => false, send: async () => { throw new Error('unused'); } }), /NO_COMPLETE/);
  await assert.rejects(extractPortable(blob, { available: () => true, send: async () => ({ text: 'uncounted', usage: {}, complete: true }) }), /NO_COMPLETE/);
});
test('cancellation and deadlines bound signal-ignoring sends; pre-aborted rejection observed', async () => {
  const abort = new AbortController(); abort.abort();
  await assert.rejects(abortable(Promise.reject(new Error('late')), abort.signal), /CANCELLED/);
  await assert.rejects(extractPortable(blob, { available: () => true, timeoutMs: 5, send: async () => new Promise(() => {}) }), /TIMEOUT/);
  let sent = 0;
  await assert.rejects(sendExtraction(blob, attempt, { auth: { apiKey: 'f', accountId: 'f' }, signal: abort.signal, userAgent: 'test', fetch: async () => { sent++; throw new Error(); } }), /CANCELLED/);
  assert.equal(sent, 0);
});
test('stalled SSE cancellation closes reader', async () => {
  let cancelled = false;
  const controller = new AbortController();
  const p = collectExtraction(new ReadableStream({ cancel() { cancelled = true; } }), blob, controller.signal);
  controller.abort(); await assert.rejects(p, /CANCELLED/); assert.equal(cancelled, true);
});
test('raw retained user inputs are preserved outside decoded blob; media fails explicitly', () => {
  const history = [{ role: 'user', content: [{ type: 'input_text', text: 'retain exactly\n日本語' }] }, blob];
  assert.ok(portableHandoff(history, 'decoded').includes(JSON.stringify(['retain exactly\n日本語'])));
  assert.throws(() => portableHandoff([{ role: 'user', content: [{ type: 'input_image', image_url: 'secret-image' }] }, blob], 'decoded'), /NON_TEXT_RETAINED_INPUT/);
});
test('account metadata uses standard header or OAuth claim, never another credential store', () => {
  assert.equal(accountIdFromAuth({ headers: { 'ChatGPT-Account-Id': 'a' } }), 'a');
  assert.equal(accountIdFromAuth({ apiKey: 'x.' + Buffer.from(JSON.stringify({ 'https://api.openai.com/auth': { chatgpt_account_id: 'b' } })).toString('base64url') + '.x' }), 'b');
  assert.equal(accountIdFromAuth({ apiKey: 'invalid' }), undefined);
});