// Standalone, offline actual-host regression: node scripts/test-ordinary-images.mjs
// PI_MATH_TEST_HOST optionally selects an installed coding-agent package directory.
// No CLI/session startup, installation edits, model calls, or raw image output.
import { createRequire } from "node:module";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Resvg } from "@resvg/resvg-js";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const host = process.env.PI_MATH_TEST_HOST
  ? resolve(process.env.PI_MATH_TEST_HOST)
  : dirname(dirname(fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent"))));
const requireHost = createRequire(join(host, "package.json"));
const { version } = requireHost("./package.json");
const { createJiti } = await import(pathToFileURL(requireHost.resolve("jiti")).href);
const tuiEntry = requireHost.resolve("@earendil-works/pi-tui");
const moduleApi = await import(pathToFileURL(tuiEntry).href);
const environmentKeys = ["TERM_PROGRAM", "PI_IMAGE_PROTOCOL", "TMUX", "STY", "TERM", "WEZTERM_PANE", "KITTY_WINDOW_ID", "GHOSTTY_RESOURCES_DIR", "PI_TUI_DEBUG_REDRAW", "PI_TUI_WRITE_LOG", "PI_MATH_VSCODE_IMAGES", "PI_MATH_IMAGE_QUALITY"];
const savedEnvironment = Object.fromEntries(environmentKeys.map(key => [key, process.env[key]]));
let failures = 0;
let passes = 0;
let stage = "setup";

// Only our own payload-free assertions are printed. Never serialize Error.actual,
// terminal output, cached lines, Jiti stacks, or upstream exception messages.
class CheckFailure extends Error {}
function check(condition, message) {
  if (!condition) throw new CheckFailure(message);
}
function environment() {
  for (const key of environmentKeys) delete process.env[key];
  Object.assign(process.env, { TERM_PROGRAM: "vscode", PI_IMAGE_PROTOCOL: "kitty", TERM: "xterm-256color" });
}
function configure(api) {
  environment();
  api.setCapabilities({ images: "kitty", trueColor: true, hyperlinks: true });
  api.setCellDimensions({ widthPx: 9, heightPx: 18 });
}
async function test(name, fn) {
  stage = name;
  try {
    await fn();
    passes++;
    console.log(`PASS Pi ${version} ${name}`);
  } catch (error) {
    failures++;
    console.error(`FAIL Pi ${version} ${name}: ${error instanceof CheckFailure ? error.message : "upstream exception (details withheld to protect image payloads)"}`);
  }
}
function controls(header) {
  return Object.fromEntries(header.split(",").map(item => item.split("=")));
}
function commands(line) {
  return [...line.matchAll(/\x1b_G([^;\x1b]*)(?:;([^]*?))?\x1b\\/g)]
    .map(match => ({ fields: controls(match[1]), payload: match[2] ?? "" }));
}
function placements(line) {
  return commands(line).filter(({ fields }) => fields.a === "T" || fields.a === "p");
}

// Bounded xterm-like protocol model, not a browser or screenshot test.
// d=a drops DATA as well as tiles; EL/ED erase tiles; last-tile erasure frees
// data. CR/LF, relative/absolute cursor movement, and bottom scrolling are
// modeled so regular mode is not incorrectly treated as absolute-positioned.
class ImageTerminal {
  columns = 80;
  rows = 18;
  row = 1;
  column = 1;
  data = new Set();
  tiles = new Map();
  uploads = 0;
  placementsOnly = 0;
  missingPlacements = 0;
  clearAfterDraw = 0;
  deletesAll = 0;
  pending = undefined;
  drawEpoch = new Set();
  hideCursor() {}
  showCursor() {}
  erase(row) {
    if (this.drawEpoch.has(row) && this.tiles.has(row)) this.clearAfterDraw++;
    const id = this.tiles.get(row);
    this.tiles.delete(row);
    if (id !== undefined && ![...this.tiles.values()].includes(id)) this.data.delete(id);
  }
  newline() {
    if (this.row < this.rows) { this.row++; return; }
    this.erase(1);
    this.tiles = new Map([...this.tiles].filter(([row]) => row > 1).map(([row, id]) => [row - 1, id]));
    this.drawEpoch = new Set([...this.drawEpoch].filter(row => row > 1).map(row => row - 1));
  }
  place(fields) {
    const id = Number(fields.i);
    if (!this.data.has(id)) { this.missingPlacements++; return; }
    for (let row = this.row; row < Math.min(this.rows + 1, this.row + Number(fields.r || 1)); row++) {
      this.tiles.set(row, id);
      this.drawEpoch.add(row);
    }
  }
  kitty(fields, payload) {
    const id = Number(fields.i);
    if (fields.a === "d") {
      if (fields.d?.toLowerCase() === "a") {
        this.tiles.clear(); this.data.clear(); this.deletesAll++;
      } else if (fields.d?.toLowerCase() === "i") {
        this.data.delete(id);
        for (const [row, value] of this.tiles) if (value === id) this.tiles.delete(row);
      }
    } else if (fields.a === "p") {
      this.placementsOnly++;
      this.place(fields);
    } else if (fields.a === "T" || fields.a === "t") {
      // Chunk continuations have no a/i. Count/upload only once fully received.
      this.pending = { fields, payload };
      if (fields.m !== "1") this.finishUpload();
    } else if (this.pending && fields.m !== undefined) {
      this.pending.payload += payload;
      if (fields.m !== "1") this.finishUpload();
    }
  }
  finishUpload() {
    const { fields, payload } = this.pending;
    const png = Buffer.from(payload, "base64");
    check(fields.f === "100" && png.length >= 24 && png.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])), "transmission is not a complete PNG");
    this.data.add(Number(fields.i));
    this.uploads++;
    this.pending = undefined;
    if (fields.a === "T") this.place(fields);
  }
  write = output => {
    const token = /\x1b_G([^;\x1b]*)(?:;([^]*?))?\x1b\\|\x1b\[([0-?]*)([ -/]*)([@-~])|\x1b\][^]*?(?:\x07|\x1b\\)|\r|\n|[^\x1b\r\n]+/g;
    for (const match of output.matchAll(token)) {
      if (match[1] !== undefined) { this.kitty(controls(match[1]), match[2] ?? ""); continue; }
      if (match[3] !== undefined) {
        const args = match[3].split(";").map(Number);
        const n = args[0] || 1;
        switch (match[5]) {
          case "H": case "f": this.row = n; this.column = args[1] || 1; break;
          case "A": this.row = Math.max(1, this.row - n); break;
          case "B": this.row = Math.min(this.rows, this.row + n); break;
          case "G": this.column = n; break;
          case "C": this.column += n; break;
          case "D": this.column = Math.max(1, this.column - n); break;
          case "K": this.erase(this.row); break;
          case "J":
            // ED 3 clears scrollback, not visible tiles.
            if (args[0] !== 3) for (const row of [...this.tiles.keys()]) {
              if (args[0] === 2 || (args[0] === 1 ? row <= this.row : row >= this.row)) this.erase(row);
            }
            break;
        }
      } else if (match[0] === "\r") this.column = 1;
      else if (match[0] === "\n") this.newline();
      else if (!match[0].startsWith("\x1b")) this.column += match[0].length;
    }
  };
}

