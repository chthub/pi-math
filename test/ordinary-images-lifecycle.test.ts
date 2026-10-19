import assert from "node:assert/strict";
import test from "node:test";
import { ToolExecutionComponent, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Image, Markdown, setCapabilities, setCellDimensions } from "@earendil-works/pi-tui";
import { Resvg } from "@resvg/resvg-js";
import extension from "../src/index.js";

interface Context { mode: string; ui: { notify(message: string): void } }
type Handler = (arg: never, ctx: Context) => unknown;

test("ordinary-image adapter follows TUI lifecycle and its switch is independent of formulas", async () => {
  const stock = Image.prototype.render;
  const markdownStock = Markdown.prototype.render;
  const toolMouse = ToolExecutionComponent.prototype.handleMouse;
  const imageMouse = Object.getOwnPropertyDescriptor(Image.prototype, "handleMouse");
  const env = Object.fromEntries(["TERM_PROGRAM", "TERM", "TMUX", "STY", "PI_MATH_VSCODE_IMAGES", "PI_MATH_IMAGE_QUALITY", "PI_MATH_IMAGE_OPEN"].map(key => [key, process.env[key]]));
  process.env.TERM_PROGRAM = "vscode";
  process.env.TERM = "xterm-256color";
  delete process.env.TMUX;
  delete process.env.STY;
  delete process.env.PI_MATH_VSCODE_IMAGES;
  delete process.env.PI_MATH_IMAGE_QUALITY;
  delete process.env.PI_MATH_IMAGE_OPEN;
  setCapabilities({ images: "kitty", trueColor: true, hyperlinks: true });
  setCellDimensions({ widthPx: 9, heightPx: 18 });
  const png = new Resvg('<svg xmlns="http://www.w3.org/2000/svg" width="90" height="72"><rect width="90" height="72" fill="red"/></svg>').render().asPng().toString("base64");
  const image = new Image(png, "image/png", { fallbackColor: s => s }, { maxWidthCells: 10 });
  const isSliced = () => image.render(80).every(line => line.includes("\x1b_G"));
  const events = new Map<string, Handler>();
  const commands = new Map<string, Handler>();
  const messages: string[] = [];
  const ctx: Context = { mode: "tui", ui: { notify: message => messages.push(message) } };
  const api = {
    on: (name: string, handler: Handler) => events.set(name, handler),
    registerCommand: (name: string, value: { handler: Handler }) => commands.set(name, value.handler),
  } as unknown as ExtensionAPI;
  const fire = (name: string, mode = "tui") => events.get(name)?.({} as never, { ...ctx, mode });
  const command = (name: string, action: string) => commands.get(name)!(action as never, ctx);
  await extension(api);
  try {
    assert.equal(Image.prototype.render, stock, "discovery must not patch");
    assert.equal(ToolExecutionComponent.prototype.handleMouse, toolMouse);
    assert.deepEqual(Object.getOwnPropertyDescriptor(Image.prototype, "handleMouse"), imageMouse);
    for (const mode of ["print", "json", "rpc"]) {
      await fire("session_start", mode);
      await fire("turn_start", mode);
      assert.equal(Image.prototype.render, stock);
      assert.equal(ToolExecutionComponent.prototype.handleMouse, toolMouse);
      await fire("session_shutdown", mode);
    }
    await fire("session_start");
    assert.notEqual(Image.prototype.render, stock);
    assert.ok(isSliced());
    await command("math-render", "off");
    assert.ok(isSliced(), "turning formulas off must not disable ordinary-image compatibility");
    await command("math-images", "off");
    assert.equal(isSliced(), false);
    await command("math-render", "on");
    assert.equal(isSliced(), false, "turning formulas on must not enable ordinary-image compatibility");
    await command("math-images", "on");
    assert.ok(isSliced());
    await command("math-images", "clear");
    await command("math-images", "status");
    assert.match(messages.at(-1)!, /enabled.*fast \(1x\).*click-to-open on.*0 entries/);
    await command("math-images", "open"); // No cached source after clear: must not invoke code.
    assert.match(messages.at(-1)!, /No ordinary image/);
    await command("math-images", "click off");
    await command("math-images", "status");
    assert.match(messages.at(-1)!, /click-to-open off/);
    await command("math-images", "click on");
    await command("math-images", "sharp");
    assert.ok(isSliced());
    await command("math-images", "status");
    assert.match(messages.at(-1)!, /sharp \(2x\)/);
    await command("math-images", "off");
    await command("math-images", "fast");
    assert.equal(isSliced(), false, "changing quality must not enable a disabled adapter");
    await command("math-images", "on");
    assert.ok(isSliced());
    await command("math-images", "oops");
    assert.match(messages.at(-1)!, /Usage/);
    await fire("session_shutdown");
    await new Promise<void>(resolve => setImmediate(resolve));
    assert.equal(Image.prototype.render, stock);
    assert.equal(Markdown.prototype.render, markdownStock);
    assert.equal(ToolExecutionComponent.prototype.handleMouse, toolMouse);
    assert.deepEqual(Object.getOwnPropertyDescriptor(Image.prototype, "handleMouse"), imageMouse);
    await fire("turn_start");
    assert.equal(Image.prototype.render, stock);
    await fire("session_start");
    assert.ok(isSliced());
    await fire("session_shutdown");
    await fire("session_shutdown");
    assert.equal(Image.prototype.render, stock);
  } finally {
    await fire("session_shutdown");
    Image.prototype.render = stock;
    Markdown.prototype.render = markdownStock;
    for (const [key, value] of Object.entries(env)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    setCapabilities({ images: null, trueColor: false, hyperlinks: false });
  }
});
