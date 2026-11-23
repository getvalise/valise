import type { Config } from "@react-router/dev/config";

export default {
  ssr: true,
  /*
   * The console is eight routes, so the whole manifest ships with the first
   * document. Lazy discovery fetches `/__manifest` patches after hydration
   * and falls back to a full document reload when that fetch fails, which is
   * what intermittently destroyed Playwright's evaluation context in CI
   * ("Execution context was destroyed") on the viewport sweep.
   */
  routeDiscovery: { mode: "initial" },
} satisfies Config;
