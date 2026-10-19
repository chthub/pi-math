# pi-math

Render LaTeX in the Pi TUI as real, transparent terminal images.

This fork adds VS Code compatibility for formula images and ordinary image previews
without modifying Pi's installed files. It builds on [upstream pi-math](https://github.com/monotykamary/pi-math).

pi-math uses MathJax for mathematical typesetting and Resvg for rasterization. It does not approximate formulas with Unicode glyphs or hand-built character geometry.

![Long-form English mathematics with inline and display MathJax rendered in Ghostty through Pi Markdown](docs/images/pi-math-showcase.png)

## Features

- Genuine LaTeX layout through MathJax SVG
- Transparent, theme-colored PNG output through Resvg
- True inline image formulas in Kitty and Ghostty through Unicode virtual placements
- Compatible Kitty graphics and iTerm2 display-image placement through Pi TUI
- Inline delimiters: `$...$` and `\(...\)`
- Display delimiters: `$$...$$` and `\[...\]`
- Common display environments, including `equation`, `align`, `aligned`, `gather`, matrices, cases, and amscd `CD` diagrams
- Native MathJax support for fractions, roots, scripts, limits, scalable fences, `\boxed`, and nested structures
- One consistent base formula size across messages
- Minimum necessary proportional shrinking when a formula exceeds the content width
- Cell-aware centering and automatic rerendering after terminal resize
- Alpha-bound clipping detection, dynamic raster density, and minimal adaptive transparent safety bleed
- Separate byte-bounded SVG and PNG caches
- Configurable TeX macros, environments, font files, and cross-platform system-font discovery
- Original LaTeX fallback when image rendering or a formula is unsupported
- Display-only transformation: stored messages and model context are never rewritten
- Local, in-process rendering with no browser, network request, or child process on the render path
- Optional click-to-open ordinary images in a VS Code editor tab (launcher runs only on explicit open)

## Requirements

- Pi 1.0.0 or newer for this fork's ordinary-image and mouse adapters (tested on 1.0.0 and 1.3.0)
- Node.js 22.19 or newer
- A terminal image protocol recognized by Pi:
  - Full inline and display rendering: Ghostty and Kitty
  - Display rendering plus compatibility inline placement: WezTerm and Warp
  - Display rendering: iTerm2
  - VS Code integrated terminal: compatibility rendering with images enabled and
    the process-local Kitty override described below

Pi intentionally disables terminal images inside tmux and screen. In those environments, and in terminals without a supported image protocol, pi-math leaves the original LaTeX visible.

## Installation

This fork builds on upstream 0.5.8. Its VS Code row-image path is covered by
automated tests and offscreen redraw checks against Pi 1.0.0 and 1.0.2 in
fullscreen and regular modes, and has been visually verified in a VS Code
integrated terminal. Pi coding-agent and TUI remain host-provided wildcard peers;
no host source patches are required. The ordinary-image adapter has additionally
passed protocol checks against the module and actual CLI-bundled TUI in Pi 1.0.0
and 1.3.0; it still needs visual verification in your terminal.

Install this fork:

```bash
pi install git:github.com/chthub/pi-math
```

If the upstream npm package is already configured, remove it first to avoid loading
two copies of the Markdown patch:

```bash
pi remove npm:@monotykamary/pi-math
```

The upstream npm package does not contain this fork's VS Code fix.

For local development, clone this fork and register the checkout directly:

```bash
git clone https://github.com/chthub/pi-math.git
cd pi-math
bun install --frozen-lockfile --ignore-scripts
pi install "$PWD"
```

Keep a checkout outside Pi's auto-discovered extension directories when using
`pi install "$PWD"`; there is no need to create an additional extension symlink.

Reload Pi after installation:

```text
/reload
```

Pi discovers `src/index.ts` through the `pi.extensions` field in `package.json`.

## Usage

Use normal LaTeX delimiters in user or assistant messages:

```markdown
Euler's identity is $e^{i\pi}+1=0$.

\[
x=\frac{-b\pm\sqrt{b^2-4ac}}{2a}
\]

\[
\begin{aligned}
f(x)&=(x-a)q(x)+r,\\
f(a)&=r.
\end{aligned}
\]
```

Ghostty and Kitty render embedded formulas as real one-row image cells, so prose, punctuation, and list items remain intact. Standalone and display formulas use centered image blocks. Other terminals use the safest protocol-specific behavior available; the Markdown source always remains unchanged.

## VS Code terminal compatibility

Enable terminal images and GPU acceleration in VS Code settings:

```json
{
  "terminal.integrated.enableImages": true,
  "terminal.integrated.gpuAcceleration": "auto"
}
```

Pi does not auto-detect VS Code's image protocol. Start Pi in a VS Code integrated
terminal with a process-local override:

