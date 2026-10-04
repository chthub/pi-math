import assert from "node:assert/strict";
import test from "node:test";
import { Resvg } from "@resvg/resvg-js";
import { Markdown, getPngDimensions, setCapabilities, setCellDimensions, type MarkdownTheme } from "@earendil-works/pi-tui";
import { insertFormulaImages, type FormulaImagePlacement } from "../src/image-layout.js";
import { installMarkdownMathPatch } from "../src/markdown-patch.js";
import { FormulaRowCache, splitFormulaRasterRows, usesRowImages } from "../src/raster-rows.js";
import { createTerminalMathRenderer } from "../src/renderer.js";
import type { FormulaRaster } from "../src/svg-renderer.js";

function fixture(heightPx = 144): FormulaRaster {
  const rendered = new Resvg(`<svg xmlns="http://www.w3.org/2000/svg" width="180" height="${heightPx}">
    <rect x="2" y="2" width="176" height="33" fill="#ff0000"/>
    <rect x="2" y="36" width="176" height="37" fill="#00ff00" fill-opacity="0.5"/>
    <rect x="2" y="73" width="176" height="69" fill="#0000ff"/>
  </svg>`).render();
  return {
    base64Data: rendered.asPng().toString("base64"), widthPx: 180, heightPx,
    columns: 10, rows: 4, pixelsPerEx: 9, deviceScale: 2,
    inkBounds: { left: 2, top: 2, right: 178, bottom: heightPx - 2 },
  };
}

function pixels(base64Data: string): Buffer {
  const dimensions = getPngDimensions(base64Data)!;
  return new Resvg(`<svg xmlns="http://www.w3.org/2000/svg" width="${dimensions.widthPx}" height="${dimensions.heightPx}">
    <image width="${dimensions.widthPx}" height="${dimensions.heightPx}" href="data:image/png;base64,${base64Data}"/>
  </svg>`).render().pixels;
}

function imageHeader(line: string): string {
  const header = /\x1b_G([^;]+);/.exec(line)?.[1];
  assert.ok(header);
  return header;
}

const identity = (text: string) => text;
const theme: MarkdownTheme = {
  heading: identity, link: identity, linkUrl: identity, code: identity, codeBlock: identity,
  codeBlockBorder: identity, quote: identity, quoteBorder: identity, hr: identity,
  listBullet: identity, bold: identity, italic: identity, strikethrough: identity, underline: identity,
};

test("detects VS Code only; no protocol is implicitly enabled", () => {
  assert.equal(usesRowImages({ TERM_PROGRAM: "vscode" }), true);
  assert.equal(usesRowImages({ TERM_PROGRAM: "VSCode" }), true);
  for (const name of ["wezterm", "kitty", "ghostty", "iterm.app", ""]) {
    assert.equal(usesRowImages({ TERM_PROGRAM: name }), false);
  }
});

test("row PNGs preserve all pixels, including alpha and rounded canvas heights", () => {
  for (const heightPx of [144, 145]) {
    const raster = fixture(heightPx);
    const rows = splitFormulaRasterRows(raster);
    assert.equal(rows.length, raster.rows);
    assert.equal(rows.reduce((height, row) => height + row.heightPx, 0), heightPx);
    for (const row of rows) {
      assert.equal(row.rows, 1);
      assert.equal(row.widthPx, raster.widthPx);
      assert.equal(row.columns, raster.columns);
      assert.deepEqual(getPngDimensions(row.base64Data), { widthPx: row.widthPx, heightPx: row.heightPx });
    }
    assert.deepEqual(Buffer.concat(rows.map(row => pixels(row.base64Data))), pixels(raster.base64Data));
  }
  const raster = { ...fixture(), rows: 1 };
  assert.equal(splitFormulaRasterRows(raster)[0], raster);
  assert.throws(() => splitFormulaRasterRows({ ...raster, rows: 200 }), /Invalid formula row dimensions/);
});

test("cropping a real antialiased formula preserves its completed PNG pixels", async () => {
  const renderer = await createTerminalMathRenderer();
  const raster = renderer.render(String.raw`\int_0^\infty \frac{x^{n-1}e^{-x}}{\sqrt{1+x^2}}dx`, true, "#e6e6e6", {
    maxWidthCells: 80, maxHeightCells: 100, cellWidthPx: 9, cellHeightPx: 18,
  });
  assert.ok(raster, renderer.lastFailure?.message);
  assert.ok(raster.rows > 1);
  const rows = splitFormulaRasterRows(raster);
  assert.deepEqual(Buffer.concat(rows.map(row => pixels(row.base64Data))), pixels(raster.base64Data));
});

test("row cache reuses crops and releases them on clear", () => {
  const raster = fixture();
  const cache = new FormulaRowCache();
  const first = cache.get(raster);
  assert.equal(cache.get(raster), first);
  assert.equal(cache.get({ ...raster }), first);
  cache.clear();
  assert.notEqual(cache.get(raster), first);
});

