import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("shared static Tailwind stylesheet", () => {
  it("ships compiled utilities and the same palette at the OAuth/console asset path", () => {
    const css = readFileSync("public/valise.css", "utf8");
    expect(css).toContain(".gap-section");
    expect(css).toContain(".sr-only");
    // A purple primary, and a dark theme with its own ground. Values are
    // the theme's to tune; the roles are what the console depends on.
    expect(css).toMatch(/--primary:\s*oklch\([^)]*\s30\d\)/);
    expect(css).toMatch(/\.dark\s*\{[^}]*--background:/);
    expect(css).not.toMatch(/@(?:import|source|theme|apply)\b/);
    expect(readFileSync("app/root.tsx", "utf8")).toContain(
      'href: "/valise.css"',
    );
    expect(readFileSync("app/lib/auth.server.ts", "utf8")).toContain(
      "/valise.css",
    );
  });
});