```bash
PI_IMAGE_PROTOCOL=kitty pi
```

When `TERM_PROGRAM=vscode` and Pi reports Kitty images, multi-row display formulas
are cropped into independent one-row PNGs. Later TUI row clears cannot erase the
lower part of an already-drawn formula. Cropping preserves the completed formula's
pixels, alpha, scale, centering, and source text; it does not re-typeset the formula.
Each row has a distinct image ID retained across append-only streaming. Row crops
are byte-cached and released on `/math-render clear` or shutdown. Other terminals
retain their existing placement behavior. VS Code formula images (including inline
and single-row formulas) also bypass Pi's placement-only upload cache, since VS Code
currently deletes stored data even for Kitty `d=a`. This changes transmission only,
not formula pixels or layout. No Pi TUI source patch or terminal identity spoofing
is required.

This remains a compatibility path, not automatic protocol detection. Do not force
Kitty globally or inside tmux/screen. After installation or changes, run `/reload`,
then `/math-render status` to confirm image rendering is enabled with `kitty`.
Check a multi-row display formula, scroll it, and resize the terminal. Unsupported
terminals retain the source LaTeX. No terminal identity spoofing is needed.

### Ordinary images in VS Code

The same package also provides an independent runtime adapter for Pi's `Image`
component, covering ordinary tool-result images and attachments using that component.
It is enabled by default, but only operates in VS Code with Kitty images already
selected and without tmux/screen. It never overrides Pi's capability settings.
Custom renderers that bypass `Image` are not covered.

The adapter takes the PNG already prepared by Pi (including host-supported JPEG,
WebP or GIF conversion), creates a proportional terminal preview, and splits it
into independent one-row PNGs. The default `fast` mode uses 1x terminal-cell pixel
density; `sharp` uses the previous 2x density. Both occupy exactly the same terminal
cells. Each PNG is losslessly recompressed once before caching, without changing
its filtered pixel data. Every row is transmitted with its data,
including single-row pictures. It deliberately avoids Pi's placement-only upload
cache: VS Code currently deletes stored data even for the Kitty `d=a` selector.
This addresses both partial erasure and disappearance after the next tool call.

Cropping/encoding is cached by image and geometry (128 entries, 32 MiB); unchanged
rows stay byte-identical. Redrawing visible image rows still sends data again,
so this is not a zero-bandwidth workaround. Only the terminal preview is resized;
image attachments, tool results, stored sessions and model inputs remain untouched. These limits apply after Pi
has decoded/converted the source; they do not bound the host's earlier decoder work.
Very long transcripts exceeding the cache capacity may need repeated rasterization.
Inputs above 32 MiB encoded/32 megapixels, previews above 4 megapixels or 256 × 128
cells, and unknown/malformed encodings retain the native renderer. Check
`/math-images status` for safety-limit/conversion failures. Native fallback can still
show the original terminal bug; open the original file in VS Code in that case.

```text
/reload
/math-images status
```

If status says inactive, restart Pi in the VS Code terminal with
`PI_IMAGE_PROTOCOL=kitty pi --resume`, then select the session. `/math-images on`
does not force-enable an unsupported protocol. The extension installs a reversible
`Image.prototype.render` wrapper rather than editing Pi's files. Pi updates do not
delete it, but changes to host rendering APIs still require compatibility checks.
This is an opt-in Kitty compatibility setup, not official Pi support for VS Code.

Set `PI_MATH_VSCODE_IMAGES=0` before starting Pi to disable this adapter by default.
The `/math-images` commands never change the formula rendering switch, and
`/math-render off` does not disable ordinary-image compatibility.

#### Open an image in a VS Code tab

In Pi **fullscreen mode**, single-left-click an ordinary image to open its PNG
snapshot in VS Code's built-in image preview in the same window. The VS Code
Remote SSH `code` CLI must be on PATH and `VSCODE_IPC_HOOK_CLI` must be available.
The launcher requires a POSIX host (Linux/macOS, including Remote SSH from any
client OS); native Windows launching is not implemented. No separate VS Code
extension is required. Wheel, drag selection, modified clicks,
formula images and the blank area beside a picture are not intercepted.

```text
/math-images open       Keyboard alternative: open the latest rendered ordinary image
/math-images click off  Disable mouse activation (keyboard open remains available)
/math-images click on   Enable mouse activation (default)
```

Regular terminal mode does not route mouse clicks to components; use the keyboard
command there. To disable clicking at startup, set `PI_MATH_IMAGE_OPEN=0`.
Opening requires the ordinary-image compatibility adapter to be enabled.

The snapshot uses Pi's full host-prepared PNG, **before** fast/sharp preview scaling.
It may already have been resized by a tool or converted from JPEG/WebP/GIF by Pi;
it is not necessarily the original file on disk. A snapshot is created only on
explicit open, with a private temporary directory (0700) and PNG files (0600).
`code --reuse-window` opens it; clicking the same image reuses its hash-named file
rather than creating endless duplicate tabs. The editor controls focus/tab behavior.

