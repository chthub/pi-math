import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { chmod, mkdtemp, open as openFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import { crc32, inflateSync } from "node:zlib";

const MAX_ENCODED_BYTES = 32 * 1024 * 1024;
const MAX_PIXELS = 32 * 1024 * 1024;
const MAX_STORED_BYTES = 128 * 1024 * 1024;
const SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const WINDOWS_UNSUPPORTED = "Image preview requires a POSIX host (for example Remote SSH); native Windows CLI launching is not supported.";

export interface VscodeImageLaunchOptions {
  env: NodeJS.ProcessEnv;
  shell: false;
  timeout: number;
  maxBuffer: number;
  killSignal: "SIGKILL";
  encoding: "utf8";
  windowsHide: true;
}

export interface VscodeImageOpenerOptions {
  notify?: (message: string) => void;
  /** Injection points for offline tests; production normally supplies only notify. */
  env?: NodeJS.ProcessEnv;
  tempRoot?: string;
  launch?: (command: string, args: string[], options: VscodeImageLaunchOptions) => Promise<void>;
  /** May lower, never raise, the session's 128 MiB storage budget. */
  maxStoredBytes?: number;
  /** Test/embedding override: positive milliseconds, capped at the 10 second default. */
  timeoutMs?: number;
}

function launchCode(command: string, args: string[], options: VscodeImageLaunchOptions): Promise<void> {
  // Windows has no POSIX process-group signalling. Do not claim a bounded process
  // tree there; Remote SSH on a POSIX host remains supported from any client OS.
  if (process.platform === "win32") {
    return Promise.reject(Object.assign(new Error("POSIX CLI process groups required"), { code: "ENOTSUP" }));
  }
  return new Promise((resolve, reject) => {
    // Remote SSH's code executable can be a shell wrapper that starts Node without
    // exec. Give this invocation its OWN session/group, never the existing server's.
    const child = spawn(command, args, {
      env: options.env, shell: false, detached: true, windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let failure: Error | undefined;
    let terminating = false;
    let outputBytes = 0;
    const terminate = (error: Error) => {
      failure ??= error;
      if (terminating) return;
      terminating = true;
      if (child.pid !== undefined) {
        try { process.kill(-child.pid, "SIGKILL"); }
        catch (killError) {
          // ESRCH means this invocation's group has already disappeared. Never
          // search by process name or signal a server outside the known group.
          if ((killError as NodeJS.ErrnoException).code !== "ESRCH") {
            try { child.kill("SIGKILL"); } catch { /* Best effort if the OS refuses signalling. */ }
          }
        }
      }
    };
    const timer = setTimeout(() => terminate(Object.assign(new Error("CLI timeout"), {
      code: "ETIMEDOUT", killed: true, signal: "SIGKILL",
    })), options.timeout);
    const discard = (data: Buffer) => {
      if (terminating) return;
      outputBytes += data.length;
      if (outputBytes > options.maxBuffer) {
        terminate(Object.assign(new Error("CLI output limit"), { code: "EOUTPUTLIMIT" }));
      }
    };
    // Count a combined stdout/stderr budget without accumulating or logging either.
    child.stdout.on("data", discard);
    child.stderr.on("data", discard);
    child.stdout.on("error", terminate);
    child.stderr.on("error", terminate);
    child.once("error", error => { failure ??= error; });
    // Keep the timeout through 'exit': a wrapper may exit while its descendant
    // still owns the pipes. Resolve only after 'close' and leave no timer behind.
    child.once("close", (code, signal) => {
      clearTimeout(timer);
      if (failure) reject(failure);
      else if (code === 0) resolve();
      else reject(Object.assign(new Error("CLI failed"), { code, signal }));
    });
  });
}

/** Validate the complete PNG container and bounded scanline stream, including Adam7. */
function decodePng(base64: string): Buffer {
  if (base64.length > MAX_ENCODED_BYTES) throw new Error("Image preview: PNG exceeds the 32 MiB encoded limit.");
  if (!base64.length || base64.length % 4 || !/^[A-Za-z0-9+/]*={0,2}$/u.test(base64)) {
    throw new Error("Image preview: invalid PNG snapshot.");
  }
  const png = Buffer.from(base64, "base64");
  const invalid = () => { throw new Error("Image preview: invalid PNG snapshot."); };
  if (png.toString("base64") !== base64 || !png.subarray(0, 8).equals(SIGNATURE)) return invalid();
  let offset = 8;
  let width = 0, height = 0, depth = 0, color = 0, interlace = 0;
  let ended = false, palette = false, idatEnded = false;
  const idat: Buffer[] = [];
  while (offset + 12 <= png.length) {
    const length = png.readUInt32BE(offset);
    const end = offset + length + 12;
    if (end > png.length) return invalid();
    const type = png.toString("ascii", offset + 4, offset + 8);
    const data = png.subarray(offset + 8, end - 4);
    if (!/^[A-Za-z]{4}$/u.test(type) || crc32(png.subarray(offset + 4, end - 4)) !== png.readUInt32BE(end - 4)) return invalid();
    if (offset === 8) {
      if (type !== "IHDR" || length !== 13) return invalid();
      width = data.readUInt32BE(0); height = data.readUInt32BE(4);
      depth = data[8]!; color = data[9]!; interlace = data[12]!;
      if (!width || !height || width * height > MAX_PIXELS) throw new Error("Image preview: PNG exceeds the 32 megapixel dimension limit.");
      const depths: Record<number, number[]> = { 0: [1, 2, 4, 8, 16], 2: [8, 16], 3: [1, 2, 4, 8], 4: [8, 16], 6: [8, 16] };
      if (!depths[color]?.includes(depth) || data[10] !== 0 || data[11] !== 0 || interlace > 1) return invalid();
    } else if (type === "IHDR") return invalid();
    else if (type === "PLTE") {
      if (palette || idat.length || !length || length % 3 || length > 768 || color === 0 || color === 4) return invalid();
      palette = true;
    } else if (type === "IDAT") {
      if (idatEnded || (color === 3 && !palette)) return invalid();
      idat.push(data);
    } else if (type === "IEND") {
      if (length || !idat.length) return invalid();
      ended = true; offset = end; break;
    } else {
      // Unknown critical chunks cannot be safely interpreted as a PNG snapshot.
      if (type[0] === type[0]!.toUpperCase()) return invalid();
      if (idat.length) idatEnded = true;
    }
    offset = end;
  }
  if (!ended || offset !== png.length) return invalid();
  const channels = ({ 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 } as Record<number, number>)[color]!;
  const passes = interlace ? [[0, 0, 8, 8], [4, 0, 8, 8], [0, 4, 4, 8], [2, 0, 4, 4], [0, 2, 2, 4], [1, 0, 2, 2], [0, 1, 1, 2]] : [[0, 0, 1, 1]];
  const scanlines = passes.map(([x, y, dx, dy]) => {
    const columns = Math.max(0, Math.ceil((width - x!) / dx!));
    const rows = columns ? Math.max(0, Math.ceil((height - y!) / dy!)) : 0;
    return { rows, bytes: 1 + Math.ceil(columns * channels * depth / 8) };
  });
  const expected = scanlines.reduce((total, pass) => total + pass.rows * pass.bytes, 0);
  let pixels: Buffer;
  try { pixels = inflateSync(Buffer.concat(idat), { maxOutputLength: expected }); }
  catch { return invalid(); }
  if (pixels.length !== expected) return invalid();
  let position = 0;
  for (const pass of scanlines) for (let row = 0; row < pass.rows; row++) {
    if (pixels[position]! > 4) return invalid();
    position += pass.bytes;
  }
  return png;
}

/** Creates no files or processes until an explicit open(). All methods are safe to fire-and-forget. */
export function createVscodeImageOpener(options: VscodeImageOpenerOptions = {}): {
  open(base64Png: string): Promise<void>;
  dispose(): Promise<void>;
} {
  let disposed = false;
  let directory: string | undefined;
  let disposal: Promise<void> | undefined;
  let queue: Promise<void> = Promise.resolve();
  let storedBytes = 0;
  const requestedBudget = options.maxStoredBytes ?? MAX_STORED_BYTES;
  const budget = Number.isFinite(requestedBudget)
    ? Math.min(MAX_STORED_BYTES, Math.max(0, Math.floor(requestedBudget))) : MAX_STORED_BYTES;
  const requestedTimeout = options.timeoutMs ?? 10_000;
  const timeout = Number.isFinite(requestedTimeout) && requestedTimeout > 0
    ? Math.min(10_000, Math.max(1, Math.floor(requestedTimeout))) : 10_000;
  const files = new Map<string, { size: number; path?: string }>();
  const pending = new Map<string, Promise<void>>();
  const notify = (message: string) => { try { options.notify?.(message); } catch { /* UI may already be gone. */ } };
  const env = options.env ?? process.env;

  function open(base64Png: string): Promise<void> {
    if (disposed) return Promise.resolve();
    if (env.TERM_PROGRAM?.toLowerCase() !== "vscode" || !env.VSCODE_IPC_HOOK_CLI?.trim()) {
      notify("Image preview requires a VS Code integrated terminal with VSCODE_IPC_HOOK_CLI (including Remote SSH).");
      return Promise.resolve();
    }
    if (process.platform === "win32" && !options.launch) {
      notify(WINDOWS_UNSUPPORTED);
      return Promise.resolve(); // POSIX file permissions/group cleanup are not available here.
    }
    let png: Buffer;
    try { png = decodePng(base64Png); }
    catch (error) { notify(error instanceof Error ? error.message : "Image preview: invalid PNG snapshot."); return Promise.resolve(); }
    const hash = createHash("sha256").update(png).digest("hex");
    const active = pending.get(hash);
    if (active) return active;
    let entry = files.get(hash);
    if (!entry) {
      if (files.size >= 32 || storedBytes + png.length > budget) {
        notify("Image preview storage is full (32 files / 128 MiB maximum). Existing previews are kept until session shutdown.");
        return Promise.resolve();
      }
      entry = { size: png.length };
      files.set(hash, entry);
      storedBytes += png.length; // Reserve before queueing, including concurrent clicks.
    }
    const record = entry;
    const launchEnv = { ...env };
    const operation = queue.then(async () => {
      if (disposed) return;
      try {
        if (!directory) {
          const root = options.tempRoot ?? tmpdir();
          if (!isAbsolute(root)) throw new Error("non-absolute temporary root");
          directory = await mkdtemp(join(root, "pi-math-images-"));
          await chmod(directory, 0o700);
        }
        if (disposed) return;
        if (!record.path) {
          const path = join(directory, `${hash}.png`);
          let created = false;
          try {
            const file = await openFile(path, "wx", 0o600);
            created = true;
            try { await file.writeFile(png); await file.chmod(0o600); }
            finally { await file.close(); }
          } catch (error) {
            if (created) await rm(path, { force: true }).catch(() => {});
            throw error;
          }
          record.path = path;
        }
      } catch {
        if (!record.path) { files.delete(hash); storedBytes -= record.size; }
        notify("Image preview: could not save the private temporary PNG snapshot.");
        return;
      }
      if (disposed) return;
      try {
        await (options.launch ?? launchCode)("code", ["--reuse-window", record.path!], {
          env: launchEnv, shell: false, timeout, maxBuffer: 4096,
          killSignal: "SIGKILL", encoding: "utf8", windowsHide: true,
        });
      } catch (error) {
        const failure = error as { code?: unknown; killed?: unknown; signal?: unknown } | null;
        notify(failure?.code === "ENOTSUP"
          ? WINDOWS_UNSUPPORTED
          : failure?.code === "EOUTPUTLIMIT"
            ? "Image preview: code CLI exceeded the output limit; its process group was terminated."
          : failure?.code === "ENOENT"
            ? "Image preview: code CLI was not found. Use the VS Code integrated terminal / Remote SSH CLI."
          : failure?.killed || failure?.signal === "SIGKILL"
            ? "Image preview: code CLI timed out or was terminated (10 second limit)."
            : "Image preview: code CLI failed to open the snapshot. Check the current VS Code Remote SSH connection.");
      }
    }).catch(() => { notify("Image preview failed; no source paths or image data were logged."); });
    const finished = operation.finally(() => { pending.delete(hash); });
    pending.set(hash, finished);
    queue = finished;
    return finished;
  }

  function dispose(): Promise<void> {
    if (disposal) return disposal;
    disposed = true;
    disposal = queue.then(async () => {
      if (directory) {
        try { await rm(directory, { recursive: true, force: true }); }
        catch { notify("Image preview: temporary snapshots could not be removed at shutdown."); }
      }
      files.clear(); pending.clear(); storedBytes = 0;
    });
    return disposal;
  }
  return { open, dispose };
}
