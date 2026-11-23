# MCP catalog refresh and ambiguous write receipts

## Recover without another write

A client-side output-schema error does not roll back a write. PR134's first
production `save_memory` committed, then its receipt failed validation against a
catalog discovered before deployment. Retrying would create another memory.

1. Do not retry `save_memory` because its receipt failed validation or the
   connection dropped. There is no idempotency key on this tool.
2. Search using the saved claim's distinctive title, project and tags. Fetch
   candidate ids and compare the complete body and metadata. If the receipt's
   id is available, fetch that id directly. An absent search hit alone is not
   proof that nothing committed; check the console and call log when uncertain.
3. Keep the verified id. The server call log records its write as `ok`, even if
   the client rejects the delivered receipt. It cannot observe local validation.
4. Refresh discovery before using newly added tools. Do not save the same claim
   again as a substitute for a missing `edit_memory` tool.

## Receipt compatibility

`save_memory.structuredContent` has `id`, `title`, `text`, `metadata` (type,
tags, project, created_at), and `similar`. Its first text block mirrors that
receipt. When links exist an extra text block carries `links`; authoritative
`fetch` and `edit_memory` responses also carry links in their open metadata
object.

The original receipt forbids extra metadata properties. Even adding an
optional property to today's schema cannot make that cached validator accept
it. Since 2026-10-26 every output schema is advertised open (ADR-0003), so a
client that discovers it accepts added fields; one that cached the closed
receipt still does not. Preserve the receipt for the existing tool name. Future incompatible
receipts need an explicitly versioned tool or opt-in contract; neither a server
version bump nor an MCP protocol revision negotiates a tool's output schema.

PR134's intermediate schema required links. No JSON object satisfies that
schema and the original one. Clients that discovered that intermediate catalog
must refresh once after this correction; they must not retry a write if they
encounter the inverse validation error (missing links).

## Refresh by client

The installed `@modelcontextprotocol/client` 2.0.0 keeps the discovered catalog
and output validators. Its explicit refresh is:

```ts
await client.listTools(undefined, { cacheMode: "refresh" });
```

This refreshes discovery only. Never wrap `callTool(save_memory)` in an
automatic refresh-and-retry loop. The SDK does not retry an output-schema
validation failure. Its modern header-mismatch retry is a different,
pre-dispatch protocol mechanism, not a write-recovery policy.

