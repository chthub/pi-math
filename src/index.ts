import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { getCapabilities } from "@earendil-works/pi-tui";
import { loadSvgMathRendererOptions } from "./config.js";
import { installMarkdownMathPatch, type MathPatchController } from "./markdown-patch.js";
import { createTerminalMathRenderer, type TerminalMathRenderer } from "./renderer.js";
import {
  installOrdinaryImagePatch,
  ordinaryImageCompatibilityAvailable,
  type OrdinaryImagePatchController,
} from "./ordinary-images.js";
import { installImageClickPatch, type ImageClickController } from "./image-click.js";
import { createVscodeImageOpener } from "./vscode-image-opener.js";

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
}

export default async function piMathExtension(pi: ExtensionAPI): Promise<void> {
  let renderer: TerminalMathRenderer | undefined;
  let loadFailure: string | undefined;
  try {
    renderer = await createTerminalMathRenderer(loadSvgMathRendererOptions());
  } catch (error) {
    loadFailure = errorMessage(error);
  }

  let patch: MathPatchController | undefined;
  let imagePatch: OrdinaryImagePatchController | undefined;
  let clickPatch: ImageClickController | undefined;
  let imageOpener: ReturnType<typeof createVscodeImageOpener> | undefined;
  let rearm: ReturnType<typeof setImmediate> | undefined;

  pi.on("session_start", (_event, ctx) => {
    // pi-streaming-guard replaces Markdown.render wholesale on session_start,
    // which would leave pi-math bypassed. Defer one macrotask so every
    // session_start handler has run, then re-layer pi-math on top and delegate
    // into whatever render won.
    if (ctx.mode === "tui") {
      if (renderer) patch ??= installMarkdownMathPatch(renderer);
      imagePatch ??= installOrdinaryImagePatch();
      imageOpener ??= createVscodeImageOpener({ notify: message => ctx.ui.notify(message, "warning") });
      const opener = imageOpener;
      clickPatch ??= installImageClickPatch(imagePatch, data => opener.open(data), message => ctx.ui.notify(message, "warning"));
      if (rearm) clearImmediate(rearm);
      rearm = setImmediate(() => {
        rearm = undefined;
        patch?.rearm();
        imagePatch?.rearm();
        clickPatch?.rearm();
      });
    }
    if (loadFailure && ctx.mode === "tui") {
      ctx.ui.notify(`pi-math failed to load: ${loadFailure}`, "error");
    }
  });

  // Re-assert the wrapper each turn: a mid-session "/streaming-guard on" (or
  // any wholesale re-patch) replaces Markdown.render between turns.
  pi.on("turn_start", () => {
    patch?.rearm();
    imagePatch?.rearm();
    clickPatch?.rearm();
  });

  pi.on("session_shutdown", async () => {
    if (rearm) clearImmediate(rearm);
    rearm = undefined;
    patch?.uninstall();
    patch = undefined;
    clickPatch?.uninstall();
    clickPatch = undefined;
    imagePatch?.uninstall();
    imagePatch = undefined;
    renderer?.clear();
    const opener = imageOpener;
    imageOpener = undefined;
    await opener?.dispose();
  });

  pi.registerCommand("math-images", {
    description: "VS Code images: on, off, fast, sharp, open, click on/off, status, clear",
    handler: async (args, ctx) => {
      if (!imagePatch) {
        ctx.ui.notify("pi-math image compatibility is available only in interactive TUI sessions", "info");
        return;
      }
      const action = args.trim().toLowerCase() || "status";
      if (action === "open") {
        if (!clickPatch?.openLatest()) ctx.ui.notify("No ordinary image is available; render/read an image with compatibility enabled first", "info");
        return;
      }
      if (action === "click on" || action === "click off") {
        clickPatch?.setEnabled(action === "click on");
        clickPatch?.rearm();
        ctx.ui.notify(`pi-math image click-to-open ${action === "click on" ? "enabled" : "disabled"}`, "info");
        return;
      }
      if (["on", "enable", "off", "disable"].includes(action)) {
        const enabled = action === "on" || action === "enable";
        imagePatch.setEnabled(enabled);
        imagePatch.rearm();
        ctx.ui.notify(`pi-math ordinary-image compatibility ${enabled ? "enabled" : "disabled"}; ${
          ordinaryImageCompatibilityAvailable() ? "applies on the next render" : "requires VS Code with Kitty images enabled, without tmux/screen"
        }`, "info");
        return;
      }
      if (action === "fast" || action === "sharp") {
        imagePatch.setQuality(action);
        ctx.ui.notify(`pi-math ordinary images: ${action} (${action === "fast" ? "1x, less scroll traffic" : "2x, sharper preview"}); applies on the next render`, "info");
        return;
      }
      if (action === "clear") {
        imagePatch.clear();
        ctx.ui.notify("pi-math ordinary-image caches cleared", "info");
        return;
      }
      if (action === "status") {
        const status = imagePatch.getStatus();
        ctx.ui.notify(`pi-math ordinary images: ${imagePatch.isEnabled() ? "enabled" : "disabled"}, ${
          ordinaryImageCompatibilityAvailable() ? "VS Code Kitty path available" : "inactive: requires VS Code + Kitty, no tmux/screen"
        }, ${status.quality} (${status.quality === "fast" ? "1x" : "2x"}), click-to-open ${clickPatch?.isEnabled() ? "on" : "off"}, ${status.cacheSize} entries, ${formatBytes(status.cacheBytes)}${status.lastFailure ? `, last failure: ${status.lastFailure}` : ""}`, "info");
        return;
      }
      ctx.ui.notify("Usage: /math-images on|off|fast|sharp|open|click on|click off|status|clear", "warning");
    },
  });

  pi.registerCommand("math-render", {
    description: "Control terminal LaTeX image rendering: on, off, status, or clear",
    handler: async (args, ctx) => {
      const action = args.trim().toLowerCase() || "status";
      if (!patch || !renderer) {
        ctx.ui.notify(`pi-math is unavailable: ${loadFailure ?? "renderer did not load"}`, "error");
        return;
      }
      if (action === "on" || action === "enable") {
        patch.setEnabled(true);
        ctx.ui.notify("pi-math enabled", "info");
        return;
      }
      if (action === "off" || action === "disable") {
        patch.setEnabled(false);
        ctx.ui.notify("pi-math disabled", "info");
        return;
      }
      if (action === "clear") {
        renderer.clear();
        patch.clearTransformCache();
        ctx.ui.notify("pi-math render caches cleared", "info");
        return;
      }
      if (action === "status") {
        const status = patch.isEnabled() ? "enabled" : "disabled";
        const protocol = getCapabilities().images ?? "unsupported terminal";
        const lastFailure = renderer.lastFailure ? `, last failure: ${renderer.lastFailure.code}` : "";
        ctx.ui.notify(
          `pi-math is ${status} (${protocol}, ${renderer.cacheSize} rasters, ${formatBytes(renderer.cacheBytes)}${lastFailure})`,
          "info",
        );
        return;
      }
      ctx.ui.notify("Usage: /math-render on|off|status|clear", "warning");
    },
  });
}
