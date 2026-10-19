import assert from "node:assert/strict";
import test from "node:test";
import { Resvg } from "@resvg/resvg-js";
import {
  Image, encodeKitty, getPngDimensions, setCapabilities, setCellDimensions,
} from "@earendil-works/pi-tui";
import * as tui from "@earendil-works/pi-tui";
// PNG conversion was added after the pinned Pi 1.0 host; the actual-host suite covers it on 1.3.
const setImageTranscoder = (tui as unknown as {
  setImageTranscoder?: (convert: (data: string, mime: string) => string | null) => void;
}).setImageTranscoder;
import { getKittyImagePlacement } from "@earendil-works/pi-tui/dist/terminal-image.js";
import { installOrdinaryImagePatch, ordinaryImageCompatibilityAvailable } from "../src/ordinary-images.js";

const identity = (s: string) => s;
const png = new Resvg(`<svg xmlns="http://www.w3.org/2000/svg" width="180" height="144">
  <rect x="2" width="176" height="36" fill="red"/>
  <rect x="2" y="36" width="176" height="36" fill="green" fill-opacity="0.5"/>
  <rect x="2" y="72" width="176" height="72" fill="blue"/>
</svg>`).render().asPng().toString("base64");
const makeImage = () => new Image(png, "image/png", { fallbackColor: identity }, { maxWidthCells: 10 });

function decode(line: string) {
  const chunks = [...line.matchAll(/\x1b_G([^;]+);([^]*?)\x1b\\/gu)];
  assert.ok(chunks.length);
  return {
    header: Object.fromEntries(chunks[0][1].split(",").map(p => p.split("="))),
    data: chunks.map(chunk => chunk[2]).join(""),
  };
}
function pixels(data: string): Buffer {
  const dims = getPngDimensions(data)!;
  return new Resvg(`<svg xmlns="http://www.w3.org/2000/svg" width="${dims.widthPx}" height="${dims.heightPx}"><image width="${dims.widthPx}" height="${dims.heightPx}" href="data:image/png;base64,${data}"/></svg>`).render().pixels;
}

