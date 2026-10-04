import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

// Optional path tests an installed Pi instead of the pinned development host.
// No real terminal, session, model call, credentials, or TUI source patches.
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const host = process.env.PI_MATH_TEST_HOST
  ? resolve(process.env.PI_MATH_TEST_HOST)
  : dirname(dirname(fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent"))));
const requireHost = createRequire(join(host, "package.json"));
const tuiEntry = requireHost.resolve("@earendil-works/pi-tui");
const { createJiti } = await import(pathToFileURL(requireHost.resolve("jiti")).href);
const jiti = createJiti(import.meta.url, {
  moduleCache: false,
  alias: {
    "@earendil-works/pi-tui": tuiEntry,
    "@earendil-works/pi-coding-agent": join(host, "dist/index.js"),
  },
});
const tui = await import(pathToFileURL(tuiEntry).href);
const { TuiAltScreen } = await import(pathToFileURL(join(dirname(tuiEntry), "tui-alt-screen.js")).href);
const { TuiMainScreen } = await import(pathToFileURL(join(dirname(tuiEntry), "tui-main-screen.js")).href);
const { createTerminalMathRenderer } = await jiti.import(join(root, "src/renderer.ts"));
const { installMarkdownMathPatch } = await jiti.import(join(root, "src/markdown-patch.ts"));
const { initTheme, getMarkdownTheme } = await import(pathToFileURL(join(host, "dist/index.js")).href);
const { version } = requireHost("./package.json");
process.env.TERM_PROGRAM = "vscode";
delete process.env.WEZTERM_PANE;
delete process.env.KITTY_WINDOW_ID;
delete process.env.GHOSTTY_RESOURCES_DIR;
tui.setCapabilities({ images: "kitty", trueColor: true, hyperlinks: true });
tui.setCellDimensions({ widthPx: 9, heightPx: 18 });
initTheme("dark", false);
const renderer = await createTerminalMathRenderer();
const patch = installMarkdownMathPatch(renderer);
const source = String.raw`$$\frac{\sum_{i=1}^{n}x_i^2}{\sqrt{1+\prod_{j=1}^{n}y_j}}$$`;
let text = source;
const document = {
  render: width => ["before", ...new tui.Markdown(text, 1, 0, getMarkdownTheme()).render(width), "after"],
  invalidate() {},
};

function checkOutput(output, fullscreen) {
  // Parse commands, skipping each PNG payload; continuation chunks are not placements.
  const re = /\x1b\[(\d+);(\d+)H|\x1b\[2K|\x1b_G([^;\x1b]*)(?:;[^]*?)?\x1b\\/g;
  let row = 1;
  let placements = 0;
  const occupied = new Set();
  for (const match of output.matchAll(re)) {
    if (match[1]) row = Number(match[1]);
    else if (match[0] === "\x1b[2K") {
      if (fullscreen) assert.ok(!occupied.has(row), `row ${row} cleared after its image was drawn`);
    } else if (/(?:^|,)a=(?:T|p)(?:,|$)/.test(match[3] ?? "")) {
      assert.match(match[3], /(?:^|,)r=1(?:,|$)/, "no placement may cover a later row");
      placements++;
      occupied.add(row);
    }
  }
  return placements;
}

try {
  for (const [mode, Screen] of [["fullscreen", TuiAltScreen], ["regular", TuiMainScreen]]) {
    let output = "";
    text = source;
    const terminal = { columns: 80, rows: 16, write: data => { output += data; }, hideCursor() {}, showCursor() {} };
    const screen = new Screen(terminal, false, undefined, { mouse: false });
    screen.stopped = false;
    if (mode === "fullscreen") {
      screen.altScreenActive = true;
      screen.imageProtocol = "kitty";
      screen.layoutRoot = document;
    } else {
      screen.addChild(document);
    }
    screen.doRender();
    assert.ok(checkOutput(output, mode === "fullscreen") > 1, `${mode}: tall formula did not produce row images`);
    output = "";
    text += "\n\nAppended prose";
    screen.doRender();
    checkOutput(output, mode === "fullscreen");
    output = "";
    terminal.columns = 40;
    screen.doRender();
    assert.ok(checkOutput(output, mode === "fullscreen") > 1, `${mode}: resize lost images`);
    if (mode === "fullscreen") {
      output = "";
      terminal.rows = 3; // A formula crossing the viewport remains independently drawable.
      screen.doRender();
      assert.ok(checkOutput(output, true) > 0, "scroll clipping lost the visible row image");
    }
    screen.stopped = true;
    console.log(`Pi ${version}: VS Code ${mode} initial draw, streaming and resize passed`);
  }
} finally {
  patch.uninstall();
  renderer.clear();
}