[OpenCode V2](https://opencode.ai/v2/docs/mcp-servers) documents `/mcps` to
disconnect and connect a server. Use that to reconnect Valise, then confirm
`edit_memory` appears in the catalog. A new chat alone is not evidence of a new
connection: the shared service owns MCP. The published guide does not promise
automatic polling or deployment-triggered refresh.

Other documented host behavior, retrieved on 2026-10-21, not host-UI tested:

| Host | Documented behavior and recovery |
|---|---|
| [Claude Code](https://code.claude.com/docs/en/mcp#dynamic-tool-updates) | Refreshes on received `list_changed`; a failed refresh keeps the prior catalog. Its modern notification stream has reconnection limits. Use `/mcp` to reconnect. Discovery can also persist across sessions: Reconnect on a connected/failed server discards its discovery cache, but Reconnect on a `cached` server connects without discarding it. Disable then enable that server when a cached entry must be discarded. |
| [ChatGPT custom MCP](https://developers.openai.com/apps-sdk/deploy/connect-chatgpt/#refresh-metadata) | Open the connection in ChatGPT Plugins, select Refresh, confirm changed metadata, then start a new conversation. This is the custom-connection flow, not published-plugin continuous review. |
| [Cursor](https://cursor.com/docs/context/mcp) | Documents server enable/disable in Customize and restart for custom-server updates. It does not promise deployment-driven catalog refresh in that guide. Confirm the new tool after reconnecting. |
| [Gemini CLI](https://geminicli.com/docs/tools/mcp-server/) | Documents discovery on startup and persistent successful connections. Restart and inspect `/mcp`; the guide does not establish deployment-triggered refresh. |
| claude.ai | Refresh semantics were not established here. Use its connector controls and verify discovery; do not assume starting a chat refreshed the catalog. |

A client's ability to react to a notification is not evidence that Valise can
deliver one. There is no verified universal refresh command or guarantee that
beginning a chat refreshes these hosts.

## Tools missing because discovery was rate-limited

A session whose `initialize` or `tools/list` is refused has no Valise tools on
that connection, however current the catalog is. Both SDK eras fail the
connection on a 429 (`test/mcp/rate-limit.worker.test.ts`).

`rateLimit()` in `workers/mcp.ts` keys the 60-per-minute `MCP_LIMITER` on
`userId:mcp-method:mcp-name`. A client that sends neither header falls back to
`rpc:unclassified`, so every call it makes for one user shares a single
bucket: discovery, resource listing and tool calls alike.

The tools that disappeared from child sessions between 2026-10-21 and
2026-10-30 were this. Production `mcp_calls` shows:

- Every refused `initialize` (1,069) and `tools/list` (161) came from OpenCode
  2.1.0. No Claude Code discovery call was ever refused.
- OpenCode 2.1.x sent about 24 `resources/list` and `resources/templates/list`
  calls per connection: 23,544 against 966 `initialize` on 10-24. 2.2.x sends
  about one: 48 against 49 on 10-31.
- It sends no `mcp-method` header. Every refused discovery call with a
  recorded key used `rpc:unclassified`. Claude Code 2.1.312 sends the
  header, so its calls get per-method buckets.
- OpenCode subagents open their own connections. With several running, the
  shared bucket filled and the next child's discovery got a 429. Refusals
  peaked at 3,078 on 10-25 and have been zero since 10-31.

Recovery: update OpenCode to 2.2 or later, then reconnect with `/mcps`. To see
whether a missing catalog is this, look for refused discovery for that user:

```sql
SELECT date(at/1000,'unixepoch') d, method, limiter_method, limiter_name,
       COUNT(*) n
FROM mcp_calls
WHERE outcome = 'rate_limited' AND method IN ('initialize', 'tools/list')
GROUP BY d, method, limiter_method, limiter_name ORDER BY d;
```

Since 2026-11-02 a call without the header is bucketed by its own JSON-RPC
method, when that is a known MCP method (`LIMITER_METHODS` in
`workers/mcp.ts`), so polling `resources/list` can exhaust only
`resources/list`. An unknown method stays in `rpc`, and a sent header still
wins. todo:tdo_ff3610bb-9099-41b5-8302-53b400900900, ADR-0006.

## Why Valise does not push list-changed notifications

Valise builds a handler per request in `workers/mcp.ts`. The installed Agents
SDK accepts legacy POSTs, but returns 405 to legacy standalone GET/DELETE,
creates no persistent MCP session, and closes its transport after the response.
There is no legacy notification stream to signal after a deployment.

The modern handler supports `subscriptions/listen` and typed `notify` methods,
but routing belongs to one handler instance and one Worker isolate. A fresh
handler cannot notify an earlier handler's listeners; isolate-local routing
would still not invalidate every deployed client. Valise therefore advertises
`listChanged: false` for tools, resources and prompts. It sends no synthetic
notification or undocumented refresh header. Ordinary discovery, calls, and
their existing observation paths are unchanged.

Sources: [Agents handler API and lifecycle](https://developers.cloudflare.com/agents/model-context-protocol/apis/handler-api/),
[MCP tools and output validation](https://modelcontextprotocol.io/specification/2025-11-25/server/tools).
The local regression uses the public MCP SDK and Streamable HTTP transport,
historical discovery contracts, the real Worker handler and D1, not a manually
overridden client validator. It is not a live deployment or a host UI test.

## Regression evidence

```sh
npx vitest run --config vitest.mcp.config.ts test/mcp/cached-schema.worker.test.ts
```

Before the repair on `c0ce9da`, both original-cache cases rejected
`metadata.links`; both fresh-client cases passed. In each failing case D1 held
one memory, search/fetch returned its full saved claim, and its single save was
logged `ok`. No write was retried. After the repair, both protocol eras cover
original-cache success, fresh save/edit, link text plus authoritative reads,
and intermediate-cache recovery with explicit discovery refresh. Modern
preflight tool errors also need `resultType: complete`, because they bypass
the SDK's result shaping; those errors decode and retain their observed
`invalid_input` classification without executing a write.