function setup() {
  const env = Object.fromEntries(["TERM_PROGRAM", "TERM", "TMUX", "STY", "PI_MATH_VSCODE_IMAGES", "PI_MATH_IMAGE_QUALITY"].map(k => [k, process.env[k]]));
  const stock = Image.prototype.render;
  process.env.TERM_PROGRAM = "vscode";
  process.env.TERM = "xterm-256color";
  delete process.env.TMUX;
  delete process.env.STY;
  delete process.env.PI_MATH_VSCODE_IMAGES;
  delete process.env.PI_MATH_IMAGE_QUALITY;
  setCapabilities({ images: "kitty", trueColor: true, hyperlinks: true });
  setCellDimensions({ widthPx: 9, heightPx: 18 });
  return { stock, restore() {
    Image.prototype.render = stock;
    for (const [key, value] of Object.entries(env)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    setCapabilities({ images: null, trueColor: false, hyperlinks: false });
    setImageTranscoder?.(() => null);
  } };
}

test("ordinary PNG rows preserve pixels/alpha and bypass the upload cache with distinct stable IDs", () => {
  const env = setup();
  const component = makeImage();
  const native = component.render(80);
  const snapshot = [...native];
  const patch = installOrdinaryImagePatch();
  patch.setQuality("sharp"); // Preserve the original 2x pixel/alpha golden fixture.
  try {
    const rows = component.render(80);
    assert.equal(rows.length, 4);
    const decoded = rows.map(decode);
    for (const [i, row] of decoded.entries()) {
      assert.equal(row.header.r, "1");
      assert.equal(row.header.c, "10");
      assert.equal(row.header.a, "T");
      assert.equal(row.header.C, "1");
      assert.notEqual(Number(row.header.i), component.getImageId());
      assert.equal(getKittyImagePlacement(rows[i]), undefined, "must never become a=p after d=a");
    }
    assert.equal(new Set(decoded.map(row => row.header.i)).size, rows.length);
    assert.deepEqual(Buffer.concat(decoded.map(row => pixels(row.data))), pixels(png));
    assert.deepEqual(native, snapshot, "do not mutate the component's native cache");
    assert.equal(component.render(80), rows);
    component.invalidate();
    assert.equal(component.render(80), rows, "equivalent regenerated native lines reuse row IDs");
    assert.equal(patch.getStatus().cacheSize, 1);
    assert.ok(patch.getStatus().cacheBytes > 0);
    patch.clear();
    assert.equal(patch.getStatus().cacheBytes, 0);
    assert.notEqual(component.render(80), rows);
    const resized = component.render(7);
    assert.equal(decode(resized[0]).header.c, "5");
    assert.equal(patch.getStatus().lastFailure, undefined);
  } finally { patch.uninstall(); env.restore(); }
});

test("fast and sharp keep cell geometry but fast uses one quarter of the pixels", () => {
  const env = setup();
  const patch = installOrdinaryImagePatch();
  try {
    assert.equal(patch.getStatus().quality, "fast");
    const image = makeImage();
    const fast = image.render(80);
    assert.equal(fast.length, 4);
    const fastPng = getPngDimensions(decode(fast[0]).data)!;
    assert.deepEqual(fastPng, { widthPx: 90, heightPx: 18 });
    patch.setQuality("fast");
    assert.equal(image.render(80), fast, "same quality must not clear hot cache");
    patch.setQuality("sharp");
    assert.equal(patch.getStatus().cacheSize, 0);
    const sharp = image.render(80);
    assert.equal(sharp.length, fast.length);
    const sharpPng = getPngDimensions(decode(sharp[0]).data)!;
    assert.deepEqual(sharpPng, { widthPx: 180, heightPx: 36 });
    assert.equal(sharpPng.widthPx * sharpPng.heightPx, 4 * fastPng.widthPx * fastPng.heightPx);
    assert.equal(decode(fast[0]).header.c, decode(sharp[0]).header.c);
    assert.equal(decode(fast[0]).header.r, decode(sharp[0]).header.r);
    assert.notEqual(decode(fast[0]).header.i, decode(sharp[0]).header.i);
    for (const lines of [fast, sharp]) for (const line of lines) assert.equal(getKittyImagePlacement(line), undefined);
    patch.clear();
    assert.equal(patch.getStatus().quality, "sharp", "clear is not a quality reset");
    patch.setQuality("fast");
    assert.deepEqual(getPngDimensions(decode(image.render(80)[0]).data), fastPng);
  } finally { patch.uninstall(); env.restore(); }
});

test("sharp startup preference can be overridden without changing the environment", () => {
  const env = setup();
  process.env.PI_MATH_IMAGE_QUALITY = "sharp";
  const patch = installOrdinaryImagePatch();
  try {
    assert.equal(patch.getStatus().quality, "sharp");
    patch.setQuality("fast");
    assert.equal(patch.getStatus().quality, "fast");
    assert.equal(process.env.PI_MATH_IMAGE_QUALITY, "sharp");
  } finally { patch.uninstall(); env.restore(); }
});

test("single-row images also re-upload instead of inheriting native placement metadata", () => {
  const env = setup();
  const patch = installOrdinaryImagePatch();
  try {
    const image = new Image(png, "image/png", { fallbackColor: identity }, { maxWidthCells: 10, maxHeightCells: 1 });
    const rows = image.render(80);
    assert.equal(rows.length, 1);
    assert.equal(getKittyImagePlacement(rows[0]), undefined);
    assert.notEqual(Number(decode(rows[0]).header.i), image.getImageId());
  } finally { patch.uninstall(); env.restore(); }
});

test("delegates JPEG/WebP/GIF conversion to Pi, including converted dimensions", { skip: !setImageTranscoder }, () => {
  const env = setup();
  const patch = installOrdinaryImagePatch();
  let conversions = 0;
  setImageTranscoder!(() => { conversions++; return png; });
  try {
    for (const mime of ["image/jpeg", "image/webp", "image/gif"]) {
      const image = new Image("test input " + mime, mime, { fallbackColor: identity }, { maxWidthCells: 10 });
      assert.equal(image.render(80).length, 4);
      assert.equal(decode(image.render(80)[0]).header.r, "1");
    }
    assert.equal(conversions, 3);
  } finally { patch.uninstall(); env.restore(); }
});

test("only VS Code + Kitty without tmux/screen is affected; enable is independent", () => {
  const env = setup();
  const patch = installOrdinaryImagePatch();
  try {
    for (const program of ["kitty", "ghostty", "wezterm", "iterm.app", ""]) {
      process.env.TERM_PROGRAM = program;
      const image = makeImage();
      assert.deepEqual(image.render(80), env.stock.call(image, 80));
      assert.equal(ordinaryImageCompatibilityAvailable(), false);
    }
    process.env.TERM_PROGRAM = "vscode";
    process.env.TMUX = "/tmp/tmux-test";
    assert.equal(ordinaryImageCompatibilityAvailable(), false);
    delete process.env.TMUX;
    process.env.STY = "test-screen";
    assert.equal(ordinaryImageCompatibilityAvailable(), false);
    delete process.env.STY;
    process.env.TERM = "screen-256color";
    assert.equal(ordinaryImageCompatibilityAvailable(), false);
    process.env.TERM = "xterm-256color";
    for (const protocol of [null, "iterm2"] as const) {
      setCapabilities({ images: protocol, trueColor: true, hyperlinks: true });
      const image = makeImage();
      assert.deepEqual(image.render(80), env.stock.call(image, 80));
    }
    setCapabilities({ images: "kitty", trueColor: true, hyperlinks: true });
    patch.setEnabled(false);
    const image = makeImage();
    assert.deepEqual(image.render(80), env.stock.call(image, 80));
    patch.setEnabled(true);
    assert.notDeepEqual(image.render(80), env.stock.call(image, 80));
  } finally { patch.uninstall(); env.restore(); }
});

test("environment opt-out and idempotent lifecycle/rearm coexist with other wrappers", () => {
  const env = setup();
  process.env.PI_MATH_VSCODE_IMAGES = "0";
  const patch = installOrdinaryImagePatch();
  try {
    assert.equal(patch.isEnabled(), false);
    patch.setEnabled(true);
    const own = Image.prototype.render;
    const other = function (this: Image, width: number) { return own.call(this, width); };
    Image.prototype.render = other;
    patch.rearm();
    const rows = makeImage().render(80);
    assert.equal(rows.length, 4);
    assert.equal(patch.getStatus().cacheSize, 1, "a chained wrapper must not transform rows twice");
    patch.uninstall();
    assert.equal(Image.prototype.render, other);
    patch.uninstall();
    patch.rearm();
    assert.equal(Image.prototype.render, other);
    const image = makeImage();
    assert.deepEqual(image.render(80), env.stock.call(image, 80));
  } finally { patch.uninstall(); env.restore(); }
});

test("chunked PNG transmissions are decoded before slicing", () => {
  const env = setup();
  let seed = 1;
  const rects = Array.from({ length: 4096 }, (_, i) => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    return `<rect x="${i % 64}" y="${Math.floor(i / 64)}" width="1" height="1" fill="#${(seed & 0xffffff).toString(16).padStart(6, "0")}"/>`;
  }).join("");
  const noisy = new Resvg(`<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64">${rects}</svg>`).render().asPng().toString("base64");
  assert.ok(noisy.length > 4096);
  const patch = installOrdinaryImagePatch();
  try {
    const image = new Image(noisy, "image/png", { fallbackColor: identity }, { maxWidthCells: 10 });
    const native = env.stock.call(image, 80);
    assert.ok(native[0].includes("m=1"));
    const rows = image.render(80);
    assert.ok(rows.every(line => decode(line).header.r === "1"));
    assert.equal(patch.getStatus().lastFailure, undefined);
  } finally { patch.uninstall(); env.restore(); }
});

test("malformed, custom, and oversized images fail safely without corrupting native output", () => {
  const env = setup();
  let native = ["not an image"];
  Image.prototype.render = () => native;
  const patch = installOrdinaryImagePatch();
  const image = makeImage();
  try {
    assert.equal(image.render(80), native);
    native = ["\x1b_Ga=p,i=8\x1b\\"];
    assert.equal(image.render(80), native);
    native = [encodeKitty("YmFk", { columns: 1, rows: 1, moveCursor: false })];
    assert.equal(image.render(80), native);
    assert.match(patch.getStatus().lastFailure!, /Invalid PNG/);
    native = [encodeKitty(png, { columns: 300, rows: 1, moveCursor: false })];
    assert.equal(image.render(80), native);
    assert.match(patch.getStatus().lastFailure!, /cell dimensions/);
    patch.clear();
    assert.equal(patch.getStatus().lastFailure, undefined);
  } finally { patch.uninstall(); env.restore(); }
});
