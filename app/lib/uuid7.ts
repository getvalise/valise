let lastMs = 0;
let sequence = 0;

/**
 * A UUIDv7 (RFC 9562): 48 bits of Unix milliseconds, then a 12-bit sequence,
 * then random bits. Its hex form sorts in the order it was minted, which is
 * what orders a to-do's log when two rows share a whole-second `created_at`.
 *
 * Within one isolate the ids are strictly increasing even inside a single
 * millisecond, which matters because a Worker's clock only advances across
 * I/O. Across isolates they order by millisecond.
 */
export function uuid7(now: number = Date.now()): string {
  if (now > lastMs) {
    lastMs = now;
    sequence = 0;
  } else if (++sequence > 0xfff) {
    lastMs += 1;
    sequence = 0;
  }
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  let ms = lastMs;
  for (let i = 5; i >= 0; i--) {
    bytes[i] = ms % 256;
    ms = Math.floor(ms / 256);
  }
  bytes[6] = 0x70 | (sequence >> 8);
  bytes[7] = sequence & 0xff;
  bytes[8] = 0x80 | (bytes[8] & 0x3f);
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join(
    "",
  );
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
