import { Resvg } from "@resvg/resvg-js";
import { getPngDimensions } from "@earendil-works/pi-tui";
import { WeightedLruCache } from "./lru-cache.js";
import type { FormulaRaster } from "./svg-renderer.js";

export type FormulaImageRaster = Pick<
  FormulaRaster,
  "base64Data" | "widthPx" | "heightPx" | "columns" | "rows"
>;

/** VS Code's Kitty images are cell-backed and later row clears erase their tiles. */
export function usesRowImages(environment: NodeJS.ProcessEnv = process.env): boolean {
  return environment.TERM_PROGRAM?.toLowerCase() === "vscode";
}

/** Crop, never re-typeset or resize, the completed PNG into one image per terminal row. */
export function splitFormulaRasterRows(raster: FormulaRaster): FormulaImageRaster[] {
  if (
    !Number.isInteger(raster.rows) || raster.rows < 1 ||
    !Number.isInteger(raster.heightPx) || raster.heightPx < raster.rows
  ) {
    throw new Error("Invalid formula row dimensions");
  }
  if (raster.rows === 1) return [raster];
  const dimensions = getPngDimensions(raster.base64Data);
  if (dimensions?.widthPx !== raster.widthPx || dimensions.heightPx !== raster.heightPx) {
    throw new Error("Invalid formula PNG dimensions");
  }

  return Array.from({ length: raster.rows }, (_, row) => {
    // Half-open, adjacent intervals also cover rounded/fractional cell canvases.
    const top = Math.floor((row * raster.heightPx) / raster.rows);
    const bottom = Math.floor(((row + 1) * raster.heightPx) / raster.rows);
    const heightPx = bottom - top;
    const svg = [
      `<svg xmlns="http://www.w3.org/2000/svg" width="${raster.widthPx}" height="${heightPx}" viewBox="0 0 ${raster.widthPx} ${heightPx}">`,
      `<image x="0" y="${-top}" width="${raster.widthPx}" height="${raster.heightPx}" href="data:image/png;base64,${raster.base64Data}"/>`,
      "</svg>",
    ].join("");
    const rendered = new Resvg(svg, { font: { loadSystemFonts: false }, logLevel: "error" }).render();
    if (rendered.width !== raster.widthPx || rendered.height !== heightPx) {
      throw new Error("Unexpected formula row raster dimensions");
    }
    return {
      base64Data: rendered.asPng().toString("base64"),
      widthPx: rendered.width,
      heightPx: rendered.height,
      columns: raster.columns,
      rows: 1,
    };
  });
}

/** Session-owned, byte-bounded cache; row PNGs must not be re-cropped on every delta. */
export class FormulaRowCache {
  private readonly cache = new WeightedLruCache<FormulaImageRaster[]>(256, 32 * 1024 * 1024);

  get(raster: FormulaRaster): FormulaImageRaster[] {
    const key = `${raster.rows}:${raster.columns}:${raster.base64Data}`;
    const cached = this.cache.get(key);
    if (cached) return cached;
    const rows = splitFormulaRasterRows(raster);
    const bytes = key.length * 2 + rows.reduce((sum, row) => sum + row.base64Data.length * 2 + 64, 0);
    this.cache.set(key, rows, bytes);
    return rows;
  }

  clear(): void {
    this.cache.clear();
  }
}
