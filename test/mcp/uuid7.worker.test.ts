import { describe, expect, it } from "vitest";
import { uuid7 } from "~/lib/uuid7";

describe("uuid7", () => {
  it("sorts in mint order, inside one millisecond and across a clock step back", () => {
    const minted = [
      uuid7(1_792_000_000_000),
      uuid7(1_792_000_000_000),
      uuid7(1_792_000_000_000),
      uuid7(1_791_999_999_999),
      uuid7(1_792_000_000_001),
    ];
    expect([...minted].sort()).toEqual(minted);
    expect(new Set(minted).size).toBe(minted.length);
    for (const id of minted) {
      expect(id).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
      );
    }
  });

  it("carries its millisecond in the first 48 bits", () => {
    const ms = 1_893_456_000_123;
    const id = uuid7(ms);
    expect(Number.parseInt(id.replace("-", "").slice(0, 12), 16)).toBe(ms);
  });
});
