/**
 * Shared transport for the dev levers. They drive the loopback routes on a
 * running `wrangler dev`, so a lane exercises the same projection code the MCP
 * tools will, not SQL retyped into a CLI.
 */

export const DEV_ORIGIN =
  process.env.VALISE_DEV_ORIGIN ?? "http://localhost:5173";

export async function callDev(path, params = {}, options = {}) {
  const url = new URL(path, DEV_ORIGIN);
  for (const [key, value] of Object.entries(params)) {
    for (const item of Array.isArray(value) ? value : [value]) {
      if (item !== undefined && item !== null) {
        url.searchParams.append(key, String(item));
      }
    }
  }

  let response;
  try {
    response = await fetch(url, options);
  } catch (cause) {
    throw new Error(
      `cannot reach ${DEV_ORIGIN}. Start it with \`npm run dev\`.`,
      { cause },
    );
  }

  const body = await response.text();
  if (!response.ok) {
    throw new Error(`${url.pathname} returned ${response.status}: ${body}`);
  }
  return JSON.parse(body);
}

export function printJson(value) {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}
