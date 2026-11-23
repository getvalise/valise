#!/usr/bin/env node
/**
 * Spike: a dependency-free pass-through proxy for the Anthropic API, so a
 * Claude Code session pointed at it with ANTHROPIC_BASE_URL can be measured.
 *
 *   node scripts/local-proxy-spike.mjs --port 8317 --log /path/to/requests.jsonl
 *
 * Every request is forwarded to https://api.anthropic.com with its headers
 * and body unchanged. The response streams back as it arrives; a copy is
 * parsed once it ends. One JSON line per request records timings, request
 * shape and response usage. Credentials are never written: `authorization`,
 * `x-api-key` and `cookie` are forwarded and dropped from the log, and the
 * `metadata.user_id` field is reduced to its `session_` suffix.
 *
 * SPIKE_ABORT_NTH=<n> destroys the upstream socket of the n-th /v1/messages
 * request after its first bytes, to see how the client retries.
 */
import { createHash } from "node:crypto";
import { appendFileSync } from "node:fs";
import http from "node:http";
import https from "node:https";
import { hostname } from "node:os";
import zlib from "node:zlib";

const args = process.argv.slice(2);
const flag = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};
const PORT = Number(flag("port", "8317"));
const LOG = flag("log", "./proxy-requests.jsonl");
const UPSTREAM = new URL(flag("upstream", "https://api.anthropic.com"));
const ABORT_NTH = Number(process.env.SPIKE_ABORT_NTH || 0);
const MAX_CAPTURE = 16 * 1024 * 1024;
const REDACT = new Set(["authorization", "x-api-key", "cookie", "set-cookie"]);

let messagesSeen = 0;
let seq = 0;

const agent = new https.Agent({ keepAlive: true });

function log(record) {
  appendFileSync(LOG, `${JSON.stringify(record)}\n`);
}

function sha(buffer) {
  return createHash("sha256").update(buffer).digest("hex");
}

/** Claude Code 2.1.318 sends metadata.user_id as a JSON string with device_id, account_uuid and session_id. Only the session id is logged. */
function sessionSuffix(userId) {
  if (typeof userId !== "string") return null;
  try {
    const parsed = JSON.parse(userId);
    return parsed.session_id ?? "json-without-session_id";
  } catch {
    const m = userId.match(/session_([0-9a-f-]{36})/);
    return m ? m[1] : "present-without-session";
  }
}

/** The field's shape with every hex or uuid run replaced, so no value is logged. */
function idShape(userId) {
  if (typeof userId !== "string") return null;
  return userId
    .replace(
      /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g,
      "<uuid>",
    )
    .replace(/[0-9a-f]{16,}/g, (m) => `<hex${m.length}>`);
}

function decode(buffer, encoding) {
  try {
    if (encoding === "gzip") return zlib.gunzipSync(buffer);
    if (encoding === "br") return zlib.brotliDecompressSync(buffer);
    if (encoding === "deflate") return zlib.inflateSync(buffer);
  } catch (error) {
    return Buffer.from(`decode-failed ${error.message}`);
  }
  return buffer;
}

/** What the request body tells us, with no content copied. */
function describeRequest(body) {
  let json;
  try {
    json = JSON.parse(body.toString("utf8"));
  } catch {
    return { parsed: false };
  }
  const tools = Array.isArray(json.tools) ? json.tools : [];
  const cacheControl = [];
  const walk = (node, path) => {
    if (!node || typeof node !== "object") return;
    if (Array.isArray(node)) {
      node.forEach((child, i) => walk(child, [...path, i]));
      return;
    }
    if (node.cache_control)
      cacheControl.push({ path: path.join("."), value: node.cache_control });
    for (const [key, value] of Object.entries(node)) {
      if (key === "cache_control") continue;
      if (typeof value === "object") walk(value, [...path, key]);
    }
  };
  walk({ system: json.system, messages: json.messages, tools }, []);
  const text = body.toString("utf8");
  const messages = Array.isArray(json.messages) ? json.messages : [];
  const messageHashes = messages.map((m) =>
    sha(JSON.stringify(m)).slice(0, 16),
  );
  return {
    parsed: true,
    model: json.model,
    stream: json.stream === true,
    max_tokens: json.max_tokens,
    metadata_keys: json.metadata ? Object.keys(json.metadata) : null,
    metadata_session: json.metadata
      ? sessionSuffix(json.metadata.user_id)
      : null,
    metadata_user_id_shape: json.metadata
      ? idShape(json.metadata.user_id)
      : null,
    top_level_keys: Object.keys(json),
    messages: messages.length,
    message_hashes: messageHashes,
    last_role: messages.at(-1)?.role ?? null,
    tools: tools.length,
    tools_deferred: tools.filter((t) => t.defer_loading === true).length,
    tool_names_sample: tools.slice(0, 8).map((t) => t.name),
    tool_reference_blocks: (text.match(/"type":"tool_reference"/g) || [])
      .length,
    cache_control: cacheControl,
    context_management: json.context_management
      ? Object.keys(json.context_management)
      : null,
  };
}

