/** Bindings the d1 vitest pool injects on top of the generated worker Env. */
declare namespace Cloudflare {
  interface Env {
    TEST_MIGRATIONS: D1Migration[];
    /** Comma-separated store sizes for the retrieval test. */
    RETRIEVAL_SIZES: string;
  }
}