function png(rows) {
  const colors = ["#e53935", "#43a047", "#1e88e5", "#fdd835", "#8e24aa", "#00acc1"];
  const bands = Array.from({ length: rows }, (_, i) => `<rect y="${i * 18}" width="108" height="18" fill="${colors[i % colors.length]}"/>`).join("");
  return new Resvg(`<svg xmlns="http://www.w3.org/2000/svg" width="108" height="${rows * 18}">${bands}</svg>`, { font: { loadSystemFonts: false } }).render().asPng().toString("base64");
}
const tallPng = png(6);
const shortPng = png(1);
function makeImage(api, rows = 6) {
  return new api.Image(rows === 1 ? shortPng : tallPng, "image/png", { fallbackColor: text => text }, { maxWidthCells: 12, maxHeightCells: rows });
}
function rowIds(lines) {
  return lines.flatMap(line => placements(line).map(({ fields }) => Number(fields.i)));
}
function assertRowImages(api, lines, rows) {
  check(lines.length === rows, `expected ${rows} reserved image rows, got ${lines.length}`);
  const ids = [];
  for (const line of lines) {
    const items = placements(line);
    check(items.length === 1, "each reserved row must contain an independent image");
    const { fields } = items[0];
    check(fields.a === "T" && fields.r === "1", "row must transmit PNG with a=T,r=1, never a=p");
    check(Number(fields.i) > 0, "row must have a positive image ID");
    ids.push(Number(fields.i));
    const payload = commands(line).map(item => item.payload).join("");
    const dimensions = api.getPngDimensions(payload);
    check(Boolean(dimensions?.widthPx && dimensions?.heightPx), "row payload must have valid PNG dimensions");
  }
  check(new Set(ids).size === rows, "independent rows must use distinct IDs");
}
function fixture(api, mode, imageRows, scrolling = false, suppliedImage) {
  const terminal = new ImageTerminal();
  const image = suppliedImage ?? makeImage(api, imageRows);
  const state = { prefix: ["before"], suffix: ["tool output"], visible: true, formula: [] };
  let lines = [];
  const document = { invalidate() {}, render(width) {
    lines = [...state.prefix, ...(state.visible ? image.render(width) : []), ...state.formula, ...state.suffix];
    return lines;
  } };
  const screen = new (mode === "fullscreen" ? api.TuiAltScreen : api.TuiMainScreen)(terminal, false, undefined, { mouse: false });
  screen.stopped = false;
  let scroll;
  if (mode === "fullscreen") {
    screen.altScreenActive = true;
    screen.imageProtocol = "kitty";
    scroll = scrolling ? new api.ScrollView(document, { scrollbar: "hidden", follow: "none" }) : undefined;
    screen.layoutRoot = scroll ?? document;
  } else screen.addChild(document);
  function render(label, verify = true) {
    terminal.drawEpoch.clear();
    screen.doRender();
    if (!verify) return;
    let viewport = scroll ? lines.slice(scroll.scrollTop, scroll.scrollTop + terminal.rows) : lines.slice(-terminal.rows);
    const expected = new Map();
    viewport.forEach((line, i) => placements(line).forEach(({ fields }) => expected.set(i + 1, Number(fields.i))));
    check(terminal.tiles.size === expected.size, `${label}: expected ${expected.size} visible image tiles, got ${terminal.tiles.size}`);
    for (const [row, id] of expected) check(terminal.tiles.get(row) === id, `${label}: wrong or missing image tile on terminal row ${row}`);
    check(terminal.missingPlacements === 0, `${label}: a=p referenced deleted image data`);
    check(terminal.placementsOnly === 0, `${label}: host converted row transmission to a=p`);
    if (mode === "fullscreen") check(terminal.clearAfterDraw === 0, `${label}: a later row clear erased a tile drawn in this frame`);
    check(!terminal.pending, `${label}: incomplete PNG transmission`);
  }
  return { terminal, image, state, screen, scroll, render, stop: () => { screen.stopped = true; } };
}

