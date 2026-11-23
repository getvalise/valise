import {
  listOAuthConnections,
  revokeOAuthConnection,
} from "~/concepts/oauth-clients";
import {
  listBearerTokens,
  mintBearerToken,
  revokeBearerToken,
} from "~/concepts/tokens";
import { getUser, getUserForPasswordAuth } from "~/concepts/users";
import { requireUser, type SessionEnv } from "~/lib/auth.server";
import type { OAuthEnv } from "../../workers/oauth";
import { controlDatabase } from "./routing.server";

/**
 * The signed-in person's own credentials and account record: OAuth grants,
 * bearer tokens and identity. Control-plane state, so it reads the control
 * database rather than a tenant route, and it is a separate browser-only
 * factory, like account administration: an MCP or bearer store never holds
 * the authority to mint or revoke credentials. ADR-0017.
 */
export async function requireCredentialStore(
  env: OAuthEnv & SessionEnv,
  request: Request,
) {
  const db = controlDatabase(env);
  const user = await requireUser({ ...env, DB: db }, request);
  const userId = user.userId;
  const oauth = Object.freeze({ ...env, DB: db });
  return Object.freeze({
    oauthConnections: () => listOAuthConnections(oauth, userId),
    revokeOAuth: (clientId: string) =>
      revokeOAuthConnection(oauth, userId, clientId),
    bearerTokens: () => listBearerTokens({ DB: db }, userId),
    revokeBearer: (tokenId: string) =>
      revokeBearerToken({ DB: db }, { userId, tokenId }),
    /** Null when the deployment has no token pepper configured. */
    mintBearer: async (input: { label: string; scopes: readonly string[] }) =>
      env.TOKEN_PEPPER
        ? mintBearerToken(
            { DB: db, TOKEN_PEPPER: env.TOKEN_PEPPER },
            { ...input, userId },
          )
        : null,
    /** The account record, and whether a password sign-in exists for it. */
    account: async () => {
      const record = await getUser(db, userId);
      const auth =
        record?.email != null
          ? await getUserForPasswordAuth(db, record.email)
          : null;
      return { record, hasPassword: auth?.passwordHash != null };
    },
  });
}

export type CredentialStore = Awaited<
  ReturnType<typeof requireCredentialStore>
>;