Snapshots are limited to 32 files / 128 MiB per session and removed on `/reload`
or Pi shutdown. Save a copy elsewhere if you want to keep it or reopen its tab
later. CLI attempts have a 10-second timeout and bounded output; failures terminate
only that invocation's isolated process group, including wrapper children, not the
existing VS Code server. No files/processes are created just by rendering or scrolling. Click opening
is a reversible runtime mouse adapter, including a guarded bridge for Pi's
self-framed tool images; it does not modify installed Pi files.

#### Scrolling performance

VS Code still needs full data for visible rows whenever Pi moves/redraws images.
Raster caching prevents repeat image conversion, but not terminal transfer and
PNG decoding. Default `fast` mode uses one quarter of `sharp` mode's pixels, reducing
that work; previews may look softer on high-DPI displays. Formula density is unchanged.

```text
/math-images fast     Lower traffic: 1x preview (default)
/math-images sharp    Higher-detail 2x preview
```

These are session-only choices; `PI_MATH_IMAGE_QUALITY=sharp` selects sharp mode at
startup. Switching quality clears only the ordinary-image cache and takes effect
on the next render; it never enables an adapter that was turned off. `/reload`
restores the startup default.

In a synthetic 60-column, 20-row photo/noise example, fullscreen scroll output
fell from about 2474 KiB/frame (old 2x) to 545 KiB/frame (1x + lossless compaction).
A chart/UI sample fell from 41 to 21 KiB/frame. These are mock-terminal byte counts,
not measured VS Code frame rates; all modes still decode 20 row PNGs in that example.
If scrolling remains slow, the remaining per-row decode/compositing work is not
eliminated by this optimization.

## Commands

```text
/math-render status   Show protocol, raster count, cache bytes, and last failure
/math-render on       Enable formula rendering
/math-render off      Disable formula rendering
/math-render clear    Clear formula and Markdown transform caches
/math-images status  Show ordinary-image compatibility state, cache and failure
/math-images on      Enable VS Code ordinary-image compatibility
/math-images off     Return ordinary images to Pi's native renderer
/math-images clear   Clear the independent ordinary-image cache
/math-images fast    Select 1x previews (default; less scroll traffic)
/math-images sharp   Select 2x previews (more detail, more scroll traffic)
/math-images open    Open the latest rendered ordinary PNG snapshot in VS Code
/math-images click on|off  Toggle image click-to-open
```

Rendering is enabled by default.

## Sizing behavior

Every formula starts at the same base scale: `0.50 × terminal cell height` pixels per MathJax `ex`.

- Formulas that fit use that scale unchanged.
- Formulas are never enlarged to fill available space.
- An overwide formula is reduced only enough to fit the current Markdown content width.
- Width and height always use the same scale, preserving the complete formula's aspect ratio.
- The raster is padded, not stretched, to an exact integer number of terminal cells.
- Embedded inline formulas are proportionally contained in one terminal row so they can share a line with text.
- Small rasters use 2× device density; exceptionally large terminal canvases fall back to 1× instead of failing.

Resizing the terminal creates a layout-specific render. A formula returns to the base scale whenever the wider content area can contain it.

## Optional configuration

Configuration is read when the extension loads:

```text
PI_MATH_MACROS          JSON object of MathJax configmacros definitions
PI_MATH_ENVIRONMENTS    JSON object of MathJax custom environment definitions
PI_MATH_FONT_FILES      Font files separated by the platform path delimiter
PI_MATH_SYSTEM_FONTS    true/false; enabled by default for Unicode text fallback
PI_MATH_COLOR           Explicit formula ink color as #rrggbb
PI_MATH_VSCODE_IMAGES   0 disables the ordinary-image adapter (default enabled)
PI_MATH_IMAGE_QUALITY   fast (default, 1x) or sharp (2x) ordinary-image previews
PI_MATH_IMAGE_OPEN      0 disables mouse click-to-open (keyboard open still works)
```

Formula ink follows the surrounding Markdown text: the component's own default text color when present (for example, custom message text), otherwise the active Pi theme's `text` token. Pi's built-in dark and light themes therefore give matching formula colors in both modes, and custom themes with a concrete `text` token work the same way. Themes that leave `text` at the terminal default get a mode-appropriate neutral color; set `PI_MATH_COLOR` to pin an exact value. Pi's transient italic reasoning stream keeps source LaTeX instead of rasterizing formulas that are rebuilt on every token.

Macro names may be written with or without the leading backslash. Explicit font files are validated before renderer initialization. System font discovery is performed in-process by Resvg and contains no platform-specific hardcoded paths. Reload Pi after changing these variables.

