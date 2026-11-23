import { describe, expect, it } from "vitest";
import {
  ATTACHMENT_LIMITS,
  attachmentKind,
  attachmentRefusal,
  memberAllowance,
} from "~/concepts/attachment-limits";

const MiB = 1024 * 1024;

describe("a bookmark's file allowance", () => {
  it("sorts a file into its kind by MIME type", () => {
    expect(attachmentKind("image/webp")).toBe("image");
    expect(attachmentKind("Application/PDF; charset=binary")).toBe("pdf");
    expect(attachmentKind("video/mp4")).toBe("video");
    expect(attachmentKind("application/json")).toBe("other");
  });

  it("holds each file to its kind and the set to the bookmark, more for the owner", () => {
    const photo = {
      title: "dawn.jpg",
      contentType: "image/jpeg",
      size: 3 * MiB,
    };
    expect(attachmentRefusal("free", [photo])).toBe(
      "dawn.jpg is 3 MB; a bookmark's images are limited to 1 MB each on this account.",
    );
    expect(attachmentRefusal("owner", [photo])).toBeNull();
    const four = Array.from({ length: 4 }, (_, n) => ({
      ...photo,
      title: `${n}.jpg`,
      size: 7 * MiB,
    }));
    expect(attachmentRefusal("owner", four)).toBe(
      "These files total 28 MB; a bookmark holds at most 25 MB of files on this account.",
    );
    expect(ATTACHMENT_LIMITS.free.perBookmark).toBe(2 * MiB);
  });

  it("gives members the free allowance unless the install grants the owner's", () => {
    expect(memberAllowance(undefined)).toBe("free");
    expect(memberAllowance("")).toBe("free");
    expect(memberAllowance("free")).toBe("free");
    expect(memberAllowance(" owner ")).toBe("owner");
    expect(memberAllowance("unlimited")).toBe("free");
  });
});
