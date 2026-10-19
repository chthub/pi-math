// Offline synthetic benchmark. Never starts Pi CLI, writes images, or patches sources.
// PI_MATH_TEST_HOST selects an actual coding-agent package (default: pinned host).
import { createRequire } from "node:module";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { performance } from "node:perf_hooks";
import { deflateSync, inflateSync } from "node:zlib";
import { Resvg } from "@resvg/resvg-js";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const host = process.env.PI_MATH_TEST_HOST ? resolve(process.env.PI_MATH_TEST_HOST)
  : dirname(dirname(fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent"))));
const requireHost = createRequire(join(host, "package.json"));
const version = requireHost("./package.json").version;
const tuiEntry = requireHost.resolve("@earendil-works/pi-tui");
const moduleApi = await import(pathToFileURL(tuiEntry).href);
const { createJiti } = await import(pathToFileURL(requireHost.resolve("jiti")).href);
const envKeys = ["TERM_PROGRAM", "TERM", "TMUX", "STY", "PI_IMAGE_PROTOCOL", "PI_MATH_VSCODE_IMAGES", "PI_MATH_IMAGE_QUALITY", "WEZTERM_PANE", "KITTY_WINDOW_ID", "GHOSTTY_RESOURCES_DIR", "PI_TUI_WRITE_LOG", "PI_TUI_DEBUG_REDRAW"];
const oldEnv = Object.fromEntries(envKeys.map(key => [key, process.env[key]]));
const FRAME_COUNT = 80;
const WARMUP = 20;
function check(ok, message) { if (!ok) throw new Error(message); }
function configure(api) {
  for (const key of envKeys) delete process.env[key];
  Object.assign(process.env, { TERM_PROGRAM: "vscode", TERM: "xterm-256color", PI_IMAGE_PROTOCOL: "kitty" });
  api.setCapabilities({ images: "kitty", trueColor: true, hyperlinks: true });
  api.setCellDimensions({ widthPx: 9, heightPx: 18 });
}
const crcTable = Uint32Array.from({ length: 256 }, (_, value) => {
  for (let i = 0; i < 8; i++) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
  return value >>> 0;
});
function crc32(bytes) {
  let crc = 0xffffffff;
  for (const value of bytes) crc = crcTable[(crc ^ value) & 255] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const output = Buffer.alloc(data.length + 12);
  output.writeUInt32BE(data.length, 0);
  output.write(type, 4, 4, "ascii");
  data.copy(output, 8);
  output.writeUInt32BE(crc32(output.subarray(4, output.length - 4)), output.length - 4);
  return output;
}
const pngSignature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
function pngChunks(png) {
  const chunks = [];
  for (let offset = 8; offset < png.length;) {
    const length = png.readUInt32BE(offset);
    check(offset + length + 12 <= png.length, "invalid synthetic PNG chunk");
    chunks.push({ type: png.toString("ascii", offset + 4, offset + 8), data: png.subarray(offset + 8, offset + 8 + length), raw: png.subarray(offset, offset + 12 + length) });
    offset += length + 12;
  }
  return chunks;
}
function recompress(png, level) {
  const chunks = pngChunks(png);
  const raw = inflateSync(Buffer.concat(chunks.filter(item => item.type === "IDAT").map(item => item.data)));
  const compressed = deflateSync(raw, { level });
  check(inflateSync(compressed).equals(raw), "lossless recompression changed filtered pixels");
  let emitted = false;
  return Buffer.concat([pngSignature, ...chunks.flatMap(item => {
    if (item.type !== "IDAT") return [item.raw];
    if (emitted) return [];
    emitted = true;
    return [chunk("IDAT", compressed)];
  })]);
}
function screenshot() {
  let shapes = '<rect width="1080" height="720" fill="#f8fafc"/><rect width="1080" height="54" fill="#18263a"/><rect y="54" width="170" height="666" fill="#e7edf5"/><rect x="196" y="84" width="858" height="600" rx="8" fill="white"/>';
  for (let i = 0; i < 12; i++) shapes += `<rect x="20" y="${90 + i * 44}" width="${90 + (i % 4) * 12}" height="7" fill="#7b8ca3"/>`;
  for (let i = 0; i < 9; i++) shapes += `<path d="M230 ${190 + i * 50}H1010" stroke="#dbe3ed"/>`;
  for (let i = 0; i < 16; i++) shapes += `<rect x="${245 + i * 47}" y="${510 - (i * 37 % 220)}" width="28" height="${80 + (i * 37 % 220)}" fill="${i % 2 ? "#69b4ef" : "#4a75d8"}"/>`;
  let points = "";
  for (let i = 0; i < 90; i++) points += `${240 + i * 8.5},${365 - Math.sin(i / 8) * 70 - i * 1.3} `;
  shapes += `<polyline points="${points}" fill="none" stroke="#dc6349" stroke-width="3"/>`;
  // Small glyph-like bars represent UI labels without reading any installed fonts.
  for (let row = 0; row < 3; row++) for (let i = 0; i < 100; i++) shapes += `<rect x="${230 + i * 7.6}" y="${112 + row * 15}" width="${3 + i % 3}" height="${5 + i % 5}" fill="#45566d"/>`;
  return new Resvg(`<svg xmlns="http://www.w3.org/2000/svg" width="1080" height="720">${shapes}</svg>`, { font: { loadSystemFonts: false } }).render().asPng();
}
function noisyPhoto() {
  const width = 1080, height = 720;
  const pixels = Buffer.alloc(height * (width * 3 + 1));
  let seed = 7937;
  for (let y = 0; y < height; y++) {
    const start = y * (width * 3 + 1);
    for (let x = 0; x < width; x++) {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      const noise = (seed >>> 24) - 128;
      const base = 125 + 45 * Math.sin(x / 77) * Math.cos(y / 93);
      for (let c = 0; c < 3; c++) pixels[start + 1 + x * 3 + c] = Math.max(0, Math.min(255, Math.round(base + noise * 0.45 + 26 * Math.sin((x + y * (c + 1)) / (97 + c * 23)))));
    }
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0); header.writeUInt32BE(height, 4);
  header[8] = 8; header[9] = 2; // RGB8, non-interlaced, PNG filter 0.
  return Buffer.concat([pngSignature, chunk("IHDR", header), chunk("IDAT", deflateSync(pixels, { level: 6 })), chunk("IEND", Buffer.alloc(0))]);
}
function decodeRows(lines) {
  return lines.map(line => {
    const pieces = [...line.matchAll(/\x1b_G([^;\x1b]*);([^]*?)\x1b\\/g)];
    check(pieces.length > 0, "row did not contain PNG transmission");
    const fields = Object.fromEntries(pieces[0][1].split(",").map(item => item.split("=")));
    check(fields.a === "T" && fields.r === "1", "expected independent one-row transmission");
    return { png: Buffer.from(pieces.map(piece => piece[2]).join(""), "base64"), columns: Number(fields.c) };
  });
}
// Explicit isolated reconstruction of the old uncompressed Resvg pipeline.
// It must not derive its PNG rows from the current production default.
function candidateRaster(source, columns, rows, density) {
  const rowHeight = 18 * density;
  const width = columns * 9 * density, height = rows * rowHeight;
  const preview = new Resvg(`<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}"><image width="${width}" height="${height}" preserveAspectRatio="xMidYMid meet" href="data:image/png;base64,${source.toString("base64")}"/></svg>`, { font: { loadSystemFonts: false } }).render().asPng().toString("base64");
  return Array.from({ length: rows }, (_, index) => ({ columns, png: new Resvg(`<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${rowHeight}" viewBox="0 0 ${width} ${rowHeight}"><image y="${-index * rowHeight}" width="${width}" height="${height}" href="data:image/png;base64,${preview}"/></svg>`, { font: { loadSystemFonts: false } }).render().asPng() }));
}
function encodeRows(api, rows) {
  return rows.map(row => api.encodeKitty(row.png.toString("base64"), { columns: row.columns, rows: 1, moveCursor: false, imageId: api.allocateImageId() }));
}
function percentile(values, q) { return [...values].sort((a, b) => a - b)[Math.floor((values.length - 1) * q)]; }
function cachedRender(image) {
  for (let i = 0; i < 500; i++) image.render(80);
  const times = [];
  for (let run = 0; run < 5; run++) {
    const cpu = process.cpuUsage();
    for (let i = 0; i < 10000; i++) image.render(80);
    const used = process.cpuUsage(cpu);
    times.push((used.user + used.system) / 10000);
  }
  return percentile(times, 0.5);
}
function scrollFrames(api, renderImage) {
  let writes = [];
  const terminal = { columns: 80, rows: 24, write: data => { writes.push(data); }, hideCursor() {}, showCursor() {} };
  const prefix = Array.from({ length: 6 }, (_, i) => `heading ${i}`);
  const suffix = Array.from({ length: 80 }, (_, i) => `tool output ${i}`);
  const document = { invalidate() {}, render: () => [...prefix, ...renderImage(), ...suffix] };
  const scroll = new api.ScrollView(document, { follow: "none", scrollbar: "hidden" });
  const screen = new api.TuiAltScreen(terminal, false, undefined, { mouse: false });
  screen.stopped = false; screen.altScreenActive = true; screen.imageProtocol = "kitty"; screen.layoutRoot = scroll;
  screen.doRender();
  function measure(offset) {
    const wall = [], cpuTimes = [], bytes = [], uploads = [];
    for (let i = 0; i < FRAME_COUNT + WARMUP; i++) {
      scroll.scrollTo(offset + (i % 2));
      writes = [];
      const cpu = process.cpuUsage();
      const start = performance.now();
      screen.doRender();
      const elapsed = performance.now() - start;
      const used = process.cpuUsage(cpu);
      if (i < WARMUP) continue;
      wall.push(elapsed); cpuTimes.push((used.user + used.system) / 1000);
      // Inspect protocol OUTSIDE timing. The write sink has no xterm/GPU/network.
      bytes.push(writes.reduce((sum, value) => sum + Buffer.byteLength(value), 0));
      uploads.push(writes.reduce((sum, value) => sum + [...value.matchAll(/\x1b_Ga=T(?:,|;)/g)].length, 0));
      check(!writes.some(value => /\x1b_Ga=p(?:,|;)/.test(value)), "unexpected placement-cache reuse");
    }
    return { median: percentile(wall, 0.5), p95: percentile(wall, 0.95), cpu: cpuTimes.reduce((a, b) => a + b, 0) / cpuTimes.length, bytes: bytes.reduce((a, b) => a + b, 0) / bytes.length, uploads: uploads.reduce((a, b) => a + b, 0) / uploads.length };
  }
  try { return { visible: measure(4), offscreen: measure(36) }; }
  finally { screen.stopped = true; writes = []; }
}
async function bundleApi() {
  const chunks = join(host, "dist/bundle/chunks");
  const files = readdirSync(chunks).filter(name => name.endsWith(".js")).filter(name => {
    const source = readFileSync(join(chunks, name), "utf8");
    const exports = source.slice(source.lastIndexOf("export{"));
    return /\bdist_exports\b/.test(exports) && /\bImage\b/.test(exports) && /\bTuiAltScreen\b/.test(exports);
  });
  check(files.length === 1, "cannot identify CLI TUI chunk uniquely");
  const bundle = await import(pathToFileURL(join(chunks, files[0])).href);
  check(bundle.Image === bundle.dist_exports.Image && bundle.Image !== moduleApi.Image, "CLI prototype identity mismatch");
  return bundle.dist_exports;
}

try {
  const fixtures = [["chart/UI", screenshot()], ["noisy/photo", noisyPhoto()]];
  const apis = [["module", moduleApi, false]];
  try { apis.push(["CLI", await bundleApi(), true]); }
  catch { console.log("LIMIT: CLI dist_exports unavailable; module-only benchmark."); }
  console.log(`Pi ${version}; synthetic 1080x720 source; 60 image columns, 20 rows, 9x18 cells; terminal 80x24; ${FRAME_COUNT} measured scroll frames after ${WARMUP} warmups.`);
  console.log("prod-fast=actual 1x+compactPng; prod-sharp=actual 2x+compactPng; isolated-2x/resvg=original uncompressed pipeline, independent of runtime default. Cold=resize+20 crops(+production compression); candidate z6/z9 preparation is additional recompression only. Cached CPU uses 5x10000 calls.");
  console.log("host fixture variant | visible wall median/p95 ms | CPU mean ms | wire KiB/frame | PNGs/frame | offscreen wall ms / KiB | preparation ms");
  for (const [kind, api, bundled] of apis) {
    configure(api);
    const jiti = createJiti(import.meta.url, { fsCache: false, moduleCache: false, alias: { "@earendil-works/pi-tui": tuiEntry }, ...(bundled ? { virtualModules: { "@earendil-works/pi-tui": api } } : {}) });
    const { installOrdinaryImagePatch } = await jiti.import(join(root, "src/ordinary-images.ts"));
    const original = api.Image.prototype.render;
    const patch = installOrdinaryImagePatch();
    check(api.Image.prototype.render !== original, "actual host Image prototype not patched");
    try {
      for (const [fixtureName, source] of fixtures) {
        const twoStart = performance.now();
        const rows2x = candidateRaster(source, 60, 20, 2);
        const cold2x = performance.now() - twoStart;
        const oneStart = performance.now();
        const rows1x = candidateRaster(source, 60, 20, 1);
        const cold1x = performance.now() - oneStart;
        const report = (variant, render, preparation) => {
          const result = scrollFrames(api, render);
          check(result.visible.uploads === 20 && result.offscreen.uploads === 0, "scroll fixture visibility changed");
          console.log(`${kind} ${fixtureName} ${variant} | ${result.visible.median.toFixed(3)}/${result.visible.p95.toFixed(3)} | ${result.visible.cpu.toFixed(3)} | ${(result.visible.bytes / 1024).toFixed(1)} | ${result.visible.uploads} | ${result.offscreen.median.toFixed(3)} / ${(result.offscreen.bytes / 1024).toFixed(1)} | ${preparation.toFixed(1)}`);
        };
        for (const [quality, isolated] of [["fast", rows1x], ["sharp", rows2x]]) {
          patch.setQuality(quality);
          patch.clear();
          check(patch.getStatus().quality === quality, "production quality selector failed");
          const image = new api.Image(source.toString("base64"), "image/png", { fallbackColor: text => text }, { maxWidthCells: 60 });
          const start = performance.now();
          const lines = image.render(80);
          const cold = performance.now() - start;
          check(lines.length === 20 && !patch.getStatus().lastFailure, "production fixture did not produce twenty rows");
          const rows = decodeRows(lines);
          check(rows[0].columns === 60, "production fixture width differs from benchmark assumptions");
          let retained = 0;
          for (let i = 0; i < rows.length; i++) {
            const compressed = recompress(isolated[i].png, 6);
            const expected = compressed.length < isolated[i].png.length ? compressed : isolated[i].png;
            if (expected === isolated[i].png) retained++;
            check(rows[i].png.equals(expected), "production PNG differs from isolated density plus lossless minimum-size z6 candidate");
          }
          console.log(`${kind} ${fixtureName} prod-${quality}: cached CPU ${cachedRender(image).toFixed(2)} us/call; PNG bytes exactly match isolated ${quality === "fast" ? "1x" : "2x"}+min(z6,original), retained originals ${retained}/20; decoded pixels/frame ${quality === "fast" ? 194400 : 777600}.`);
          report(`prod-${quality}`, () => image.render(80), cold);
        }
        for (const [scale, rows, cold] of [["2x", rows2x, cold2x], ["1x", rows1x, cold1x]]) {
          for (const level of [0, 6, 9]) {
            const prepStart = performance.now();
            // Keep the original isolated comparisons unchanged: z6/z9 always
            // re-deflate, whereas production keeps originals if they are smaller.
            const candidateRows = level ? rows.map(row => ({ ...row, png: recompress(row.png, level) })) : rows;
            const lines = encodeRows(api, candidateRows);
            const preparation = level ? performance.now() - prepStart : cold;
            report(`isolated-${scale}/${level ? `z${level}` : "resvg"}`, () => lines, preparation);
          }
        }
        patch.clear();
      }
    } finally { patch.uninstall(); check(api.Image.prototype.render === original, "prototype cleanup failed"); }
  }
  console.log("LIMIT: Node offscreen/mock-write timings only: excludes PTY transfer, VS Code JS/base64/PNG decoding, GPU upload/compositing, real scroll latency and visual quality. Resolution/compression change bytes/pixels, NOT 20 independent PNG uploads/decodes per visible scroll frame. No real codec/photo distribution or byte-budget cache-eviction benchmark.");
} catch {
  console.error("Benchmark failed; upstream details withheld to avoid image payload output.");
  process.exitCode = 1;
} finally {
  for (const [key, value] of Object.entries(oldEnv)) {
    if (value === undefined) delete process.env[key]; else process.env[key] = value;
  }
}
