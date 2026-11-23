/**
 * The control/data routing seam, not a shard directory. Both select the same
 * primary binding today. Do not accept a database id, item id or request header
 * as a route. ADR-0017.
 */
export function controlDatabase(env: { DB: D1Database }): D1Database {
  return env.DB;
}

export function tenantStorage(
  env: { DB: D1Database },
  principal: { readonly userId: string },
) {
  if (!principal.userId || principal.userId.trim() !== principal.userId) {
    throw new Error("Tenant storage requires a resolved principal.");
  }
  return Object.freeze({
    kind: "shared-primary" as const,
    userId: principal.userId,
    DB: env.DB,
  });
}

export type TenantStorage = ReturnType<typeof tenantStorage>;
