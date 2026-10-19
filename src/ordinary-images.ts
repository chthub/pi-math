import { createHash } from "node:crypto";
import { Resvg } from "@resvg/resvg-js";
import {
  Image,
  allocateImageId,
  encodeKitty,
  getCapabilities,
  getCellDimensions,
  getPngDimensions,
} from "@earendil-works/pi-tui";
import { WeightedLruCache } from "./lru-cache.js";
import { compactPng } from "./compact-png.js";
import { splitFormulaRasterRows, usesRowImages } from "./raster-rows.js";

const MAX_SEQUENCE_CHARS = 32 * 1024 * 1024;
const MAX_SOURCE_PIXELS = 32 * 1024 * 1024;
const MAX_PREVIEW_PIXELS = 4 * 1024 * 1024;
const MAX_CACHE_BYTES = 32 * 1024 * 1024;
const MAX_ROWS = 128;
const MAX_COLUMNS = 256;
type ImageRender = (this: Image, width: number) => string[];
interface CacheEntry { lines?: string[]; failure?: string }
interface NativeImage { data: string; columns: number; rows: number }

export type OrdinaryImageQuality = "fast" | "sharp";

export interface OrdinaryImagePatchController {
  isEnabled(): boolean;
  setEnabled(value: boolean): void;
  setQuality(value: OrdinaryImageQuality): void;
  /** Full host-prepared PNG, before terminal-density downscaling; decoded only on explicit open. */
  getImageForOpening(image: Image): { data: string; columns: number; rows: number } | undefined;
  getLatestImageForOpening(): { data: string; columns: number; rows: number } | undefined;
  clear(): void;
  rearm(): void;
  uninstall(): void;
  getStatus(): { quality: OrdinaryImageQuality; cacheSize: number; cacheBytes: number; lastFailure?: string };
}

/** Protocol selection remains the user's decision; never override Pi settings. */
export function ordinaryImageCompatibilityAvailable(): boolean {
  const term = process.env.TERM?.toLowerCase() ?? "";
  return usesRowImages() && !process.env.TMUX && !process.env.STY && !term.startsWith("tmux") && !term.startsWith("screen")
    && getCapabilities().images === "kitty";
}

/** Only accept the stock Image component's direct PNG transmission, not custom placements. */
function decodeNativeImage(lines: string[]): NativeImage | undefined {
  const sequence = lines[0];
  if (!sequence?.startsWith("\x1b_G") || lines.slice(1).some(line => line !== "")) return undefined;
  if (sequence.length > MAX_SEQUENCE_CHARS) throw new Error("Image exceeds the 32 MiB input limit");
  let offset = 0;
  let first = true;
  let columns = 0;
  let rows = 0;
  const payloads: string[] = [];
  while (offset < sequence.length) {
    if (!sequence.startsWith("\x1b_G", offset)) return undefined;
    const start = offset + 3;
    const separator = sequence.indexOf(";", start);
    const end = sequence.indexOf("\x1b\\", start);
    if (separator < start || end < separator) return undefined;
    const parts = sequence.slice(start, separator).split(",");
    const controls: Record<string, string> = {};
    for (const part of parts) {
      const [key, value, extra] = part.split("=");
      if (!key || value === undefined || extra !== undefined || key in controls) return undefined;
      controls[key] = value;
    }
    const allowed = first ? ["a", "f", "q", "C", "c", "r", "i", "m"] : ["m", "q"];
    if (Object.keys(controls).some(key => !allowed.includes(key))) return undefined;
    if (first) {
      if (controls.a !== "T" || controls.f !== "100" || controls.C !== "1") return undefined;
      columns = Number(controls.c);
      rows = Number(controls.r);
      if (!Number.isInteger(columns) || columns < 1 || columns > MAX_COLUMNS
        || !Number.isInteger(rows) || rows < 1 || rows > MAX_ROWS || rows !== lines.length) {
        throw new Error("Image preview exceeds supported cell dimensions");
      }
    }
    const payload = sequence.slice(separator + 1, end);
    if (!/^[A-Za-z0-9+/=]+$/u.test(payload)) return undefined;
    payloads.push(payload);
    offset = end + 2;
    if (offset < sequence.length ? controls.m !== "1" : controls.m !== undefined && controls.m !== "0") return undefined;
    first = false;
  }
  return { data: payloads.join(""), columns, rows };
}

function makeRows(image: NativeImage, quality: OrdinaryImageQuality): string[] {
  const dimensions = getPngDimensions(image.data);
  if (!dimensions || dimensions.widthPx < 1 || dimensions.heightPx < 1
    || dimensions.widthPx * dimensions.heightPx > MAX_SOURCE_PIXELS) {
    throw new Error("Invalid PNG or image exceeds the 32 megapixel decode limit");
  }
  const cell = getCellDimensions();
  // Use native cell resolution by default: 2x means 4x as many pixels to send/decode
  // on EVERY visible scroll frame. Sharp mode preserves the previous 2x preview.
  // Neither mode changes terminal cell layout or model/session data.
  const density = quality === "sharp" ? 2 : 1;
  const widthPx = Math.ceil(image.columns * cell.widthPx * density);
  const heightPx = Math.ceil(image.rows * cell.heightPx * density);
  if (!Number.isSafeInteger(widthPx) || !Number.isSafeInteger(heightPx) || widthPx < 1
    || heightPx < image.rows || widthPx * heightPx > MAX_PREVIEW_PIXELS) {
    throw new Error("Invalid cell dimensions or preview exceeds the 4 megapixel limit");
  }
  // The payload is strictly base64-validated, so no SVG markup or external resources can be injected.
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${widthPx}" height="${heightPx}"><image width="${widthPx}" height="${heightPx}" preserveAspectRatio="xMidYMid meet" href="data:image/png;base64,${image.data}"/></svg>`;
  const preview = new Resvg(svg, { font: { loadSystemFonts: false }, logLevel: "error" }).render();
  const rows = splitFormulaRasterRows({
    base64Data: preview.asPng().toString("base64"), widthPx, heightPx,
    columns: image.columns, rows: image.rows,
  });
  // Compression happens once per cached raster, never on a cached scroll frame.
  return rows.map(row => encodeKitty(compactPng(Buffer.from(row.base64Data, "base64")).toString("base64"), {
    columns: image.columns, rows: 1, moveCursor: false,
    // All IDs must be fresh, including the first row and single-row pictures.
    // Do NOT use renderImage(): its metadata enables Pi's a=p upload cache,
    // which fails after VS Code treats d=a as deletion of the image DATA too.
    imageId: allocateImageId(),
  }));
}

