#!/usr/bin/env node
/**
 * Render public/favicon.svg to the raster icons browsers and the iPhone ask
 * for by name: /favicon.ico, the apple-touch-icon and the manifest sizes.
 * The outputs are committed; run this only when the mark changes.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { chromium } from "@playwright/test";

const svg = readFileSync("public/favicon.svg", "utf8");
const browser = await chromium.launch();

async function png(size, square = false) {
  const page = await browser.newPage({
    viewport: { width: size, height: size },
  });
  await page.setContent(
    `<style>html,body{margin:0}svg{display:block;width:${size}px;height:${size}px}</style>${square ? svg.replace('rx="5"', 'rx="0"') : svg}`,
  );
  const buffer = await page.screenshot({ omitBackground: true });
  await page.close();
  return buffer;
}

// iOS rounds the corners itself and paints transparency black, so its icon
// is a full square.
writeFileSync("public/apple-touch-icon.png", await png(180, true));
writeFileSync("public/icon-192.png", await png(192));
writeFileSync("public/icon-512.png", await png(512));

// An ICO is a directory of images, and PNG payloads are valid in one.
const sizes = [16, 32, 48];
const images = await Promise.all(sizes.map(png));
const header = Buffer.alloc(6 + 16 * sizes.length);
header.writeUInt16LE(1, 2);
header.writeUInt16LE(sizes.length, 4);
let offset = header.length;
sizes.forEach((size, i) => {
  const at = 6 + 16 * i;
  header.writeUInt8(size, at);
  header.writeUInt8(size, at + 1);
  header.writeUInt16LE(1, at + 4);
  header.writeUInt16LE(32, at + 6);
  header.writeUInt32LE(images[i].length, at + 8);
  header.writeUInt32LE(offset, at + 12);
  offset += images[i].length;
});
writeFileSync("public/favicon.ico", Buffer.concat([header, ...images]));
await browser.close();
