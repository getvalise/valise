export type Installation = {
  raw: string;
  config: Record<string, unknown>;
  identity: {
    worker: string;
    account: string | null;
    database: string;
    bucket: string;
    kv: string;
    vectorNamespace: string | null;
  };
};
export declare function installation(path: string): Promise<Installation>;
export declare function backupSource(path: string): {
  raw: string;
  identity: Installation["identity"];
  revision: string | null;
};
