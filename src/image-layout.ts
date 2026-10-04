import { allocateImageId, getCapabilities, renderImage } from "@earendil-works/pi-tui";
import { kittyPlaceholderSupport, renderKittyVirtualImage } from "./kitty-graphics.js";
import { FormulaRowCache, splitFormulaRasterRows, usesRowImages, type FormulaImageRaster } from "./raster-rows.js";
import type { FormulaRaster } from "./svg-renderer.js";

export interface FormulaImagePlacement {
  marker: string;
  imageId: number;
  /** Stable, distinct IDs: VS Code supports only one placement per image. */
  rowImageIds?: number[];
  raster: FormulaRaster;
  inline: boolean;
  fallbackText: string;
}

export interface FormulaImageArea {
  renderWidth: number;
  paddingX: number;
}

function renderNativeImage(
  placement: FormulaImagePlacement,
  raster: FormulaImageRaster = placement.raster,
  imageId: number = placement.imageId,
) {
  return renderImage(
    raster.base64Data,
    {
      widthPx: raster.widthPx,
      heightPx: raster.heightPx,
    },
    {
      maxWidthCells: raster.columns,
      maxHeightCells: raster.rows,
      imageId,
      moveCursor: false,
    },
  );
}

function renderBlockPlacement(
  placement: FormulaImagePlacement,
  area: FormulaImageArea,
  rowCache?: FormulaRowCache,
): string[] | undefined {
  const capabilities = getCapabilities();
  if (!capabilities.images) return undefined;

  const contentWidth = Math.max(1, area.renderWidth - area.paddingX * 2);
  if (placement.raster.columns > contentWidth) return undefined;
  const left =
    area.paddingX + Math.max(0, Math.floor((contentWidth - placement.raster.columns) / 2));
  const prefix = " ".repeat(left);
  if (capabilities.images === "kitty" && usesRowImages() && placement.raster.rows > 1) {
    try {
      const rows = rowCache?.get(placement.raster) ?? splitFormulaRasterRows(placement.raster);
      placement.rowImageIds ??= rows.map((_, row) => row === 0 ? placement.imageId : allocateImageId());
      if (placement.rowImageIds.length !== rows.length) return undefined;
      const lines: string[] = [];
      for (const [row, raster] of rows.entries()) {
        const rendered = renderNativeImage(placement, raster, placement.rowImageIds[row]!);
        if (!rendered || rendered.rows !== 1) return undefined;
        lines.push(`${prefix}${rendered.sequence}`);
      }
      // Every image occupies its own row. Later clears/scrolling cannot erase
      // lower portions of an earlier image, in either fullscreen or regular mode.
      return lines;
    } catch {
      return undefined; // Crop/PNG failures preserve the original LaTeX.
    }
  }

  const rendered = renderNativeImage(placement);
  if (!rendered) return undefined;
  if (capabilities.images === "kitty") {
    return [
      `${prefix}${rendered.sequence}`,
      ...Array.from({ length: Math.max(0, rendered.rows - 1) }, () => ""),
    ];
  }

  const rowOffset = Math.max(0, rendered.rows - 1);
  const moveUp = rowOffset > 0 ? `\x1b[${rowOffset}A` : "";
  return [
    ...Array.from({ length: rowOffset }, () => ""),
    `${prefix}${moveUp}${rendered.sequence}`,
  ];
}

/** Place a one-row Kitty image without changing the surrounding text flow. */
function renderInlinePlacement(placement: FormulaImagePlacement): string | undefined {
  if (getCapabilities().images !== "kitty" || placement.raster.rows !== 1) return undefined;

  if (kittyPlaceholderSupport()) {
    const virtual = renderKittyVirtualImage(
      placement.raster.base64Data,
      placement.imageId,
      placement.raster.columns,
      1,
    );
    if (virtual) return `${virtual.sequence}${virtual.placeholders[0]}`;
  }

  // Compatibility path for Kitty-protocol terminals without Unicode placeholders.
  const rendered = renderNativeImage(placement);
  if (!rendered || rendered.rows !== 1) return undefined;
  const columns = placement.raster.columns;
  return `${" ".repeat(columns)}\x1b[${columns}D${rendered.sequence}\x1b[${columns}C`;
}

/** Replace generated Markdown markers with terminal-native image placements. */
export function insertFormulaImages(
  lines: string[],
  placements: FormulaImagePlacement[],
  area: FormulaImageArea,
  rowCache?: FormulaRowCache,
): string[] {
  if (placements.length === 0) return lines;
  const output: string[] = [];
  const blockPlacements = placements.filter(({ inline }) => !inline);
  const inlinePlacements = placements.filter(({ inline }) => inline);

  for (let lineIndex = 0; lineIndex < lines.length; lineIndex++) {
    const line = lines[lineIndex]!;
    const block = blockPlacements.find(({ marker }) => line.includes(marker));
    if (block) {
      const imageLines = renderBlockPlacement(block, area, rowCache);
      const blockLines =
        imageLines ?? [line.replace(block.marker, () => block.fallbackText)];
      // Place one empty row above and below each formula so it never sits
      // flush against text or another formula. Consecutive formula blocks
      // share the boundary row instead of doubling it.
      output.push("");
      output.push(...blockLines);
      const nextIsBlock = blockPlacements.some(({ marker }) =>
        lines[lineIndex + 1]?.includes(marker),
      );
      if (!nextIsBlock) output.push("");
      continue;
    }

    let renderedLine = line;
    for (const placement of inlinePlacements) {
      if (!renderedLine.includes(placement.marker)) continue;
      const image = renderInlinePlacement(placement) ?? placement.fallbackText;
      renderedLine = renderedLine.replace(placement.marker, () => image);
    }
    output.push(renderedLine);
  }

  return output;
}
