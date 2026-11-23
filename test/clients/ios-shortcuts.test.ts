import { describe, expect, it } from "vitest";
import { IOS_SHORTCUT_LINK, iosShortcutLink } from "~/concepts/ios-shortcuts";

describe("Capture Shortcut link", () => {
  it("offers the upstream Shortcut when the var is unset or blank", () => {
    expect(iosShortcutLink({})).toBe(IOS_SHORTCUT_LINK);
    expect(iosShortcutLink({ IOS_SHORTCUT_LINK: "  " })).toBe(
      IOS_SHORTCUT_LINK,
    );
  });

  it("offers an install's own Shortcut", () => {
    const own = "https://www.icloud.com/shortcuts/0123456789abcdef";
    expect(iosShortcutLink({ IOS_SHORTCUT_LINK: own })).toBe(own);
  });

  it("offers none when the install opts out", () => {
    expect(iosShortcutLink({ IOS_SHORTCUT_LINK: "none" })).toBeNull();
  });
});
