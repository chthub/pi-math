import { ToolExecutionComponent } from "@earendil-works/pi-coding-agent";
import { Image, type Component, type TuiMouseEvent, type TuiMouseEventResult } from "@earendil-works/pi-tui";
import { ordinaryImageCompatibilityAvailable, type OrdinaryImagePatchController } from "./ordinary-images.js";

type MouseHandler = (this: Component, event: TuiMouseEvent) => TuiMouseEventResult | undefined;
type MouseComponent = Component & { handleMouse?: MouseHandler };
interface SelfShell {
  getRenderShell?: () => string;
  selfRenderHeight?: number;
  imageComponents?: Image[];
  imageSpacers?: Component[];
}

export interface ImageClickController {
  isEnabled(): boolean;
  setEnabled(value: boolean): void;
  rearm(): void;
  uninstall(): void;
  /** Keyboard alternative; opens the latest ordinary Image rendered in the transcript. */
  openLatest(): boolean;
}

function plainClick(event: TuiMouseEvent): boolean {
  return event.type === "click" && event.button === "left" && !event.shift && !event.ctrl && !event.alt
    && (event.clickCount ?? 1) === 1 && Number.isInteger(event.x) && Number.isInteger(event.y)
    && event.x >= 0 && event.y >= 0 && event.x < event.width && event.y < event.height;
}

/** Click-only adapter. No render changes, mouse capture, selection interception or scroll work. */
export function installImageClickPatch(
  images: Pick<OrdinaryImagePatchController, "isEnabled" | "getImageForOpening" | "getLatestImageForOpening">,
  open: (png: string) => Promise<void>,
  report: (message: string) => void = () => {},
  now: () => number = Date.now,
): ImageClickController {
  let enabled = process.env.PI_MATH_IMAGE_OPEN !== "0";
  let installed = true;
  const lastOpened = new WeakMap<Image, number>();
  const imagePrototype = Image.prototype as MouseComponent;
  const toolPrototype = ToolExecutionComponent.prototype as MouseComponent;
  const imageDelegates = new Map<MouseHandler, MouseHandler | undefined>();
  const toolDelegates = new Map<MouseHandler, MouseHandler | undefined>();
  const launch = (data: string) => {
    // The real opener reports friendly errors; this also guards a replaced/custom opener.
    void Promise.resolve().then(() => installed ? open(data) : undefined)
      .catch(() => {
        if (installed) {
          try { report("Could not open the image in VS Code"); } catch { /* UI may already be disposed. */ }
        }
      });
  };
  const wrapImage = (delegate?: MouseHandler): MouseHandler => {
    const wrapped: MouseHandler = function (event) {
      const result = delegate?.call(this, event);
      if (result || !installed || !enabled || !plainClick(event)) return result;
      const source = images.getImageForOpening(this as Image);
      if (!source || event.x >= source.columns || event.y >= source.rows) return undefined;
      // Pi may report both halves of a rapid image double-click as clickCount=1.
      // Coalesce those at the component level as well as the opener's in-flight hash guard.
      const time = now();
      const previous = lastOpened.get(this as Image);
      if (previous !== undefined && time >= previous && time - previous < 300) return { handled: true, render: false };
      lastOpened.set(this as Image, time);
      launch(source.data);
      return { handled: true, render: false }; // Do not trigger another PNG redraw just to open a tab.
    };
    imageDelegates.set(wrapped, delegate);
    return wrapped;
  };
  const wrapTool = (delegate?: MouseHandler): MouseHandler => {
    const wrapped: MouseHandler = function (event) {
      const result = delegate?.call(this, event);
      if (result || !installed || !enabled || !plainClick(event)
        || !images.isEnabled() || !ordinaryImageCompatibilityAvailable()) return result;
      // Pi's self-framed tools append Image children outside selfRenderContainer,
      // but their handleMouse forwards only the text region. Bridge just those
      // appended children, using the same layout as ToolExecutionComponent.render.
      // This guarded private shape is checked against both module and CLI hosts.
      const tool = this as unknown as SelfShell;
      if (typeof tool.getRenderShell !== "function" || tool.getRenderShell() !== "self" || !Number.isInteger(tool.selfRenderHeight)
        || tool.selfRenderHeight! < 0 || !Array.isArray(tool.imageComponents)
        || !Array.isArray(tool.imageSpacers)) return undefined;
      let top = tool.selfRenderHeight! > 0 ? tool.selfRenderHeight! + 1 : 0;
      if (event.y < top) return undefined;
      for (const [index, image] of tool.imageComponents.entries()) {
        const spacer = tool.imageSpacers[index];
        if (spacer) {
          if (typeof spacer.render !== "function") return undefined;
          top += spacer.render(event.width).length;
        }
        if (!(image instanceof Image)) return undefined;
        const height = image.render(event.width).length;
        if (event.y >= top && event.y < top + height) {
          return (image as MouseComponent).handleMouse?.({ ...event, y: event.y - top, height });
        }
        top += height;
      }
      return undefined;
    };
    toolDelegates.set(wrapped, delegate);
    return wrapped;
  };
  const rearm = () => {
    if (!installed) return;
    if (!imagePrototype.handleMouse || !imageDelegates.has(imagePrototype.handleMouse)) {
      imagePrototype.handleMouse = wrapImage(imagePrototype.handleMouse);
    }
    if (!toolPrototype.handleMouse || !toolDelegates.has(toolPrototype.handleMouse)) {
      toolPrototype.handleMouse = wrapTool(toolPrototype.handleMouse);
    }
  };
  const restore = (prototype: MouseComponent, delegates: Map<MouseHandler, MouseHandler | undefined>) => {
    const current = prototype.handleMouse;
    if (!current || !delegates.has(current)) return;
    const delegate = delegates.get(current);
    if (delegate) prototype.handleMouse = delegate;
    else delete prototype.handleMouse;
  };
  rearm();
  return {
    isEnabled: () => enabled,
    setEnabled(value) { enabled = value; },
    rearm,
    openLatest() {
      if (!installed) return false;
      const source = images.getLatestImageForOpening();
      if (!source) return false;
      launch(source.data);
      return true;
    },
    uninstall() {
      if (!installed) return;
      installed = false;
      enabled = false;
      restore(imagePrototype, imageDelegates);
      restore(toolPrototype, toolDelegates);
    },
  };
}
