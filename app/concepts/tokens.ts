import { isMcpScope, type McpScope, normalizeMcpScopes } from "~/auth/scopes";

const MAX_LABEL_LENGTH = 120;
const TOKEN_PATTERN = /^vls_[A-Za-z0-9_-]{43}$/;

export type BearerTokenEnv = {
  DB: D1Database;
  TOKEN_PEPPER: string;
};

export type MintBearerTokenInput = {
  userId: string;
  label: string;
  scopes: readonly string[];
};

export type BearerTokenRecord = {
  tokenId: string;
  userId: string;
  label: string;
  scopes: readonly McpScope[];
  createdAt: number;
  revokedAt: number | null;
};

export type MintedBearerToken = {
  token: string;
  record: BearerTokenRecord;
};

type StoredTokenScopeRow = {
  tokenId: string;
  userId: string;
  label: string;
  createdAt: number;
  revokedAt: number | null;
  scope: string | null;
};

export async function mintBearerToken(
  env: BearerTokenEnv,
  input: MintBearerTokenInput,
): Promise<MintedBearerToken> {
  const validated = validateInput(input);
  const token = `vls_${randomBase64Url(32)}`;
  const tokenId = `btk_${crypto.randomUUID()}`;
  const createdAt = nowSeconds();
  const tokenDigest = await digestToken(token, env.TOKEN_PEPPER);
  const record: BearerTokenRecord = {
    tokenId,
    userId: validated.userId,
    label: validated.label,
    scopes: validated.scopes,
    createdAt,
    revokedAt: null,
  };

  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO bearer_tokens (
          token_id, user_id, label, token_digest, created_at, revoked_at
        ) VALUES (?, ?, ?, ?, ?, NULL)`,
    ).bind(tokenId, record.userId, record.label, tokenDigest, createdAt),
    ...record.scopes.map((scope) =>
      env.DB.prepare(
        `INSERT INTO ${scopeTable(scope)} (token_id, scope) VALUES (?, ?)`,
      ).bind(tokenId, scope),
    ),
  ]);

  return { token, record };
}

export async function resolveBearerToken(
  env: BearerTokenEnv,
  token: string,
): Promise<BearerTokenRecord | null> {
  if (!TOKEN_PATTERN.test(token)) return null;
  const tokenDigest = await digestToken(token, env.TOKEN_PEPPER);
  const { results } = await env.DB.prepare(
    `SELECT t.token_id AS tokenId, t.user_id AS userId, t.label,
              t.created_at AS createdAt, t.revoked_at AS revokedAt,
              s.scope
         FROM bearer_tokens t
         LEFT JOIN (
              SELECT token_id, scope FROM bearer_token_scopes
              UNION ALL
              SELECT token_id, scope FROM bearer_token_grants
            ) s ON s.token_id = t.token_id
        WHERE t.token_digest = ?`,
  )
    .bind(tokenDigest)
    .all<StoredTokenScopeRow>();
  const record = recordFromRows(results);
  return record?.revokedAt === null ? record : null;
}

export async function listBearerTokens(
  env: Pick<BearerTokenEnv, "DB">,
  userId: string,
): Promise<BearerTokenRecord[]> {
  const { results } = await env.DB.prepare(
    `SELECT t.token_id AS tokenId, t.user_id AS userId, t.label,
              t.created_at AS createdAt, t.revoked_at AS revokedAt,
              s.scope
         FROM bearer_tokens t
         LEFT JOIN (
              SELECT token_id, scope FROM bearer_token_scopes
              UNION ALL
              SELECT token_id, scope FROM bearer_token_grants
            ) s ON s.token_id = t.token_id
        WHERE t.user_id = ?
        ORDER BY t.created_at DESC, t.token_id`,
  )
    .bind(userId)
    .all<StoredTokenScopeRow>();
  const grouped = new Map<string, StoredTokenScopeRow[]>();
  for (const row of results) {
    const rows = grouped.get(row.tokenId);
    if (rows) rows.push(row);
    else grouped.set(row.tokenId, [row]);
  }
  return [...grouped.values()].flatMap((rows) => {
    const record = recordFromRows(rows);
    return record === null ? [] : [record];
  });
}

export async function revokeBearerToken(
  env: Pick<BearerTokenEnv, "DB">,
  input: { userId: string; tokenId: string },
): Promise<{ revoked: boolean }> {
  const now = nowSeconds();
  const result = await env.DB.prepare(
    `UPDATE bearer_tokens
          SET revoked_at = COALESCE(revoked_at, ?)
        WHERE token_id = ? AND user_id = ?`,
  )
    .bind(now, input.tokenId, input.userId)
    .run();
  return { revoked: result.meta.changes === 1 };
}

/**
 * The seven scopes `bearer_token_scopes`' CHECK accepts. Anything added to the
 * vocabulary since is stored in `bearer_token_grants`. ADR-0004, 2026-10-17.
 */
const CHECKED_SCOPES = new Set<McpScope>([
  "search:read",
  "todos:read",
  "todos:write",
  "memories:read",
  "memories:write",
  "skills:read",
  "skills:write",
]);

function scopeTable(scope: McpScope): string {
  return CHECKED_SCOPES.has(scope)
    ? "bearer_token_scopes"
    : "bearer_token_grants";
}

function validateInput(input: MintBearerTokenInput): {
  userId: string;
  label: string;
  scopes: McpScope[];
} {
  const userId = input.userId.trim();
  if (!userId) throw new Error("A bearer token requires a user id.");
  const label = input.label.trim();
  if (!label || label.length > MAX_LABEL_LENGTH) {
    throw new Error(
      "A bearer token label must be between 1 and 120 characters.",
    );
  }
  if (!input.scopes.length || !input.scopes.every(isMcpScope)) {
    throw new Error("A bearer token requires known scopes.");
  }
  const scopes = normalizeMcpScopes(input.scopes);
  if (!scopes.length) throw new Error("A bearer token requires known scopes.");
  return { userId, label, scopes };
}

function recordFromRows(
  rows: readonly StoredTokenScopeRow[],
): BearerTokenRecord | null {
  const first = rows[0];
  if (!first) return null;
  const rawScopes = rows.flatMap((row) =>
    row.scope === null ? [] : [row.scope],
  );
  if (!rawScopes.length || !rawScopes.every(isMcpScope)) return null;
  const scopes = normalizeMcpScopes(rawScopes);
  if (scopes.length !== rawScopes.length) return null;
  return {
    tokenId: first.tokenId,
    userId: first.userId,
    label: first.label,
    scopes,
    createdAt: first.createdAt,
    revokedAt: first.revokedAt,
  };
}

async function digestToken(token: string, pepper: string): Promise<string> {
  if (!pepper) throw new Error("TOKEN_PEPPER is required.");
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(pepper),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(token),
  );
  return [...new Uint8Array(signature)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

function randomBase64Url(bytes: number): string {
  const random = crypto.getRandomValues(new Uint8Array(bytes));
  let binary = "";
  for (const byte of random) binary += String.fromCharCode(byte);
  return btoa(binary)
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/, "");
}

function nowSeconds(): number {
  return Math.floor(Date.now() / 1000);
}
