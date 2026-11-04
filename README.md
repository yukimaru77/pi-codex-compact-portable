# pi-codex-compact-portable

Pi extension: Codex Remote Compaction V2 paired with KB-compatible plaintext extraction.
Based on `@signalridge/pi-codex-compact@1.3.3` (MIT; upstream source files and license
retained). Every enabled compaction runs Codex V2 and then extracts the result as plaintext
with Luna (as kb-repomap's `kb decrypt` does), on all models, so a compacted conversation
can continue on another model. Model switches reuse plaintext rather than reverting to
opaque replay.

This is **model-generated text extraction**, not cryptographic decryption or proof of
lossless recovery. **Compaction always uses the user's Codex (ChatGPT) login**: conversations
compacted while using another provider are sent to that Codex account. It uses Pi's standard
auth path, including the `pi-codex-multi` hook when installed; no new provider or credential store.

Self-contained: the extraction helper formerly in the sibling package `codex-portable-compact`
is merged into `src/portable-core.ts`. (That package is kept separately for DSH.)

## Install

```sh
pi install git:github.com/yukimaru77/pi-codex-compact-portable
```

Requires a Codex login in Pi (`/login`, OpenAI Codex). Use `/reload` after installing.
`/codex-compact` retains the upstream settings UI.

## Routing

| Receiving model | Compaction / replay |
| --- | --- |
| Same native Codex API and checkpoint model | Remote V2 followed immediately by Luna handoff text |
| Other provider/API | Remote V2 through `gpt-6-luna`, then Luna handoff text |
| Any existing native checkpoint, including same-model use | Extract before the next request; never send the opaque fallback marker as history |
| Different native Codex model | Text conversion first; checkpoint identity is not inferred from a GPT display name |

**Compaction is always the complete V2 → Luna pair when enabled.** A failure in
either stage cancels compaction without ordinary-summary fallback. Switching back
to GPT reuses the same plaintext; it never restores opaque replay. Pi retains the
blob in checkpoint metadata for recovery/compatibility, not as active model input.
Historical logs are not deleted. Explicitly disabling this extension/DSH's native
compaction setting still selects the harness's ordinary compactor.

Pi may reuse the previous native checkpoint's compactor model when re-compacting
a conversation with existing opaque state. It preserves the actual canonical
Pi system/tools/transcript and the `pi-kb` provider-stream adapter. DSH uses its
actual DSH→Pi/Codex serializer and selected compaction region, not a second agent loop.

Extraction has ONLY KB's `Follow the user instructions.` system instruction,
the supplied blob, KB's exact handoff prompt, and `tools: []`. It does not add the
original system prompt/tools, invoke KB/RR, run tools, or load KB credentials.
The original harness prompt/tools/history belong to the preceding compression request.

Pi resolves its existing `modelRegistry.getApiKeyAndHeaders` path (including the
standard-login pool). DSH uses its existing shared broker. One resolved auth lease
owns compression plus immediate extraction; no credential is copied into sessions.

## KB selection policy and limits

- Parallel high/max attempts, up to four waves / eight extraction calls:
  GPT-6 Luna twice, then GPT-5.6 Luna twice. Installed catalog availability is required.
- Prefer visible token count within ±2% of the blob's count; otherwise choose
  the closest completed counted candidate, as KB does. **Count agreement is
  not a guarantee of semantic fidelity.** Partial, empty, uncounted, refused,
  tool-call, malformed or oversized output is never a replacement.
- Raw retained user text lives outside native blobs and is preserved separately
  in the plaintext handoff. **Retained image/audio input currently stops portable
  conversion** rather than silently losing media or sending base64 as text.
- DSH conversions use the real compaction transaction and retain its requirement
  that the replacement be smaller. If decoded text is larger than the encoded
  checkpoint, the switch is stopped; original history remains recoverable.
- Codex's real input capacity is not enlarged to match a foreign model's capacity.
  An oversized remote request fails without truncating/replacing history.
- No assumption that a blob can move across accounts. A later pool selection
  might be rejected by Codex; this stops the request and preserves history.
- Extraction is bounded to 15 minutes, streams to 24 MiB, blob to 2 MiB and
  text to 8 MiB. Compression retains the existing timeout/retry policies.
- Pi stores a branch-scoped plaintext cache in session metadata for later model
  switches; DSH commits an ordinary source-tagged text checkpoint. Plaintext is
  therefore present in the local session log after extraction.
- Immediate extraction usage is counted with compression usage. Pi lazy-switch
  receipts are saved in cache metadata, not added to the normal assistant cost
  totals. DSH's single summary-model price attribution is approximate when a
  fallback Luna model was used. No credentials/response bodies are logged.

On extraction failure, Pi explicitly aborts the request (its hook runner otherwise
swallows hook exceptions). DSH keeps both its pre-request route guard and final
immutable LLM-input guard. Neither silently delegates an opaque checkpoint to an
ordinary text summarizer.

Extraction waves: GPT-6 Luna (high/max) twice, GPT-5.6 Luna twice, then GPT-6.1 Terra once,
matching kb-repomap's `kb_decrypt.WAVES`.

## Tests

```sh
npm install
node --import tsx --test test/portable-core.test.ts   # extraction core (12 tests)
npm test                                              # extension tests; need a Pi SDK host (PI_HOST_DIR)
```

`test/portable-core.test.ts` compares the prompt and waves with a local kb-repomap
(`KB_REPOMAP_DIR`, default `~/kb-repomap`) and skips that case when it is absent.
