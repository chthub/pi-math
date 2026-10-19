import assert from "node:assert/strict";
import test from "node:test";
import { Resvg } from "@resvg/resvg-js";
import { initTheme, ToolExecutionComponent } from "@earendil-works/pi-coding-agent";
import { Image, Text, type Component, type TUI, type TuiMouseEvent, setCapabilities, setCellDimensions } from "@earendil-works/pi-tui";
import { installOrdinaryImagePatch } from "../src/ordinary-images.js";
import { installImageClickPatch } from "../src/image-click.js";

const png = new Resvg('<svg xmlns="http://www.w3.org/2000/svg" width="180" height="144"><rect width="180" height="144" fill="red"/></svg>').render().asPng().toString("base64");
const makeImage = () => new Image(png, "image/png", { fallbackColor: s => s }, { maxWidthCells: 10 });
const event = (values: Partial<TuiMouseEvent> = {}): TuiMouseEvent => ({
  type: "click", button: "left", x: 2, y: 1, screenX: 2, screenY: 1,
  width: 80, height: 20, shift: false, alt: false, ctrl: false, clickCount: 1, ...values,
});
const settle = () => new Promise<void>(resolve => setImmediate(resolve));
function setup() {
  const keys = ["TERM_PROGRAM", "TERM", "TMUX", "STY", "PI_MATH_VSCODE_IMAGES", "PI_MATH_IMAGE_OPEN"];
  const env = Object.fromEntries(keys.map(key => [key, process.env[key]]));
  for (const key of keys) delete process.env[key];
  process.env.TERM_PROGRAM = "vscode";
  process.env.TERM = "xterm-256color";
  setCapabilities({ images: "kitty", trueColor: true, hyperlinks: true });
  setCellDimensions({ widthPx: 9, heightPx: 18 });
  const imageMouse = Object.getOwnPropertyDescriptor(Image.prototype, "handleMouse");
  const toolMouse = ToolExecutionComponent.prototype.handleMouse;
  const images = installOrdinaryImagePatch();
  const opened: string[] = [];
  let clock = 0;
  const clicks = installImageClickPatch(images, async data => { opened.push(data); }, undefined, () => clock);
  return { images, clicks, opened, imageMouse, toolMouse, advance(ms = 400) { clock += ms; }, restore() {
    clicks.uninstall(); images.uninstall();
    if (imageMouse) Object.defineProperty(Image.prototype, "handleMouse", imageMouse);
    else delete (Image.prototype as Component).handleMouse;
    ToolExecutionComponent.prototype.handleMouse = toolMouse;
    for (const [key, value] of Object.entries(env)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    setCapabilities({ images: null, trueColor: true, hyperlinks: true });
  } };
}

test("ordinary image click opens full host PNG, not the low-density preview", async () => {
  const s = setup();
  try {
    const image = makeImage();
    assert.equal(s.images.getImageForOpening(image), undefined);
    const lines = image.render(80);
    assert.equal(s.opened.length, 0, "render must never open a file/process");
    assert.equal(s.images.getImageForOpening(image)?.data, png);
    assert.deepEqual((image as Component).handleMouse!(event({ height: lines.length })), { handled: true, render: false });
    await settle();
    assert.deepEqual(s.opened, [png]);
    s.clicks.setEnabled(false);
    assert.equal((image as Component).handleMouse!(event({ height: lines.length })), undefined);
    assert.equal(s.clicks.openLatest(), true, "explicit keyboard open still works with click disabled");
    await settle();
    assert.equal(s.opened.length, 2);
    s.images.setEnabled(false);
    assert.equal(s.clicks.openLatest(), false);
    s.images.setEnabled(true);
    s.images.clear();
    assert.equal(s.clicks.openLatest(), false, "clear must release weak opening associations too");
  } finally { s.restore(); }
});

test("scroll, drag, press, modifiers, whitespace and double clicks are untouched", async () => {
  const s = setup();
  try {
    const image = makeImage(); image.render(80);
    const ignored: Partial<TuiMouseEvent>[] = [
      { type: "wheel", wheelDelta: 1 }, { type: "drag" }, { type: "press" }, { type: "release" }, { type: "move" },
      { shift: true }, { ctrl: true }, { alt: true }, { button: "right" }, { button: "middle" },
      { x: 10 }, { y: 4 }, { x: -1 }, { y: -1 }, { clickCount: 2 }, { x: Number.NaN },
    ];
    for (const extra of ignored) assert.equal((image as Component).handleMouse!(event(extra)), undefined);
    await settle();
    assert.equal(s.opened.length, 0);
    s.clicks.uninstall();
    assert.equal((Image.prototype as Component).handleMouse, s.imageMouse?.value);
    assert.equal(ToolExecutionComponent.prototype.handleMouse, s.toolMouse);
  } finally { s.restore(); }
});

test("default and self-framed tool images route clicks without grabbing text or spacers", async () => {
  const s = setup();
  initTheme("dark", false);
  try {
    for (const shell of ["default", "self"] as const) for (const empty of [false, true]) {
      const tool = new ToolExecutionComponent("read", "test", {}, { imageWidthCells: 10 }, {
        renderShell: shell,
        renderCall: () => new Text(empty ? "" : "read image", 0, 0),
        renderResult: () => new Text(empty ? "" : "result text", 0, 0),
      }, { requestRender() {} } as unknown as TUI, "/tmp");
      tool.updateResult({ content: [
        { type: "image", data: png, mimeType: "image/png" },
        { type: "image", data: png, mimeType: "image/png" },
      ], isError: false });
      const lines = tool.render(80);
      const imageRows = lines.flatMap((line, index) => line.includes("\x1b_G") ? [index] : []);
      assert.equal(imageRows.length, 8);
      const before = s.opened.length;
      for (const y of [imageRows[0], imageRows[3], imageRows[4], imageRows[7]]) {
        s.advance();
        assert.equal(tool.handleMouse(event({ y, height: lines.length }))?.handled, true);
      }
      await settle();
      assert.equal(s.opened.length, before + 4, `${shell}, empty=${empty}`);
      const spacerY = imageRows[4] - 1;
      tool.handleMouse(event({ y: spacerY, height: lines.length }));
      tool.handleMouse(event({ y: imageRows[0], x: 40, height: lines.length }));
      tool.handleMouse(event({ y: imageRows[0], type: "wheel", wheelDelta: 1, height: lines.length }));
      await settle();
      assert.equal(s.opened.length, before + 4, "spacer/right margin/wheel must not open");
    }
  } finally { s.restore(); }
});

test("self-shell bridge never forwards other extensions outside its active compatibility scope", () => {
  const s = setup();
  initTheme("dark", false);
  try {
    const tool = new ToolExecutionComponent("read", "scope-test", {}, { imageWidthCells: 10 }, {
      renderShell: "self", renderCall: () => new Text("header", 0, 0), renderResult: () => new Text("body", 0, 0),
    }, { requestRender() {} } as unknown as TUI, "/tmp");
    tool.updateResult({ content: [{ type: "image", data: png, mimeType: "image/png" }], isError: false });
    const lines = tool.render(80);
    const y = lines.findIndex(line => line.includes("\x1b_G"));
    assert.ok(y >= 0);
    let forwarded = 0;
    (Image.prototype as Component).handleMouse = () => { forwarded++; return { handled: true }; };
    s.clicks.rearm();
    const image = (tool as unknown as { imageComponents: Image[] }).imageComponents[0];
    const render = image.render;
    let renders = 0;
    image.render = function (width) { renders++; return render.call(this, width); };
    const reset = () => {
      process.env.TERM_PROGRAM = "vscode"; process.env.TERM = "xterm-256color";
      delete process.env.TMUX; delete process.env.STY;
      setCapabilities({ images: "kitty", trueColor: true, hyperlinks: true });
      s.images.setEnabled(true); forwarded = 0; renders = 0;
    };
    const inactive = [
      () => { process.env.TERM_PROGRAM = "wezterm"; },
      () => { setCapabilities({ images: null, trueColor: true, hyperlinks: true }); },
      () => { setCapabilities({ images: "iterm2", trueColor: true, hyperlinks: true }); },
      () => { process.env.TMUX = "test"; },
      () => { process.env.STY = "test"; },
      () => { process.env.TERM = "screen-256color"; },
      () => { s.images.setEnabled(false); },
    ];
    for (const disable of inactive) {
      reset(); disable();
      assert.equal(tool.handleMouse(event({ y, height: lines.length })), undefined);
      assert.equal(forwarded, 0);
      assert.equal(renders, 0, "inactive bridge must not perform extra image renders");
    }
    reset();
    assert.equal(tool.handleMouse(event({ y, height: lines.length }))?.handled, true);
    assert.equal(forwarded, 1, "active bridge preserves other image handlers");
    assert.equal(renders, 1);
  } finally { s.restore(); }
});

test("rapid image clicks coalesce even when Pi reports clickCount=1 twice", async () => {
  const s = setup();
  try {
    const image = makeImage(); image.render(80);
    (image as Component).handleMouse!(event());
    await settle();
    s.advance(100);
    (image as Component).handleMouse!(event());
    await settle();
    assert.equal(s.opened.length, 1);
    s.advance(300);
    (image as Component).handleMouse!(event());
    await settle();
    assert.equal(s.opened.length, 2);
    const another = makeImage(); another.render(80);
    (another as Component).handleMouse!(event());
    await settle();
    assert.equal(s.opened.length, 3, "another image must not be throttled");
  } finally { s.restore(); }
});

test("opener and notification errors never escape the mouse event as unhandled rejections", async () => {
  const s = setup();
  s.clicks.uninstall();
  let reports = 0;
  const clicks = installImageClickPatch(s.images,
    async () => { throw new Error("injected opener failure"); },
    () => { reports++; throw new Error("UI already gone"); });
  try {
    const image = makeImage(); image.render(80);
    (image as Component).handleMouse!(event());
    await settle();
    assert.equal(reports, 1);
  } finally { clicks.uninstall(); s.restore(); }
});

test("rearm/uninstall compose with other handlers and cancel queued opens", async () => {
  const s = setup();
  try {
    const image = makeImage(); image.render(80);
    const own = (Image.prototype as Component).handleMouse!;
    let delegated = 0;
    const other: NonNullable<Component["handleMouse"]> = function (this: Component, e) { delegated++; return own.call(this, e); };
    (Image.prototype as Component).handleMouse = other;
    s.clicks.rearm();
    (image as Component).handleMouse!(event());
    await settle();
    assert.equal(s.opened.length, 1);
    assert.equal(delegated, 1);
    s.advance();
    (image as Component).handleMouse!(event());
    s.clicks.uninstall();
    await settle();
    assert.equal(s.opened.length, 1, "shutdown must cancel an open still queued in a microtask");
    assert.equal((Image.prototype as Component).handleMouse, other);
    s.clicks.uninstall(); s.clicks.rearm();
    assert.equal((Image.prototype as Component).handleMouse, other);
    assert.equal(s.clicks.openLatest(), false);
  } finally { s.restore(); }
});