test("VS Code draws independent one-row images with unique stable IDs and source fallback", () => {
  const original = process.env.TERM_PROGRAM;
  process.env.TERM_PROGRAM = "vscode";
  setCellDimensions({ widthPx: 9, heightPx: 18 });
  setCapabilities({ images: "kitty", trueColor: true, hyperlinks: true });
  const placement: FormulaImagePlacement = {
    marker: "FORMULA", imageId: 42, raster: fixture(), inline: false, fallbackText: "$$x$$",
  };
  const area = { renderWidth: 20, paddingX: 2 };
  const cache = new FormulaRowCache();
  try {
    const lines = insertFormulaImages([placement.marker], [placement], area, cache);
    assert.equal(lines.length, placement.raster.rows + 2);
    assert.equal(lines[0], "");
    assert.equal(lines.at(-1), "");
    const images = lines.slice(1, -1);
    const ids = new Set<number>();
    for (const line of images) {
      assert.match(line, /^ {5}\x1b_G/);
      const header = imageHeader(line);
      assert.match(header, /C=1,c=10,r=1,i=/);
      ids.add(Number(/(?:^|,)i=(\d+)/.exec(header)![1]));
      assert.doesNotMatch(header, /U=1/);
    }
    assert.equal(ids.size, placement.raster.rows);
    assert.ok(ids.has(placement.imageId));
    assert.deepEqual(insertFormulaImages([placement.marker], [placement], area, cache), lines);

    const failed = { ...placement, raster: { ...placement.raster, base64Data: "AA==" } };
    assert.deepEqual(insertFormulaImages([failed.marker], [failed], area, cache), ["", "$$x$$", ""]);
    assert.deepEqual(insertFormulaImages([placement.marker], [placement], { renderWidth: 3, paddingX: 0 }, cache), ["", "$$x$$", ""]);
    setCapabilities({ images: null, trueColor: true, hyperlinks: true });
    assert.deepEqual(insertFormulaImages([placement.marker], [placement], area, cache), ["", "$$x$$", ""]);

    setCapabilities({ images: "iterm2", trueColor: true, hyperlinks: true });
    assert.equal(insertFormulaImages([placement.marker], [placement], area, cache).filter(line => line.includes("\x1b]1337")).length, 1);
    process.env.TERM_PROGRAM = "wezterm";
    setCapabilities({ images: "kitty", trueColor: true, hyperlinks: true });
    const normal = insertFormulaImages([placement.marker], [placement], area, cache);
    assert.equal(normal.filter(line => line.includes("\x1b_G")).length, 1);
    assert.match(imageHeader(normal[1]!), /r=4/);
  } finally {
    if (original === undefined) delete process.env.TERM_PROGRAM;
    else process.env.TERM_PROGRAM = original;
    setCapabilities({ images: null, trueColor: false, hyperlinks: false });
  }
});

test("VS Code row IDs survive append-only streaming; resizing and clear refresh placements", async () => {
  const original = process.env.TERM_PROGRAM;
  process.env.TERM_PROGRAM = "vscode";
  setCellDimensions({ widthPx: 9, heightPx: 18 });
  setCapabilities({ images: "kitty", trueColor: true, hyperlinks: true });
  const renderer = await createTerminalMathRenderer();
  const stock = Markdown.prototype.render;
  const patch = installMarkdownMathPatch(renderer);
  const source = String.raw`$$\frac{\sum_{i=1}^{n}x_i^2}{\sqrt{1+\prod_{j=1}^{n}y_j}}$$`;
  const render = (text: string, width: number) => {
    const markdown = new Markdown(text, 1, 0, theme);
    const lines = markdown.render(width);
    assert.equal((markdown as unknown as { text: string }).text, text);
    return lines.filter(line => line.includes("\x1b_G"));
  };
  try {
    const first = render(source, 80);
    assert.ok(first.length > 1);
    assert.deepEqual(render(source, 80), first);
    assert.deepEqual(render(source + "\n\nMore prose", 80), first);
    for (const line of first) assert.match(imageHeader(line), /r=1/);
    assert.notDeepEqual(render(source, 40), first);
    renderer.clear();
    patch.clearTransformCache();
    assert.notDeepEqual(render(source, 80), first);
    // The same component also invalidates its transform when the placement mode changes.
    const markdown = new Markdown(source, 1, 0, theme);
    assert.ok(markdown.render(80).filter(line => line.includes("\x1b_G")).length > 1);
    process.env.TERM_PROGRAM = "wezterm";
    assert.equal(markdown.render(80).filter(line => line.includes("\x1b_G")).length, 1);
  } finally {
    patch.uninstall();
    assert.equal(Markdown.prototype.render, stock);
    if (original === undefined) delete process.env.TERM_PROGRAM;
    else process.env.TERM_PROGRAM = original;
    setCapabilities({ images: null, trueColor: false, hyperlinks: false });
  }
});
