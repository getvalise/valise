export function localSql(baseURL: string, sql: string): void;
export function localQuery<Row = Record<string, unknown>>(
  baseURL: string,
  sql: string,
): Row[];