/** Reversible runtime adapter: no private Image fields, core writes, or model/message changes. */
export function installOrdinaryImagePatch(): OrdinaryImagePatchController {
  let enabled = process.env.PI_MATH_VSCODE_IMAGES !== "0";
  let quality: OrdinaryImageQuality = process.env.PI_MATH_IMAGE_QUALITY === "sharp" ? "sharp" : "fast";
  let installed = true;
  let lastFailure: string | undefined;
  const cache = new WeightedLruCache<CacheEntry>(128, MAX_CACHE_BYTES);
  let keys = new WeakMap<string[], { cellKey: string; key: string }>();
  let processed = new WeakSet<string[]>();
  let openingSources = new WeakMap<Image, string[]>();
  let latestImage: WeakRef<Image> | undefined;
  const delegates = new Map<ImageRender, ImageRender>();
  const clear = () => {
    cache.clear();
    keys = new WeakMap();
    processed = new WeakSet();
    openingSources = new WeakMap();
    latestImage = undefined;
    lastFailure = undefined;
  };
  const wrap = (delegate: ImageRender): ImageRender => {
    const wrapped = function (this: Image, width: number): string[] {
      const native = delegate.call(this, width);
      if (!installed || !enabled || !ordinaryImageCompatibilityAvailable() || processed.has(native)) return native;
      const sequence = native[0];
      if (!sequence?.startsWith("\x1b_G")) return native;
      // Retain only a weak association to the native cached lines, not another PNG copy.
      // No files, decoding, IPC or processes are involved while rendering/scrolling.
      openingSources.set(this, native);
      if (latestImage?.deref() !== this) latestImage = new WeakRef(this);
      if (sequence.length > MAX_SEQUENCE_CHARS) {
        lastFailure = "Image exceeds the 32 MiB input limit; using native renderer";
        return native;
      }
      const cell = getCellDimensions();
      const cellKey = `${cell.widthPx}:${cell.heightPx}:${quality}`;
      let identity = keys.get(native);
      if (!identity || identity.cellKey !== cellKey) {
        identity = { cellKey, key: createHash("sha256").update(JSON.stringify(native)).update(cellKey).digest("hex") };
        keys.set(native, identity);
      }
      const cached = cache.get(identity.key);
      if (cached) {
        lastFailure = cached.failure;
        return cached.lines ?? native;
      }
      try {
        const image = decodeNativeImage(native);
        if (!image) {
          cache.set(identity.key, {}, 128);
          return native; // An unfamiliar/custom encoding is someone else's renderer.
        }
        const lines = makeRows(image, quality);
        const bytes = lines.reduce((sum, line) => sum + line.length * 2, 128);
        if (bytes > MAX_CACHE_BYTES) throw new Error("Image row data exceeds the 32 MiB cache limit");
        processed.add(lines);
        cache.set(identity.key, { lines }, bytes);
        lastFailure = undefined;
        return lines;
      } catch (error) {
        lastFailure = `${error instanceof Error ? error.message : String(error)}; using native renderer`;
        cache.set(identity.key, { failure: lastFailure }, 128 + lastFailure.length * 2);
        return native;
      }
    };
    delegates.set(wrapped, delegate);
    return wrapped;
  };
  Image.prototype.render = wrap(Image.prototype.render);
  const getImageForOpening = (image: Image) => {
    if (!installed || !enabled || !ordinaryImageCompatibilityAvailable()) return undefined;
    const native = openingSources.get(image);
    if (!native) return undefined;
    try { return decodeNativeImage(native); }
    catch { return undefined; }
  };
  return {
    isEnabled: () => enabled,
    setEnabled(value) { enabled = value; },
    setQuality(value) {
      if (value !== "fast" && value !== "sharp") throw new Error("Image quality must be fast or sharp");
      if (quality === value) return;
      quality = value;
      clear();
    },
    getImageForOpening,
    getLatestImageForOpening() {
      const image = latestImage?.deref();
      return image ? getImageForOpening(image) : undefined;
    },
    clear,
    getStatus: () => ({ quality, cacheSize: cache.size, cacheBytes: cache.bytes, lastFailure }),
    rearm() {
      if (installed && !delegates.has(Image.prototype.render)) Image.prototype.render = wrap(Image.prototype.render);
    },
    uninstall() {
      enabled = false;
      installed = false;
      clear();
      const delegate = delegates.get(Image.prototype.render);
      if (delegate) Image.prototype.render = delegate;
      // Wrappers retained by another extension are disabled pass-throughs.
    },
  };
}
