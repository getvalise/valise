# Local proxy spike: can a pass-through proxy feed transcripts and traces to Valise?

Date: 2026-11-05
Status: spike, measured. Decisions it informs are listed at the end and are not taken here.
To-do: `todo:tdo_4628311f-b05f-48e9-9f79-22295e5a050c`.

## Question

The v1 spec defers transcripts to v1.5 as local JSONL plus hooks, a `claude --teleport` sweep for cloud sessions and export ZIPs for consumer apps. The owner wants the conversations from Claude Code, Codex and OpenCode on every machine in Valise, so Valise can work out what should improve, with full traces optional. Since PR #317 the plugin's hooks hold no credential: `mcp_tool` hooks pass templated hook fields over Claude Code's own MCP sign-in and cannot read `transcript_path`. The candidate replacing a per-machine file reader is a local pass-through proxy that Claude Code reaches through `ANTHROPIC_BASE_URL`, forwards unchanged, and copies each turn to Valise on the side.

This spike measures what that proxy costs and what it sees. It does not write to Valise.

## Setup

`scripts/local-proxy-spike.mjs`: a dependency-free Node proxy on `127.0.0.1:8317` that forwards every request to `https://api.anthropic.com` with headers and body unchanged, streams the response back as it arrives, and logs one JSON line per request with timings, request shape and decoded response usage. It never logs `authorization`, `x-api-key` or `cookie`, and reduces `metadata.user_id` to its session id. `SPIKE_ABORT_NTH=2` destroys the upstream socket of the second `/v1/messages` request after its first bytes.

Client: Claude Code 2.1.318, claude.ai subscription login, the Valise plugin loaded, headless runs from this worktree:

```
ANTHROPIC_BASE_URL=http://127.0.0.1:8317 claude -p "Use the Valise MCP search tool to search for: local proxy spike transcripts. Then reply with the titles of the top two hits, nothing else." --session-id <uuid> --max-turns 6 --allowedTools mcp__plugin_valise_valise__search mcp__plugin_valise_valise ToolSearch
```

Baseline: the same command without the variable. Evidence for the baseline comes from the local transcript `~/.claude/projects/-Users-me--stash-tool-worktrees-valise-local-proxy-spike/<session>.jsonl`, whose `api-request` records carry `betas` and `cacheControl` and whose `assistant` records carry `usage`. Sessions: baseline `e30f7ff0-92a7-4820-bbf1-c73a917302dd`, proxied `1769c0b3-d2f1-44c8-9a0c-682dcd580668` and `f53614d0-d10c-45f3-bac5-a671c0c13eba`, abort test `ee1198e5-fc1a-4b81-b8e5-9021c6a76f1d`.

`--bare` cannot be used for any arm: it reports "Not logged in" with the subscription login, directly and through the proxy.

## Results

| Check | Result |
|---|---|
| Added latency | Proxy time before the upstream send: median 0.2 ms, max 0.4 ms. After the upstream's last byte: median 0.5 ms, max 1.3 ms. Over 19 forwarded `/v1/messages` requests, all 200. Upstream time to first byte was 648 to 2,657 ms, median 816 ms, so the proxy is three orders of magnitude below the model. Wall clock for a trivial haiku turn, six interleaved runs per arm: direct median 4.57 s, proxied 4.77 s, ranges overlapping. |
| Tool search | Survives. Proxied sessions used `ToolSearch` and then the Valise `search` tool. The first request carried 13 tools, one with `defer_loading`; after ToolSearch the next carried 18 tools, 6 deferred, and 5 `tool_reference` blocks. The `anthropic-beta` header reached upstream with `advanced-tool-use-2025-11-20` in it. No 400 or 422, so no fallback to loading every MCP tool upfront. |
| Prompt cache TTL | Kept at one hour. Every proxied request carried `cache_control` with `ttl: "1h"` and the `extended-cache-ttl-2025-04-11` beta; every decoded response reported `cache_creation.ephemeral_1h_input_tokens` > 0 and `ephemeral_5m_input_tokens: 0`. Total across decoded responses: 232,660 one-hour tokens, 0 five-minute. The reported drop to five minutes behind a custom base URL did not occur with the variable alone and the subscription login. |
| Session id | Present and exact. `metadata.user_id` is a JSON string `{"device_id":"<64 hex>","account_uuid":"<uuid>","session_id":"<uuid>"}`. The session id matched the `--session-id` passed and the local transcript's file name. The device id lets a server attribute a request to a machine without a hostname header. |
| Retries | Claude Code retries a request whose stream dies mid-body. The abort test cut the second request after its first bytes; the client printed `Decompression error: ZlibError`, re-sent a request of the same byte size (161,267) and message count with a different body hash, and the session completed. In the local transcript this shows as five `api-request` records for four `assistant` records. A trace writer cannot dedupe retries by whole-body hash; it keys on the message list. |
| Codex | Untested: Codex is not installed on this machine. The docs-level finding stands that a ChatGPT login talks to the ChatGPT backend, not `OPENAI_BASE_URL`. |
| Remote Control | Not observed; the docs state it is disabled while the base URL is not an Anthropic host. |