## Fallback behavior

pi-math leaves the original delimiters and LaTeX visible when:

- Pi reports no supported image protocol;
- rendering is disabled with `/math-render off`;
- MathJax rejects incomplete or unsupported input;
- a safety limit is exceeded; or
- the renderer cannot initialize on the current platform.

Fallback is source-preserving; there is no Unicode approximation path.

## How it works

```text
Markdown LaTeX
    ↓ protected span detection
MathJax TeX → SVG
    ↓ fixed scale or minimum width fit
Resvg → transparent PNG on an integer-cell canvas
    ↓
Pi TUI image placement
    ↓
Kitty Unicode placeholders / Kitty graphics / iTerm2 images
```

Pi does not currently expose a renderer override for ordinary user and assistant messages. pi-math therefore installs a reversible wrapper around `Markdown.render()`. It swaps protected markers into the render pass, inserts terminal image sequences, and restores the original Markdown before returning.

### Streaming render extensions

Extensions like [pi-streaming-guard](https://github.com/monotykamary/pi-streaming-guard) replace `Markdown.render()` wholesale instead of chaining through previous wrappers, which would bypass formula rendering. pi-math cooperates: after session startup settles and at the start of every turn it re-asserts itself as the outermost renderer and delegates into whichever render is active underneath, so the guard's incremental token caching and pi-math's formula images compose without configuration. Toggling the guard mid-session heals on the next turn at the latest. Completed formulas keep stable image IDs across append-only assistant deltas, so Pi's differential renderer does not retransmit every earlier PNG as later tokens arrive.

See [Architecture](docs/ARCHITECTURE.md) for module boundaries, cache behavior, sizing invariants, and failure handling.

## Development

```bash
bun install
bun run check
bun run test:vscode
bun run test:images
bun run test:image-click
bun run bench:images
bun run visual -- gallery
bun run visual -- radical
bun run visual -- aligned
bun run visual -- complex
bun run visual -- theory
bun run visual -- inline
```

`bun run test:vscode` captures offscreen writes from the development Pi host in
fullscreen and regular modes. It checks that later clears never overlap earlier
formula row images, including streaming, resize, and viewport clipping. To test an
installed host instead (without changing it or accessing credentials):

```bash
PI_MATH_TEST_HOST=/path/to/node_modules/@earendil-works/pi-coding-agent bun run test:vscode
```

`bun run test:images` runs ordinary-image redraw checks without starting a real
terminal or contacting a model. It also accepts `PI_MATH_TEST_HOST`. The model of
VS Code's image storage explicitly treats `d=a` as deleting both data and placements;
this is protocol regression coverage, not visual validation of a browser renderer.
The current checks pass 40 scenarios on Pi 1.0.0 and 42 on Pi 1.3.0, covering both
module and CLI-bundled classes. Pi 1.0 has no `setImageTranscoder` export, so its
conversion-integration tests are skipped explicitly; Pi 1.3 exercises the hook with
a converter spy (not a codec test). `bun run bench:images` compares actual extension
fast/sharp output with independent original-2x and recompressed candidates on
synthetic fixtures; it reports scroll-frame bytes and Node/mock-terminal timing,
not real GUI performance. After upgrading Pi, test a PNG/JPG across another tool
call, scroll and resize in VS Code as well.

`bun run test:image-click` checks actual-host SGR mouse routing, self/default tool
shells, clipped images, drag/scroll exclusions, rapid-click coalescing and cleanup.
It accepts `PI_MATH_TEST_HOST` and passes 26 checks each on Pi 1.0.0 and 1.3.0,
covering module and actual CLI exports. Opening is mocked: these checks never launch
VS Code. Confirm the real editor tab manually after `/reload`.

Set `MATH_WIDTH` to exercise a specific Markdown width:

```bash
MATH_WIDTH=60 bun run visual -- theory
```

The automated suite covers MathJax rasterization, transparent ink bounds, fixed and width-limited scales, one-row inline fitting, dynamic raster density, tall formulas, macros, tags, Unicode text, malformed-input diagnostics, nested/commented TeX scanning, Markdown code exclusion, Kitty Unicode placeholders, Kitty/iTerm2 compatibility placement, capability fallback, resize layout, byte-bounded LRU behavior, cache stability, source restoration, and patch removal.

## Runtime dependencies

- [MathJax 3](https://github.com/mathjax/MathJax-src) — TeX parsing and SVG layout, Apache-2.0
- [Resvg JS](https://github.com/yisibl/resvg-js) — in-process SVG rasterization, MPL-2.0

`@resvg/resvg-js` uses platform-specific native packages. Installation must include the matching optional dependency for the target operating system and architecture.

## License

pi-math is available under the [MIT License](LICENSE).

Copyright (c) 2026 Fadouse.
