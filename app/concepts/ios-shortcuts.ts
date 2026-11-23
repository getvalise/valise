/**
 * The iCloud share link for the Valise Capture Shortcut, which posts to the
 * capture URL it asks for on install. A link is made on a device, with
 * Share → Copy iCloud Link in the Shortcuts app, so it cannot be generated
 * from the repo; iOS imports only signed Shortcut files and signing needs a
 * Mac. The Shortcut names no origin, so the upstream link works for any
 * install; the `IOS_SHORTCUT_LINK` var points a self-hosted install at its
 * own copy, and `none` hides the button. The build steps are
 * docs/operations/ios-capture.md. ADR-0015, amendment of 2026-11-02.
 */
export const IOS_SHORTCUT_LINK =
  "https://www.icloud.com/shortcuts/6a1718a7f7b045b29bec660b59ef6172";

/** The link Connections offers, or null when the install has opted out. */
export function iosShortcutLink(env: {
  IOS_SHORTCUT_LINK?: string;
}): string | null {
  const value = env.IOS_SHORTCUT_LINK?.trim();
  if (!value) return IOS_SHORTCUT_LINK;
  return value === "none" ? null : value;
}