Other facts the wire shows:

- Request bodies ran 99,661 to 188,459 bytes for this short session, median 157 KB, because every turn carries the system prompt, the tool list and the whole history. Responses arrive `gzip` or `br` encoded; a trace writer decodes its own copy and forwards the bytes untouched.
- Every response carries `request-id`, `anthropic-organization-id`, `anthropic-workspace-id` and thirteen `anthropic-ratelimit-unified-*` headers (5-hour and 7-day utilisation, status, reset). The local transcript records `requestId` on `assistant` records but none of the rate-limit headers and no per-request timing.
- The local transcript already holds a delta-encoded trace: `api-request` records with `keep`/`tail` hashes, `api-request-blob` records with the message content by hash, `api-request-shape` with system and tools, `betas`, `cacheControl`, `usage` with the cache breakdown, `cwd` and `gitBranch` on every record, `tools-used`, and compaction boundaries. For Claude Code the proxy adds wire timing, rate-limit headers and the device id, not conversation content.

## What this settles

1. A local pass-through proxy costs under 2 ms per request and changes nothing Claude Code sends or receives: tool search, the one-hour cache and the OAuth beta all pass through. The objections to a proxy were about a remote gateway and about CLIProxyAPI's rewriting, not about proxying as such.
2. Session and device attribution come from the request itself, so a proxy needs no access to the local transcript files and no hostname convention.
3. The proxy is a complete trace source for any client that speaks the Anthropic Messages API through `ANTHROPIC_BASE_URL`. It is not a better conversation source than Claude Code's own transcript, which already contains the same requests delta-encoded. The proxy's unique value is traces for clients without a rich local store, live wire numbers, and one code path per API protocol instead of one parser per client.

## Decisions this leaves to the owner

- The per-machine Valise credential. Whichever writer runs on a machine, proxy or file reader, holds a token. The review that preceded this spike pointed at the iPhone capture URL as the precedent: a scoped bearer minted on Connections, labelled per device, posted to a plain HTTP door with its own limiter (`workers/capture.ts`, ADR-0015 amendment of 2026-11-02), rather than a full-vocabulary OAuth grant with a 30-day refresh token. This reverses the 2026-11-04 "one sign-in" decision for an opt-in writer and needs saying in the ADR.
- Transcripts as a new concept rather than a source kind. `save_source` dedupes on URL for bookmarks only and always creates otherwise; notes cap at 64 KiB and the projection body at 16 KiB; passage indexing would put every pasted error into `search_docs`. ADR-0001 anticipates transcripts as new tables plus one projection.
- Delta extraction keys on the message list (longest common prefix of per-message hashes, the `keep`/`tail` scheme Claude Code itself uses), starts a new segment when a compaction summary shares no prefix, and treats subagent requests as their own segments. Retries are deduped the same way, not by body hash.
- Privacy before bytes leave a machine: drop tool results and thinking at the source for the conversation tier, redact known secret shapes, and attribute by project with an allowlist so a new work clone never uploads by default. Raw traces per project, opt-in, under an R2 prefix that `scripts/recovery-policy.mjs` names.
- Codex and OpenCode: OpenCode takes a per-provider base URL; Codex with a ChatGPT login needs its own test on a machine that has it.
