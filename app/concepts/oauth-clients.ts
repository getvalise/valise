import type {
  ClientInfo,
  GrantSummary,
  ListResult,
} from "@cloudflare/workers-oauth-provider";
import { type OAuthEnv, oauthManagementApi } from "../../workers/oauth";

export type OAuthConnection = {
  clientId: string;
  clientName: string;
  redirectUris: string[];
  scopes: string[];
  connectedAt: number;
};

export async function listOAuthConnections(
  env: OAuthEnv,
  userId: string,
): Promise<OAuthConnection[]> {
  const api = oauthManagementApi(env);
  const grants = await listAll((options) =>
    api.listUserGrants(userId, options),
  );
  const byClient = new Map<string, GrantSummary[]>();
  for (const grant of grants) {
    const existing = byClient.get(grant.clientId);
    if (existing) existing.push(grant);
    else byClient.set(grant.clientId, [grant]);
  }

  return Promise.all(
    [...byClient.entries()].map(async ([clientId, clientGrants]) => {
      const client = await api.lookupClient(clientId).catch(() => null);
      return connection(clientId, client, clientGrants);
    }),
  );
}

export async function revokeOAuthConnection(
  env: OAuthEnv,
  userId: string,
  clientId: string,
): Promise<boolean> {
  const api = oauthManagementApi(env);
  const grants = await listAll((options) =>
    api.listUserGrants(userId, options),
  );
  const matching = grants.filter((grant) => grant.clientId === clientId);
  if (matching.length === 0) return false;
  // The registration is shared; disconnect only this user's grants and tokens.
  for (const grant of matching) await api.revokeGrant(grant.id, userId);
  return true;
}

async function listAll<T>(
  load: (options: { cursor?: string; limit: number }) => Promise<ListResult<T>>,
): Promise<T[]> {
  const items: T[] = [];
  let cursor: string | undefined;
  do {
    const page = await load({ cursor, limit: 1_000 });
    items.push(...page.items);
    cursor = page.cursor;
  } while (cursor);
  return items;
}

function connection(
  clientId: string,
  client: ClientInfo | null,
  grants: readonly GrantSummary[],
): OAuthConnection {
  return {
    clientId,
    clientName: client?.clientName ?? clientId,
    redirectUris: client?.redirectUris ?? [],
    scopes: [...new Set(grants.flatMap((grant) => grant.scope))].sort(),
    connectedAt: Math.max(...grants.map((grant) => grant.createdAt)),
  };
}