async function probeBundle() {
  // Import ONLY the actual exported TUI chunk, not cli.js/main/virtual-modules
  // (the latter imports the entire agent). No source copying or host patching.
  const chunks = join(host, "dist/bundle/chunks");
  const candidates = readdirSync(chunks).filter(name => name.endsWith(".js")).filter(name => {
    const source = readFileSync(join(chunks, name), "utf8");
    const exports = source.slice(source.lastIndexOf("export{"));
    return /\bdist_exports\b/.test(exports) && /\bImage\b/.test(exports) && /\bTuiAltScreen\b/.test(exports);
  });
  check(candidates.length === 1, "CLI TUI chunk could not be identified uniquely");
  const bundle = await import(pathToFileURL(join(chunks, candidates[0])).href);
  const api = bundle.dist_exports;
  check(api?.Image === bundle.Image && api.TuiAltScreen === bundle.TuiAltScreen, "dist_exports and actual CLI classes must have identical prototypes");
  check(api.Image !== moduleApi.Image, "expected independently bundled and module Image constructors");
  return { api, bundle };
}

async function suite(kind, api, bundle) {
  const jiti = createJiti(import.meta.url, {
    fsCache: false,
    moduleCache: false,
    alias: { "@earendil-works/pi-tui": tuiEntry, "@earendil-works/pi-coding-agent": join(host, "dist/index.js") },
    // Match Pi's bundled extension loader: dist_exports supplies the runtime
    // module. Aliasing only to node_modules would test the WRONG prototype.
    ...(bundle ? { virtualModules: { "@earendil-works/pi-tui": api } } : {}),
  });
  const { installOrdinaryImagePatch } = await jiti.import(join(root, "src/ordinary-images.ts"));
  const original = api.Image.prototype.render;
  const imageInternals = bundle ? undefined : await import(pathToFileURL(join(dirname(tuiEntry), "terminal-image.js")).href);
  async function patched(name, fn) {
    await test(`${kind}: ${name}`, async () => {
      configure(api);
      const controller = installOrdinaryImagePatch();
      try {
        check(api.Image.prototype.render !== original, "patch did not wrap actual host Image.prototype.render");
        if (bundle) check(bundle.Image.prototype.render === api.Image.prototype.render && moduleApi.Image.prototype.render !== api.Image.prototype.render, "CLI prototype identity mismatch");
        await fn(controller);
      } finally {
        controller.uninstall();
        check(api.Image.prototype.render === original, "uninstall did not restore actual host prototype");
      }
    });
  }

  await test(`${kind}: model negative controls and unpatched regression`, () => {
    configure(api);
    const terminal = new ImageTerminal();
    const line = makeImage(api).render(80)[0];
    terminal.write(line);
    check(terminal.tiles.size === 6, "negative control needs a six-row baseline image");
    terminal.write("\x1b[2;1H\x1b[2K");
    check(terminal.tiles.size === 5 && terminal.clearAfterDraw === 1, "model must erase later-cleared tiles");
    terminal.write("\x1b_Ga=d,d=a\x1b\\");
    check(terminal.data.size === 0 && terminal.tiles.size === 0, "model must delete uploaded data on d=a");
    terminal.write(`\x1b_Ga=p,i=${rowIds([line])[0]},r=6\x1b\\`);
    check(terminal.missingPlacements === 1, "model must reject placements after d=a");
    const f = fixture(api, "fullscreen", 6);
    try {
      f.render("baseline", false);
      check(f.terminal.tiles.size < 6, "unpatched fullscreen no longer reproduces clipping; update regression assumptions");
    } finally { f.stop(); }
  });

  await patched("row protocol, stable fresh IDs, placement-cache exclusion", controller => {
    for (const rows of [6, 1]) {
      const image = makeImage(api, rows);
      const lines = image.render(80);
      assertRowImages(api, lines, rows);
      const ids = rowIds(lines);
      check(!ids.includes(image.getImageId()), "row ID must differ from delegate's registered image ID");
      check(JSON.stringify(image.render(80)) === JSON.stringify(lines), "unchanged render must keep row IDs and bytes stable");
      image.invalidate();
      check(JSON.stringify(rowIds(image.render(80))) === JSON.stringify(ids), "invalidation of unchanged content must preserve row IDs");
      if (imageInternals) for (const line of lines) {
        check(imageInternals.getKittyImagePlacement(line) === undefined, "new row ID was registered in Pi's placement cache");
      }
      // Independent replay after xterm deletes its entire image store, including
      // the single-row case that can accidentally reuse the delegate's ID.
      const terminal = new ImageTerminal();
      const replay = () => lines.forEach((line, index) => terminal.write(`\x1b[${index + 1};1H${line}`));
      replay();
      terminal.write("\x1b_Ga=d,d=a\x1b\\");
      replay();
      check(terminal.tiles.size === rows && terminal.missingPlacements === 0, "row replay after d=a lost image data");
    }
    const status = controller.getStatus();
    check(status.cacheSize > 0 && status.cacheBytes > 0 && !status.lastFailure, "successful conversion should report populated cache and no failure");
    controller.clear();
    check(controller.getStatus().cacheSize === 0 && controller.getStatus().cacheBytes === 0, "clear must release cached rows and bytes");
  });

  await patched("cache entry eviction regenerates independently transmitted rows", controller => {
    const first = makeImage(api, 1);
    const firstIds = rowIds(first.render(80));
    for (let i = 0; i < 129; i++) assertRowImages(api, makeImage(api, 1).render(80), 1);
    const status = controller.getStatus();
    check(status.cacheSize === 128 && status.cacheBytes > 0 && status.cacheBytes <= 32 * 1024 * 1024, "row cache must obey entry and retained-byte bounds");
    const regenerated = first.render(80);
    assertRowImages(api, regenerated, 1);
    check(!rowIds(regenerated).some(id => firstIds.includes(id)), "evicted row raster should get a fresh ID on regeneration");
    if (imageInternals) check(imageInternals.getKittyImagePlacement(regenerated[0]) === undefined, "eviction regeneration registered a placement-cache ID");
    const terminal = new ImageTerminal();
    terminal.write(regenerated[0]);
    terminal.write("\x1b_Ga=d,d=a\x1b\\");
    terminal.write(regenerated[0]);
    check(terminal.tiles.size === 1 && terminal.missingPlacements === 0, "regenerated image failed after d=a");
  });

  await test(`${kind}: source, cell and preview limits fail back to delegate`, () => {
    configure(api);
    let native = [];
    api.Image.prototype.render = () => native;
    const controller = installOrdinaryImagePatch();
    try {
      const image = makeImage(api);
      const tooLarge = Buffer.from(tallPng, "base64");
      // Only modify IHDR for a cheap pre-decode guard test, not a real huge PNG.
      tooLarge.writeUInt32BE(8192, 16);
      tooLarge.writeUInt32BE(8192, 20);
      native = [api.encodeKitty(tooLarge.toString("base64"), { columns: 12, rows: 1, moveCursor: false, imageId: api.allocateImageId() })];
      check(image.render(80) === native && /32 megapixel/.test(controller.getStatus().lastFailure ?? ""), "oversized source dimensions must fail before raster decoding");
      native = [api.encodeKitty(tallPng, { columns: 257, rows: 1, moveCursor: false, imageId: api.allocateImageId() })];
      check(image.render(80) === native && /cell dimensions/.test(controller.getStatus().lastFailure ?? ""), "unsupported column count must preserve delegate output");
      native = [api.encodeKitty(tallPng, { columns: 12, rows: 1, moveCursor: false, imageId: api.allocateImageId() })];
      api.setCellDimensions({ widthPx: 1024, heightPx: 1024 });
      check(image.render(80) === native && /4 megapixel/.test(controller.getStatus().lastFailure ?? ""), "oversized preview must fail before raster allocation");
      api.setCellDimensions({ widthPx: 9, heightPx: 18 });
      native = ["\x1b_G" + "A".repeat(32 * 1024 * 1024)];
      check(image.render(80) === native && /32 MiB input/.test(controller.getStatus().lastFailure ?? ""), "oversized sequence must preserve delegate output");
      controller.clear();
      check(controller.getStatus().cacheBytes === 0 && !controller.getStatus().lastFailure, "clear must release failure cache and status");
    } finally {
      controller.uninstall();
      api.Image.prototype.render = original;
    }
  });

  await patched("fast/sharp switching preserves layout and within-mode stable IDs", controller => {
    check(controller.getStatus().quality === "fast", "default quality must be fast");
    const f = fixture(api, "fullscreen", 6);
    try {
      let previousIds = [];
      for (const quality of ["fast", "sharp", "fast"]) {
        controller.setQuality(quality);
        check(controller.getStatus().cacheSize === 0 && controller.getStatus().cacheBytes === 0, "quality change must clear raster cache");
        const lines = f.image.render(80);
        assertRowImages(api, lines, 6);
        const dimensions = api.getPngDimensions(commands(lines[0]).map(item => item.payload).join(""));
        check(dimensions.widthPx === (quality === "fast" ? 108 : 216) && dimensions.heightPx === (quality === "fast" ? 18 : 36), "quality changed cell layout or selected wrong pixel density");
        check(!rowIds(lines).some(id => previousIds.includes(id)), "quality switch must generate new row IDs");
        const snapshot = JSON.stringify(controller.getStatus());
        controller.setQuality(quality);
        check(JSON.stringify(controller.getStatus()) === snapshot && f.image.render(80) === lines, "same quality must be a no-op preserving cache and IDs");
        f.image.invalidate();
        check(f.image.render(80) === lines, "native invalidation must retain stable cached rows within quality");
        f.render(`${quality} quality frame`);
        f.state.prefix.unshift("quality redraw"); f.render(`${quality} moved after deletion`);
        previousIds = rowIds(lines);
      }
    } finally { f.stop(); }
  });
  await test(`${kind}: PI_MATH_IMAGE_QUALITY=sharp startup override`, () => {
    configure(api);
    process.env.PI_MATH_IMAGE_QUALITY = "sharp";
    const controller = installOrdinaryImagePatch();
    try {
      check(controller.getStatus().quality === "sharp", "sharp startup override not reflected in status");
      const image = makeImage(api, 1);
      const lines = image.render(80);
      assertRowImages(api, lines, 1);
      const dimensions = api.getPngDimensions(commands(lines[0]).map(item => item.payload).join(""));
      check(dimensions.heightPx === 36, "startup sharp must generate 2x single-row PNG");
      controller.setQuality("sharp");
      check(image.render(80) === lines, "same startup quality changed cached single-row ID");
    } finally { controller.uninstall(); delete process.env.PI_MATH_IMAGE_QUALITY; }
  });

  await patched("cell-dimension change invalidates row raster cache", () => {
    const image = makeImage(api);
    const first = image.render(80);
    api.setCellDimensions({ widthPx: 12, heightPx: 24 });
    const second = image.render(80);
    assertRowImages(api, second, 6);
    check(!rowIds(second).some(id => rowIds(first).includes(id)), "changed cell dimensions must allocate fresh row images");
    const dimensions = api.getPngDimensions(commands(second[0]).map(item => item.payload).join(""));
    check(dimensions.heightPx === 24, "default fast raster did not use changed cell height at 1x preview density");
    check(JSON.stringify(second) === JSON.stringify(image.render(80)), "new cell-dimension raster must remain stable");
    api.setCellDimensions({ widthPx: 9, heightPx: 18 });
  });

  if (typeof api.setImageTranscoder !== "function") {
    console.warn(`LIMIT Pi ${version} ${kind}: host has no setImageTranscoder; JPEG/WebP/GIF delegate-conversion test skipped.`);
  } else {
    await patched("JPEG/WebP/GIF delegate conversion, dimensions, caching and redraw", () => {
      let conversions = 0;
      const seenMimes = [];
      // This is a converter spy, not a JPEG/WebP/GIF codec test. Its known PNG
      // has a different aspect ratio from supplied source dimensions, proving
      // the adapter uses the actual delegate's converted PNG and placement.
      api.setImageTranscoder((data, mime) => {
        check(data === Buffer.from(`synthetic ${mime}`).toString("base64"), "delegate changed source data before conversion");
        conversions++;
        seenMimes.push(mime);
        return tallPng;
      });
      try {
        for (const mime of ["image/jpeg", "image/webp", "image/gif"]) {
          const source = Buffer.from(`synthetic ${mime}`).toString("base64");
          for (const mode of ["fullscreen", "regular"]) {
            const image = new api.Image(source, mime, { fallbackColor: text => text }, { maxWidthCells: 12, maxHeightCells: 6 }, { widthPx: 1080, heightPx: 18 });
            assertRowImages(api, image.render(80), 6);
            const f = fixture(api, mode, 6, false, image);
            try {
              f.render(`${mime} initial`);
              f.state.prefix.unshift("next tool"); f.render(`${mime} moved`);
              f.terminal.columns = 10; f.render(`${mime} narrow`);
              f.terminal.columns = 80; f.render(`${mime} restored`);
              f.state.visible = false; f.render(`${mime} hidden`);
              f.state.visible = true; f.render(`${mime} shown`);
            } finally { f.stop(); }
          }
        }
        check(conversions === 3 && new Set(seenMimes).size === 3, "host should convert each source once, retaining its PNG conversion cache");
      } finally { api.setImageTranscoder(undefined); }
    });
  }

  for (const mode of ["fullscreen", "regular"]) for (const rows of [6, 1]) {
    await patched(`${mode}, ${rows} rows: redraw, tool output, move, resize, hide/restore`, () => {
      const f = fixture(api, mode, rows);
      try {
        f.render("initial");
        if (mode === "fullscreen") check(f.screen.uploadedKittyImages.size === 0, "ordinary rows leaked into fullscreen upload/placement cache");
        const uploads = f.terminal.uploads;
        f.render("unchanged");
        check(f.terminal.uploads === uploads, "unchanged frame should not re-upload rows");
        f.state.suffix.push("unrelated tool result"); f.render("unrelated tool output");
        if (mode === "fullscreen") check(f.terminal.uploads === uploads, "unrelated tool text should remain incremental");
        f.state.prefix.unshift("next tool call"); f.render("move / next tool");
        check(f.terminal.uploads > uploads, "moved image must re-upload");
        f.terminal.columns = 10; f.render("narrow resize");
        f.terminal.columns = 80; f.render("width restore");
        f.terminal.rows = 14; f.render("height resize");
        f.state.visible = false; f.render("hidden");
        f.state.visible = true; f.render("restored");
      } finally { f.stop(); }
    });
  }

  await patched("fullscreen real ScrollView: clipping, offscreen, restore", () => {
    const f = fixture(api, "fullscreen", 6, true);
    f.state.suffix = Array.from({ length: 30 }, (_, i) => `tool output ${i}`);
    try {
      f.render("initial scroll viewport");
      f.scroll.scrollTo(3); f.render("top-clipped image");
      check(f.terminal.tiles.size === 4, "top clipping must retain all four remaining rows");
      f.scroll.scrollTo(12); f.render("fully offscreen");
      check(f.terminal.tiles.size === 0, "offscreen image must leave no stale tiles");
      f.scroll.scrollToStart(); f.render("scroll restored");
      f.terminal.rows = 4; f.render("bottom-clipped image");
      check(f.terminal.tiles.size === 3, "bottom clipping must retain three independent rows");
      f.terminal.rows = 18; f.render("viewport restored");
    } finally { f.stop(); }
  });

  for (const [key, value] of [["TERM_PROGRAM", "wezterm"], ["TMUX", "test"], ["STY", "test"], ["TERM", "screen-256color"], ["TERM", "tmux-256color"]]) {
    await patched(`environment gate ${key}=${value}`, () => {
      process.env[key] = value;
      check(placements(makeImage(api).render(80)[0])[0]?.fields.r === "6", `${key} gate must preserve delegate rendering`);
    });
  }
  await patched("disabled capabilities remain disabled", () => {
    api.setCapabilities({ images: null, trueColor: true, hyperlinks: true });
    delete process.env.PI_IMAGE_PROTOCOL;
    check(rowIds(makeImage(api).render(80)).length === 0, "patch must not activate image capabilities");
    check(api.getCapabilities().images === null, "patch changed disabled host capabilities");
  });
  await patched("enable/disable/rearm lifecycle", controller => {
    check(controller.isEnabled(), "controller should initially be enabled");
    controller.setEnabled(false);
    check(!controller.isEnabled() && placements(makeImage(api).render(80)[0])[0]?.fields.r === "6", "disabled patch must delegate unchanged");
    controller.setEnabled(true);
    let calls = 0;
    api.Image.prototype.render = function (width) { calls++; return original.call(this, width); };
    controller.rearm();
    assertRowImages(api, makeImage(api).render(80), 6);
    check(calls === 1, "rearm must adopt a later prototype delegate");
    // This intentional replacement belongs to this test; restore before outer cleanup.
    controller.uninstall();
    api.Image.prototype.render = original;
  });

  await patched("coexistence with formula Markdown patch", async controller => {
    const { createTerminalMathRenderer } = await jiti.import(join(root, "src/renderer.ts"));
    const { installMarkdownMathPatch } = await jiti.import(join(root, "src/markdown-patch.ts"));
    const themeApi = bundle ?? await import(pathToFileURL(join(host, "dist/index.js")).href);
    themeApi.initTheme("dark", false);
    const renderer = await createTerminalMathRenderer();
    const mathPatch = installMarkdownMathPatch(renderer);
    const f = fixture(api, "fullscreen", 6);
    try {
      const markdown = new api.Markdown(String.raw`$$\frac{a+b}{c+d}$$

Inline $x+1$.

$$x$$`, 0, 0, themeApi.getMarkdownTheme());
      f.terminal.rows = 30;
      f.state.formula = markdown.render(80);
      const formulaIds = rowIds(f.state.formula);
      check(formulaIds.length > 1, "formula must exercise multiple image rows on the same host");
      check(!formulaIds.some(id => rowIds(f.image.render(80)).includes(id)), "ordinary and formula image IDs collide");
      check(f.state.formula.some(line => line.includes("Inline") && placements(line).some(({ fields }) => fields.r === "1")), "coexistence fixture must include an inline one-row formula");
      // Formula-only redraw is now a regression assertion, not a known failure.
      const formulaOnly = fixture(api, "fullscreen", 6);
      try {
        formulaOnly.state.visible = false;
        formulaOnly.state.formula = f.state.formula;
        formulaOnly.render("formula-only initial");
        formulaOnly.state.prefix.unshift("another tool");
        formulaOnly.render("formula-only moved");
        check(formulaOnly.terminal.deletesAll > 0, "formula movement must exercise deletion followed by re-upload");
      } finally { formulaOnly.stop(); }
      f.render("ordinary plus formula");
      f.state.prefix.unshift("another tool"); f.render("ordinary plus formula moved");
      f.state.suffix.push("unrelated text"); f.render("ordinary plus formula text update");
      const formulaSnapshot = JSON.stringify(f.state.formula);
      controller.setQuality("sharp");
      markdown.invalidate();
      f.state.formula = markdown.render(80);
      check(JSON.stringify(f.state.formula) === formulaSnapshot, "ordinary quality switch changed formula raster or IDs");
      f.render("sharp ordinary plus unchanged formula");
    } finally { f.stop(); mathPatch.uninstall(); renderer.clear(); }
  });
}

try {
  let bundled;
  try { bundled = await probeBundle(); }
  catch {
    console.warn(`LIMIT Pi ${version}: CLI TUI dist_exports probe unavailable; module-only results cannot establish CLI compatibility.`);
    failures++; // Do not silently pass a module-only regression run.
  }
  await suite("module host", moduleApi);
  if (bundled) await suite("CLI bundle dist_exports", bundled.api, bundled.bundle);
} catch (error) {
  failures++;
  console.error(`FAIL Pi ${version} ${stage}: ${error instanceof CheckFailure ? error.message : "setup/import exception (details withheld to protect image payloads)"}`);
} finally {
  for (const [key, value] of Object.entries(savedEnvironment)) {
    if (value === undefined) delete process.env[key]; else process.env[key] = value;
  }
}
console.log(`Pi ${version}: ${passes} passed, ${failures} failed. Protocol model only; no real VS Code/browser, screenshots, terminal reflow, or regular-mode scrollback restoration verified.`);
process.exitCode = failures ? 1 : 0;
