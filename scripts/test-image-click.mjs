// Offline actual-host SGR mouse routing; no real terminal, opener, CLI startup or files.
// PI_MATH_TEST_HOST optionally selects an installed coding-agent package directory.
import { createRequire } from "node:module";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Resvg } from "@resvg/resvg-js";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const host = process.env.PI_MATH_TEST_HOST ? resolve(process.env.PI_MATH_TEST_HOST)
  : dirname(dirname(fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent"))));
const requireHost = createRequire(join(host, "package.json"));
const { version } = requireHost("./package.json");
const tuiEntry = requireHost.resolve("@earendil-works/pi-tui");
const agentEntry = join(host, "dist/index.js");
const { createJiti } = await import(pathToFileURL(requireHost.resolve("jiti")).href);
const moduleTui = await import(pathToFileURL(tuiEntry).href);
const moduleAgent = await import(pathToFileURL(agentEntry).href);
const environmentKeys = ["TERM_PROGRAM", "TERM", "TMUX", "STY", "PI_IMAGE_PROTOCOL", "PI_MATH_VSCODE_IMAGES", "PI_MATH_IMAGE_QUALITY", "PI_MATH_IMAGE_OPEN", "WEZTERM_PANE", "KITTY_WINDOW_ID", "GHOSTTY_RESOURCES_DIR", "PI_TUI_WRITE_LOG", "PI_TUI_DEBUG_REDRAW"];
const savedEnvironment = Object.fromEntries(environmentKeys.map(key => [key, process.env[key]]));
let passed = 0, failed = 0;
class Failure extends Error {}
function check(condition, message) { if (!condition) throw new Failure(message); }
async function test(name, fn) {
  try { await fn(); passed++; console.log(`PASS Pi ${version} ${name}`); }
  catch (error) {
    failed++;
    console.error(`FAIL Pi ${version} ${name}: ${error instanceof Failure ? error.message : "upstream exception; payload-bearing details withheld"}`);
  }
}
const settle = () => new Promise(resolve => setImmediate(resolve));
const pngs = ["#e53935", "#1e88e5"].map(color => new Resvg(`<svg xmlns="http://www.w3.org/2000/svg" width="180" height="144"><rect width="180" height="144" fill="${color}"/></svg>`, { font: { loadSystemFonts: false } }).render().asPng().toString("base64"));
function configure(tui, agent) {
  for (const key of environmentKeys) delete process.env[key];
  Object.assign(process.env, { TERM_PROGRAM: "vscode", TERM: "xterm-256color", PI_IMAGE_PROTOCOL: "kitty" });
  tui.setCapabilities({ images: "kitty", trueColor: true, hyperlinks: true });
  tui.setCellDimensions({ widthPx: 9, heightPx: 18 });
  agent.initTheme("dark", false);
}
function sameDescriptor(a, b) {
  return a?.value === b?.value && a?.get === b?.get && a?.set === b?.set
    && a?.configurable === b?.configurable && a?.enumerable === b?.enumerable && a?.writable === b?.writable;
}
function restoreDescriptor(prototype, descriptor) {
  if (descriptor) Object.defineProperty(prototype, "handleMouse", descriptor);
  else delete prototype.handleMouse;
}

async function bundledApis() {
  // Read/import the actual offline virtual-module table used by the CLI loader.
  // This evaluates exported definitions, NOT cli.js/main/session/model code.
  const directory = join(host, "dist/bundle/chunks");
  const names = readdirSync(directory).filter(name => /^virtual-modules-.*\.js$/.test(name));
  check(names.length === 1, "CLI virtual-module table probe is ambiguous");
  const { VIRTUAL_MODULES } = await import(pathToFileURL(join(directory, names[0])).href);
  const tui = VIRTUAL_MODULES["@earendil-works/pi-tui"];
  const agent = VIRTUAL_MODULES["@earendil-works/pi-coding-agent"];
  check(tui?.Image && agent?.ToolExecutionComponent, "CLI virtual exports lack Image/ToolExecutionComponent");
  check(tui.Image !== moduleTui.Image && agent.ToolExecutionComponent !== moduleAgent.ToolExecutionComponent, "bundle must not silently reuse module-host constructors");
  for (const [symbol, expected] of [["Image", tui.Image], ["ToolExecutionComponent", agent.ToolExecutionComponent]]) {
    const candidates = readdirSync(directory).filter(name => name.endsWith(".js")).filter(name => {
      const source = readFileSync(join(directory, name), "utf8");
      const exports = source.slice(source.lastIndexOf("export{"));
      return new RegExp(`(?:[,{])${symbol}(?:[,}])`).test(exports);
    });
    check(candidates.length === 1, `actual CLI ${symbol} chunk could not be identified uniquely`);
    const exports = await import(pathToFileURL(join(directory, candidates[0])).href);
    check(exports[symbol] === expected, `CLI ${symbol} export and virtual module prototype differ`);
  }
  return { tui, agent };
}

function createScene(tui, component, { rows = 22, prefix = 2, suffix = 30, advance }) {
  const container = new tui.Container();
  if (prefix) container.addChild(new tui.Text(Array.from({ length: prefix }, (_, i) => `heading ${i}`).join("\n"), 0, 0));
  container.addChild(component);
  if (suffix) container.addChild(new tui.Text(Array.from({ length: suffix }, (_, i) => `ordinary text ${i}`).join("\n"), 0, 0));
  const scroll = new tui.ScrollView(container, { follow: "none", primary: true, scrollbar: "hidden" });
  const terminal = { columns: 80, rows, write() {}, hideCursor() {}, showCursor() {} };
  const screen = new tui.TuiAltScreen(terminal, false, undefined, { mouse: true });
  screen.stopped = false; screen.altScreenActive = true; screen.imageProtocol = "kitty";
  screen.layoutRoot = scroll;
  screen.copyOnSelect = false;
  let requests = 0;
  // Keep raw host dispatch/rendering, but don't schedule timers or real IO.
  screen.requestRender = () => { requests++; };
  screen.doRender();
  const input = (button, x, y, release = false) => {
    const result = screen.handleViewportInput(`\x1b[<${button};${x + 1};${y + 1}${release ? "m" : "M"}`);
    check(result?.consume === true, "actual SGR input parser did not consume mouse event");
  };
  return {
    screen, scroll, terminal, prefix,
    input, advance,
    render: () => screen.doRender(),
    resetGesture: () => screen.handleViewportInput("\x1b[O"), // real focus-out cancels selection/click history
    // Independent gestures advance the adapter clock, not the host's Date.now.
    async click(x, y, button = 0, elapsed = 300) {
      advance(elapsed); input(button, x, y); input(button, x, y, true); await settle();
    },
    imageRows: () => screen.previousScreen.flatMap((line, row) => line.includes("\x1b_G") ? [row] : []),
    requests: () => requests,
    close() { screen.handleViewportInput("\x1b[O"); screen.stopped = true; },
  };
}

async function suite(kind, tui, agent, bundled = false) {
  const jiti = createJiti(import.meta.url, {
    fsCache: false, moduleCache: false,
    alias: { "@earendil-works/pi-tui": tuiEntry, "@earendil-works/pi-coding-agent": agentEntry },
    ...(bundled ? { virtualModules: { "@earendil-works/pi-tui": tui, "@earendil-works/pi-coding-agent": agent } } : {}),
  });
  const { installOrdinaryImagePatch } = await jiti.import(join(root, "src/ordinary-images.ts"));
  const { installImageClickPatch } = await jiti.import(join(root, "src/image-click.ts"));
  let clock = 1000;
  const advance = (milliseconds = 300) => { clock += milliseconds; };
  const scene = (api, component, options = {}) => createScene(api, component, { ...options, advance });
  const image = (index = 0) => new tui.Image(pngs[index], "image/png", { fallbackColor: text => text }, { maxWidthCells: 10 });
  const tool = (shell, empty) => {
    const component = new agent.ToolExecutionComponent("read", "offline-click-test", {}, { imageWidthCells: 10 }, {
      renderShell: shell,
      renderCall: () => new tui.Text(empty ? "" : "read synthetic image", 0, 0),
      renderResult: () => new tui.Text(empty ? "" : "synthetic result text", 0, 0),
    }, { requestRender() {} }, root);
    component.updateResult({ content: pngs.map(data => ({ type: "image", data, mimeType: "image/png" })), isError: false });
    return component;
  };
  async function patched(name, fn, { rejectOpen = false, throwReport = false } = {}) {
    await test(`${kind}: ${name}`, async () => {
      configure(tui, agent);
      clock = 1000;
      const beforeImage = Object.getOwnPropertyDescriptor(tui.Image.prototype, "handleMouse");
      const beforeTool = Object.getOwnPropertyDescriptor(agent.ToolExecutionComponent.prototype, "handleMouse");
      const images = installOrdinaryImagePatch();
      const opened = [], reports = [];
      const clicks = installImageClickPatch(images, async data => {
        opened.push(data);
        if (rejectOpen) throw new Error("synthetic opener failure");
      }, message => {
        reports.push(message);
        if (throwReport) throw new Error("synthetic disposed notification handler");
      }, () => clock);
      try {
        check(tui.Image.prototype.handleMouse !== beforeImage?.value, "patch missed actual Image prototype");
        check(agent.ToolExecutionComponent.prototype.handleMouse !== beforeTool?.value, "patch missed actual ToolExecution prototype");
        await fn({ images, clicks, opened, reports });
      } finally {
        clicks.uninstall(); images.uninstall();
        const restoredImage = sameDescriptor(Object.getOwnPropertyDescriptor(tui.Image.prototype, "handleMouse"), beforeImage);
        const restoredTool = sameDescriptor(Object.getOwnPropertyDescriptor(agent.ToolExecutionComponent.prototype, "handleMouse"), beforeTool);
        restoreDescriptor(tui.Image.prototype, beforeImage); restoreDescriptor(agent.ToolExecutionComponent.prototype, beforeTool);
        check(restoredImage && restoredTool, "uninstall did not restore actual host handler descriptors");
      }
    });
  }

  await patched("SGR press/release opens full PNG exactly once, never on press/render", async ({ opened }) => {
    const component = image();
    const f = scene(tui, component);
    try {
      const row = f.imageRows()[0];
      check(f.imageRows().length === 4 && opened.length === 0, "render must reserve four rows without opening");
      f.input(0, 2, row); await settle();
      check(opened.length === 0, "mouse press opened an image before release");
      f.input(0, 2, row, true); await settle();
      check(opened.length === 1 && opened[0] === pngs[0], "SGR release must open full original PNG exactly once");
      f.input(0, 2, row, true); await settle();
      check(opened.length === 1, "orphan release opened another image");
      f.render(); await settle();
      check(opened.length === 1, "redraw opened an image");
    } finally { f.close(); }
  });

  await patched("SGR drag/wheel/modifiers/text/right margin never open", async ({ opened }) => {
    const f = scene(tui, image());
    try {
      const row = f.imageRows()[0];
      f.input(0, 2, row); f.input(32, 5, row + 1); f.input(0, 5, row + 1, true);
      await settle(); check(opened.length === 0, "drag opened an image");
      f.resetGesture(); f.input(65, 2, row); await settle();
      check(opened.length === 0, "wheel opened an image");
      f.scroll.scrollToStart(); f.render();
      for (const button of [4, 8, 16, 1]) {
        f.resetGesture(); await f.click(2, row, button);
        check(opened.length === 0, "modified/non-left click opened an image");
      }
      for (const [x, y] of [[2, 0], [10, row], [40, row], [2, row + 4]]) {
        f.resetGesture(); await f.click(x, y);
        check(opened.length === 0, "text or image margin opened an image");
      }
    } finally { f.close(); }
  });

  await patched("raw count=1,1 double-click coalesces at +100ms and opens again at +300ms", async ({ opened }) => {
    const component = image();
    const handler = component.handleMouse;
    const counts = [];
    component.handleMouse = function (event) {
      if (event.type === "click") counts.push(event.clickCount);
      return handler.call(this, event);
    };
    const f = scene(tui, component);
    try {
      const row = f.imageRows()[0];
      await f.click(2, row);
      check(opened.length === 1, "first click must open once");
      await f.click(2, row, 0, 100); // No focus-out or host click-history reset.
      check(counts.length === 2 && counts[0] === 1 && counts[1] === 1, "fixture must exercise the actual host's count=1,1 classification");
      check(opened.length === 1, "duplicate raw click at +100ms was not coalesced");
      await f.click(2, row, 0, 200); // t=300ms since the first accepted click.
      check(counts.length === 3 && opened.length === 2, "raw click exactly 300ms after the accepted click must open again");
    } finally { f.close(); }
  });

  for (const shell of ["default", "self"]) for (const empty of [false, true]) {
    await patched(`tool ${shell} shell, emptyText=${empty}, two distinct images`, async ({ opened, images }) => {
      const component = tool(shell, empty);
      check(component instanceof agent.ToolExecutionComponent, "tool is not the actual host class");
      const f = scene(tui, component, { rows: 26 });
      try {
        check(component.imageComponents.length === 2 && component.imageComponents.every(item => item instanceof tui.Image), "tool constructed a different Image prototype");
        const rows = f.imageRows();
        check(rows.length === 8, "tool must contain two four-row images");
        check(images.getImageForOpening(component.imageComponents[1])?.data === pngs[1], "second image association lost full PNG");
        for (const index of [0, 3, 4, 7]) {
          f.resetGesture(); const before = opened.length;
          await f.click(2, rows[index]);
          check(opened.length === before + 1 && opened.at(-1) === pngs[index < 4 ? 0 : 1], `SGR row ${index} routed to wrong image or opened more than once`);
        }
        const textRows = component.render(80).flatMap((line, row) => line.includes("synthetic") ? [row] : []);
        const excluded = [[40, rows[0]], [2, rows[4] - 1], [2, 0], ...textRows.map(row => [2, row + f.prefix])];
        for (const [x, y] of excluded) {
          f.resetGesture(); const before = opened.length;
          await f.click(x, y);
          check(opened.length === before, "tool spacer, text or right margin opened an image");
        }
      } finally { f.close(); }
    });
  }

  for (const shell of ["default", "self"]) for (const empty of [false, true]) {
    await patched(`ScrollView clipping/restoration: ${shell}, emptyText=${empty}`, async ({ opened }) => {
      const component = tool(shell, empty);
      const f = scene(tui, component, { rows: 24 });
      try {
        const originalRows = f.imageRows();
        check(originalRows.length === 8, "clipping fixture lost initial images");
        // Clip two rows from the FIRST image. Its visible y=0 must map back to
        // child row=2, not to a text/spacer or the next image.
        f.scroll.scrollTo(originalRows[2]); f.render();
        f.resetGesture(); await f.click(2, 0);
        check(opened.length === 1 && opened[0] === pngs[0], "top-clipped first image hit-test is wrong");
        // Clip to the LAST row of the second image and verify trailing whitespace.
        f.scroll.scrollTo(originalRows[7]); f.render();
        f.resetGesture(); await f.click(2, 0);
        check(opened.length === 2 && opened[1] === pngs[1], "top-clipped second image hit-test is wrong");
        f.resetGesture(); await f.click(2, 1);
        check(opened.length === 2, "row after clipped image opened stale image");
        f.scroll.scrollTo(originalRows[7] + 2); f.render();
        check(f.imageRows().length === 0, "offscreen fixture still has visible images");
        f.resetGesture(); await f.click(2, 0);
        check(opened.length === 2, "offscreen image retained clickable hit region");
        f.scroll.scrollToStart(); f.terminal.rows = originalRows[0] + 2; f.render();
        check(f.imageRows().length === 2, "bottom-clipped fixture must show only first two rows");
        f.resetGesture(); await f.click(2, originalRows[0] + 1);
        check(opened.length === 3 && opened[2] === pngs[0], "bottom-clipped image hit-test is wrong");
        f.terminal.rows = 24; f.render();
        f.resetGesture(); await f.click(2, originalRows[4]);
        check(opened.length === 4 && opened[3] === pngs[1], "restored viewport uses stale image coordinates");
      } finally { f.close(); }
    });
  }

  await patched("rejected opener plus throwing reporter stays best-effort", async ({ opened, reports }) => {
    const unhandled = [];
    const onUnhandled = error => { unhandled.push(error); };
    process.on("unhandledRejection", onUnhandled);
    const f = scene(tui, image());
    try {
      await f.click(2, f.imageRows()[0]);
      await settle();
      check(opened.length === 1 && reports.length === 1, "rejected opener was not reported exactly once");
      check(unhandled.length === 0, "throwing report callback leaked an unhandled rejection");
    } finally { f.close(); process.off("unhandledRejection", onUnhandled); }
  }, { rejectOpen: true, throwReport: true });

  await patched("disable, rearm, keyboard fallback and uninstall cancel queued open", async ({ clicks, opened }) => {
    const component = image();
    const f = scene(tui, component);
    const own = tui.Image.prototype.handleMouse;
    let uninstalled = false;
    try {
      const row = f.imageRows()[0];
      clicks.setEnabled(false);
      await f.click(2, row);
      check(opened.length === 0, "disabled click still opened");
      check(clicks.openLatest(), "explicit latest-image keyboard fallback unavailable");
      await settle(); check(opened.length === 1, "keyboard fallback should work independently of click toggle");
      clicks.setEnabled(true);
      let delegated = 0;
      tui.Image.prototype.handleMouse = function (event) { delegated++; return own.call(this, event); };
      clicks.rearm();
      f.resetGesture(); await f.click(2, row);
      check(opened.length === 2 && delegated > 0, "rearmed handler did not compose or opened twice");
      // Restore the owned wrapper for the descriptor restoration assertion.
      tui.Image.prototype.handleMouse = own;
      f.resetGesture(); f.advance(); f.input(0, 2, row); f.input(0, 2, row, true);
      clicks.uninstall(); uninstalled = true; await settle();
      check(opened.length === 2, "uninstall did not cancel microtask-queued opener");
      check(!clicks.openLatest(), "uninstalled keyboard fallback still opens");
    } finally { f.close(); if (!uninstalled) tui.Image.prototype.handleMouse = own; }
  });
}

try {
  await suite("module host", moduleTui, moduleAgent);
  const { tui, agent } = await bundledApis();
  await suite("CLI virtual modules", tui, agent, true);
} catch (error) {
  failed++;
  console.error(`FAIL Pi ${version}: ${error instanceof Failure ? error.message : "setup/bundle import failed; details withheld"}`);
} finally {
  for (const [key, value] of Object.entries(savedEnvironment)) {
    if (value === undefined) delete process.env[key]; else process.env[key] = value;
  }
}
console.log(`Pi ${version}: ${passed} passed, ${failed} failed. Actual SGR parser/fullscreen routing + real CLI class exports; mock opener only. No real VS Code, regular-mode terminal mouse forwarding, overlays or screenshots verified.`);
process.exitCode = failed ? 1 : 0;
