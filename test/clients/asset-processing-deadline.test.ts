import { expect, it, vi } from "vitest";
import { deadline } from "~/concepts/asset-extraction";

it("bounds waiting without pretending to cancel an outstanding provider promise", async () => {
  vi.useFakeTimers();
  try {
    let finish: (value: string) => void = () => {};
    let providerFinished = false;
    const provider = new Promise<string>((resolve) => {
      finish = resolve;
    }).then((value) => {
      providerFinished = true;
      return value;
    });
    const waiting = deadline(provider, 10);
    const rejected = expect(waiting).rejects.toMatchObject({
      code: "provider_timeout",
    });
    await vi.advanceTimersByTimeAsync(11);
    await rejected;
    expect(providerFinished).toBe(false);
    finish("late provider result");
    expect(await provider).toBe("late provider result");
    expect(providerFinished).toBe(true);
    await expect(waiting).rejects.toMatchObject({ code: "provider_timeout" });
  } finally {
    vi.useRealTimers();
  }
});