/** Usage and shape from a captured SSE or JSON response, no text copied. */
function describeResponse(raw, contentType, encoding) {
  const buffer = decode(raw, encoding);
  const text = buffer.toString("utf8");
  if (!contentType.includes("text/event-stream")) {
    try {
      const json = JSON.parse(text);
      return {
        kind: "json",
        type: json.type,
        error: json.error
          ? { type: json.error.type, message: json.error.message }
          : null,
        usage: json.usage ?? null,
        stop_reason: json.stop_reason ?? null,
      };
    } catch {
      return { kind: "other", bytes: buffer.length };
    }
  }
  const out = {
    kind: "sse",
    events: 0,
    usage_start: null,
    usage_delta: null,
    stop_reason: null,
    blocks: {},
    model: null,
    error: null,
  };
  for (const line of text.split("\n")) {
    if (!line.startsWith("data:")) continue;
    out.events++;
    let event;
    try {
      event = JSON.parse(line.slice(5));
    } catch {
      continue;
    }
    if (event.type === "message_start") {
      out.usage_start = event.message?.usage ?? null;
      out.model = event.message?.model ?? null;
    } else if (event.type === "content_block_start") {
      const t = event.content_block?.type ?? "unknown";
      out.blocks[t] = (out.blocks[t] || 0) + 1;
    } else if (event.type === "message_delta") {
      out.usage_delta = event.usage ?? null;
      out.stop_reason = event.delta?.stop_reason ?? out.stop_reason;
    } else if (event.type === "error") {
      out.error = event.error ?? event;
    }
  }
  return out;
}

const server = http.createServer((req, res) => {
  const id = ++seq;
  const t0 = performance.now();
  const chunks = [];
  req.on("data", (c) => chunks.push(c));
  req.on("end", () => {
    const body = Buffer.concat(chunks);
    const tBodyRead = performance.now();
    const isMessages =
      req.url.startsWith("/v1/messages") && !req.url.includes("count_tokens");
    const abortThis =
      isMessages && ABORT_NTH > 0 && ++messagesSeen === ABORT_NTH;

    const headers = { ...req.headers };
    delete headers.host;
    delete headers.connection;
    delete headers["content-length"];
    delete headers["transfer-encoding"];
    headers["content-length"] = String(body.length);

    const record = {
      id,
      ts: new Date().toISOString(),
      host: hostname(),
      method: req.method,
      path: req.url,
      request_bytes: body.length,
      request_hash: sha(body).slice(0, 16),
      request_header_names: Object.keys(req.headers).filter(
        (h) => !REDACT.has(h),
      ),
      anthropic_beta: req.headers["anthropic-beta"] ?? null,
      anthropic_version: req.headers["anthropic-version"] ?? null,
      user_agent: req.headers["user-agent"] ?? null,
      has_authorization: "authorization" in req.headers,
      has_api_key: "x-api-key" in req.headers,
      request: describeRequest(body),
      aborted_by_spike: abortThis,
    };

    const upstream = https.request(
      {
        agent,
        host: UPSTREAM.hostname,
        port: 443,
        method: req.method,
        path: req.url,
        headers,
      },
      (up) => {
        const tFirstByte = performance.now();
        const captured = [];
        let capturedBytes = 0;
        let tUpstreamEnd = null;
        const resHeaders = { ...up.headers };
        delete resHeaders["set-cookie"];
        res.writeHead(up.statusCode, up.headers);
        up.on("data", (c) => {
          if (capturedBytes < MAX_CAPTURE) {
            captured.push(c);
            capturedBytes += c.length;
          }
          res.write(c);
          if (abortThis && capturedBytes > 0) {
            up.destroy(new Error("spike abort"));
          }
        });
        up.on("end", () => {
          tUpstreamEnd = performance.now();
          res.end();
        });
        up.on("error", (error) => {
          tUpstreamEnd = performance.now();
          record.upstream_error = error.message;
          res.destroy();
          finish();
        });
        res.on("finish", finish);
        res.on("close", () => {
          if (!record.finished) finish();
        });
        function finish() {
          if (record.finished) return;
          record.finished = true;
          const tClientEnd = performance.now();
          const buffer = Buffer.concat(captured);
          Object.assign(record, {
            status: up.statusCode,
            response_bytes: capturedBytes,
            response_header_names: Object.keys(up.headers),
            request_id:
              up.headers["request-id"] ?? up.headers["x-request-id"] ?? null,
            ratelimit_headers: Object.keys(up.headers).filter((h) =>
              h.startsWith("anthropic-ratelimit"),
            ),
            response_encoding: up.headers["content-encoding"] ?? null,
            response: describeResponse(
              buffer,
              String(up.headers["content-type"] ?? ""),
              String(up.headers["content-encoding"] ?? ""),
            ),
            timing_ms: {
              body_read: +(tBodyRead - t0).toFixed(1),
              proxy_before_upstream: +(tBodyRead - t0).toFixed(1),
              upstream_ttfb: +(tFirstByte - tBodyRead).toFixed(1),
              upstream_total: tUpstreamEnd
                ? +(tUpstreamEnd - tBodyRead).toFixed(1)
                : null,
              proxy_after_upstream: tUpstreamEnd
                ? +(tClientEnd - tUpstreamEnd).toFixed(1)
                : null,
              total: +(tClientEnd - t0).toFixed(1),
            },
          });
          log(record);
          process.stderr.write(
            `#${id} ${req.method} ${req.url} ${up.statusCode} ${record.request_bytes}B -> ${capturedBytes}B ttfb ${record.timing_ms.upstream_ttfb}ms total ${record.timing_ms.total}ms\n`,
          );
        }
      },
    );
    upstream.on("error", (error) => {
      record.upstream_error = error.message;
      record.timing_ms = { total: +(performance.now() - t0).toFixed(1) };
      log(record);
      if (!res.headersSent)
        res.writeHead(502, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          type: "error",
          error: { type: "proxy_error", message: error.message },
        }),
      );
    });
    upstream.end(body);
  });
});

server.listen(PORT, "127.0.0.1", () => {
  process.stderr.write(
    `local-proxy-spike listening on http://127.0.0.1:${PORT} -> ${UPSTREAM.origin}, log ${LOG}\n`,
  );
});
