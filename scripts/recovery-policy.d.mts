export declare const TABLES: readonly string[];
export declare const OMITTED: readonly string[];
export declare function checkTables(names: string[]): void;
export declare function quote(name: string): string;
export declare function literal(value: string | number | null): string;
export declare function insert(
  table: string,
  row: Record<string, string | number | null>,
): string;
export type Original = {
  key: string;
  size: number;
  sha256: string;
  contentType: string;
};
export declare function inventory(
  objectRows: Iterable<{
    r2_key: string;
    size: number;
    sha256: string;
    content_type: string;
  }>,
  versionRows: Iterable<{ files_json: string }>,
): Original[];
