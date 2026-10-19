import assert from "node:assert/strict";
import test from "node:test";
import { chmod, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";
import { crc32, deflateSync } from "node:zlib";
import { createVscodeImageOpener, type VscodeImageLaunchOptions } from "../src/vscode-image-opener.js";

function chunk(type: string, data: Buffer): Buffer {
  const output = Buffer.alloc(data.length + 12);
  output.writeUInt32BE(data.length, 0); output.write(type, 4, "ascii");
  data.copy(output, 8);
  output.writeUInt32BE(crc32(output.subarray(4, -4)), output.length - 4);
  return output;
}
function png(seed = 0, width = 1, height = 1, raw = Buffer.from([0, seed, 20, 30, 255])): Buffer {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0); header.writeUInt32BE(height, 4);
  header[8] = 8; header[9] = 6;
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", header),
    chunk("IDAT", deflateSync(raw)), chunk("IEND", Buffer.alloc(0)),
  ]);
}
const environment = () => ({ TERM_PROGRAM: "vscode", VSCODE_IPC_HOOK_CLI: "/synthetic/remote-secret-socket" });
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}
async function setup() {
  const root = await mkdtemp(join(tmpdir(), "pi-math-opener-test-"));
  const calls: { command: string; args: string[]; options: VscodeImageLaunchOptions }[] = [];
  const messages: string[] = [];
  const launch = async (command: string, args: string[], options: VscodeImageLaunchOptions) => { calls.push({ command, args, options }); };
  return { root, calls, messages, launch, notify: (message: string) => { messages.push(message); }, cleanup: () => rm(root, { recursive: true, force: true }) };
}

async function knownPid(root: string, name: string): Promise<number | undefined> {
  try {
    const text = (await readFile(join(root, `${name}.pid`), "utf8")).trim();
    assert.match(text, /^[0-9]+$/);
    const pid = Number(text);
    assert.ok(Number.isSafeInteger(pid) && pid > 1 && pid !== process.pid);
    return pid;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}
async function isRunning(pid: number): Promise<boolean> {
  if (process.platform === "linux") {
    try {
      const info = await readFile(`/proc/${pid}/stat`, "utf8");
      // Orphaned SIGKILL victims can briefly remain zombies until PID 1 reaps them;
      // kill(pid, 0) alone would incorrectly classify those as running descendants.
      const state = info.slice(info.lastIndexOf(")") + 1).trim().split(/\s+/u)[0];
      return state !== "Z" && state !== "X";
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
      throw error;
    }
  }
  try {
    const state = execFileSync("ps", ["-o", "stat=", "-p", String(pid)], {
      encoding: "utf8", timeout: 1000, maxBuffer: 1024, stdio: ["ignore", "pipe", "pipe"],
    }).trim();
    return state.length > 0 && !state.startsWith("Z") && !state.startsWith("X");
  } catch (error) {
    if ((error as { status?: number }).status === 1) return false;
    throw error;
  }
}
async function killKnownTestProcesses(root: string): Promise<void> {
  const wrapper = await knownPid(root, "wrapper");
  const child = await knownPid(root, "child");
  // Only PIDs written by THIS private fake CLI fixture; no name-based process kill.
  for (const pid of [wrapper === undefined ? undefined : -wrapper, child, wrapper]) {
    if (pid === undefined) continue;
    try { process.kill(pid, "SIGKILL"); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error; }
  }
}

test("discovery/disposal is lazy; unsupported terminal and missing IPC never write or launch", async () => {
  const f = await setup();
  try {
    const idle = createVscodeImageOpener({ tempRoot: join(f.root, "missing"), launch: f.launch });
    await idle.dispose();
    for (const env of [{ TERM_PROGRAM: "wezterm", VSCODE_IPC_HOOK_CLI: "socket" }, { TERM_PROGRAM: "vscode" }]) {
      const opener = createVscodeImageOpener({ ...f, tempRoot: f.root, env });
      await opener.open(png().toString("base64"));
      await opener.dispose();
    }
    assert.deepEqual(await readdir(f.root), []);
    assert.equal(f.calls.length, 0);
    assert.equal(f.messages.length, 2);
    assert.ok(f.messages.every(message => message.includes("VS Code integrated terminal")));
  } finally { await f.cleanup(); }
});

test("private hash-named snapshots use code --reuse-window and repeated clicks reuse the file", async () => {
  const f = await setup();
  const opener = createVscodeImageOpener({ ...f, tempRoot: f.root, env: environment() });
  try {
    const image = png().toString("base64");
    await opener.open(image);
    const call = f.calls[0]!;
    assert.equal(call.command, "code");
    assert.equal(call.args.length, 2);
    assert.equal(call.args[0], "--reuse-window");
    const file = call.args[1]!;
    assert.ok(isAbsolute(file));
    assert.match(file, /[a-f0-9]{64}\.png$/);
    assert.equal((await stat(dirname(file))).mode & 0o777, 0o700);
    assert.equal((await stat(file)).mode & 0o777, 0o600);
    assert.deepEqual(await readFile(file), png());
    assert.equal(call.options.shell, false);
    assert.equal(call.options.timeout, 10_000);
    assert.equal(call.options.maxBuffer, 4096);
    assert.equal(call.options.killSignal, "SIGKILL");
    assert.equal(call.options.env.VSCODE_IPC_HOOK_CLI, environment().VSCODE_IPC_HOOK_CLI);
    await opener.open(image);
    assert.equal(f.calls[1]!.args[1], file);
    assert.equal((await readdir(dirname(file))).length, 1);
    assert.deepEqual(f.messages, []);
    await opener.dispose();
    assert.deepEqual(await readdir(f.root), []);
    await opener.open(image);
    assert.equal(f.calls.length, 2);
  } finally { await opener.dispose(); await f.cleanup(); }
});

test("invalid/non-PNG, corrupt CRC/deflate, excessive dimensions and encoded input fail without IO", async () => {
  const f = await setup();
  const opener = createVscodeImageOpener({ ...f, tempRoot: f.root, env: environment() });
  try {
    const crcCorrupt = Buffer.from(png()); crcCorrupt[20] ^= 1;
    const valid = png();
    const malformedDeflate = Buffer.concat([valid.subarray(0, 33), chunk("IDAT", Buffer.from("not zlib")), chunk("IEND", Buffer.alloc(0))]);
    for (const input of [
      "file:///private/original.png", "/private/original.png", "data:image/png;base64,AAAA", "AAAA!===",
      Buffer.from("not a PNG").toString("base64"), crcCorrupt.toString("base64"), malformedDeflate.toString("base64"),
      png(0, 8192, 8192).toString("base64"), png(0, 0, 1).toString("base64"),
      png(0, 1, 1, Buffer.from([5, 0, 0, 0, 255])).toString("base64"),
      Buffer.concat([png(), Buffer.from("trailing")]).toString("base64"),
      "A".repeat(32 * 1024 * 1024 + 4),
    ]) await opener.open(input);
    assert.equal(f.calls.length, 0);
    assert.equal(f.messages.length, 12);
    assert.ok(f.messages.some(message => message.includes("32 megapixel")));
    assert.ok(f.messages.some(message => message.includes("32 MiB")));
    assert.deepEqual(await readdir(f.root), []);
    assert.ok(f.messages.every(message => !message.includes("private/original")));
  } finally { await opener.dispose(); await f.cleanup(); }
});

test("same-image in-flight clicks coalesce and disposal cancels queued launches before cleanup", async () => {
  const f = await setup();
  const started = deferred(), finish = deferred();
  const opener = createVscodeImageOpener({ ...f, tempRoot: f.root, env: environment(), launch: async (...args) => {
    await f.launch(...args); started.resolve(); await finish.promise;
  } });
  try {
    const first = opener.open(png(1).toString("base64"));
    const duplicate = opener.open(png(1).toString("base64"));
    assert.equal(first, duplicate);
    await started.promise;
    const second = opener.open(png(2).toString("base64"));
    const disposal = opener.dispose();
    assert.equal(disposal, opener.dispose());
    await opener.open(png(3).toString("base64"));
    assert.equal(f.calls.length, 1);
    assert.ok((await readdir(f.root)).length > 0, "directory must survive the in-flight launcher");
    finish.resolve();
    await Promise.all([first, duplicate, second, disposal]);
    assert.equal(f.calls.length, 1, "queued and post-disposal images must never launch");
    assert.deepEqual(await readdir(f.root), []);
  } finally { finish.resolve(); await opener.dispose(); await f.cleanup(); }
});

test("immediate dispose before queued file work never creates a directory or spawns", async () => {
  const f = await setup();
  const opener = createVscodeImageOpener({ ...f, tempRoot: f.root, env: environment() });
  try {
    const opening = opener.open(png().toString("base64"));
    await opener.dispose(); await opening;
    assert.equal(f.calls.length, 0);
    assert.deepEqual(await readdir(f.root), []);
  } finally { await opener.dispose(); await f.cleanup(); }
});

test("file-count limit keeps existing previews, rejects new ones, and allows cached paths", async () => {
  const f = await setup();
  const opener = createVscodeImageOpener({ ...f, tempRoot: f.root, env: environment() });
  try {
    await Promise.all(Array.from({ length: 33 }, (_, i) => opener.open(png(i).toString("base64"))));
    assert.equal(f.calls.length, 32);
    const directory = dirname(f.calls[0]!.args[1]!);
    assert.equal((await readdir(directory)).length, 32);
    assert.match(f.messages[0]!, /storage is full/);
    const original = f.calls[0]!.args[1];
    await opener.open(png(0).toString("base64"));
    assert.equal(f.calls[32]!.args[1], original);
    assert.equal((await readdir(directory)).length, 32);
  } finally { await opener.dispose(); await f.cleanup(); }
});

test("storage bytes are reserved across concurrent clicks; launcher failures never leak diagnostics", async () => {
  const f = await setup();
  const opener = createVscodeImageOpener({ ...f, tempRoot: f.root, env: environment(), maxStoredBytes: png(1).length, launch: async () => {
    throw Object.assign(new Error("secret stderr plus image payload"), { code: "ENOENT" });
  } });
  try {
    await Promise.all([opener.open(png(1).toString("base64")), opener.open(png(2).toString("base64"))]);
    assert.ok(f.messages.some(message => message.includes("storage is full")));
    assert.ok(f.messages.some(message => message.includes("code CLI was not found")));
    assert.ok(f.messages.every(message => !message.includes("secret")));
    const directory = join(f.root, (await readdir(f.root))[0]!);
    assert.equal((await readdir(directory)).length, 1, "failed launch retains snapshot for retry");
  } finally { await opener.dispose(); await f.cleanup(); }
});

test("nonzero and timeout failures are reported safely, retry reuses path, notify may throw", async () => {
  const f = await setup();
  let attempt = 0;
  const opener = createVscodeImageOpener({ ...f, tempRoot: f.root, env: environment(), launch: async (...args) => {
    await f.launch(...args);
    attempt++;
    if (attempt === 1) throw Object.assign(new Error("PRIVATE STDERR"), { code: 9 });
    if (attempt === 2) throw Object.assign(new Error("PRIVATE STDERR"), { killed: true, signal: "SIGKILL" });
  }, notify: message => { f.notify(message); throw new Error("disposed UI"); } });
  try {
    for (let i = 0; i < 3; i++) await opener.open(png().toString("base64"));
    assert.equal(f.calls.length, 3);
    assert.ok(f.calls.every(call => call.args[1] === f.calls[0]!.args[1]));
    assert.match(f.messages[0]!, /failed to open/);
    assert.match(f.messages[1]!, /timed out/);
    assert.ok(f.messages.every(message => !message.includes("PRIVATE")));
  } finally { await opener.dispose(); await f.cleanup(); }
});

test("save failures do not spawn or remove unrelated files and remain safe to dispose", async () => {
  const f = await setup();
  const sentinel = join(f.root, "unrelated");
  await writeFile(sentinel, "untouched");
  const opener = createVscodeImageOpener({ ...f, tempRoot: join(f.root, "missing-parent"), env: environment() });
  try {
    await opener.open(png().toString("base64"));
    await opener.dispose();
    assert.equal(f.calls.length, 0);
    assert.match(f.messages[0]!, /could not save/);
    assert.equal(await readFile(sentinel, "utf8"), "untouched");
  } finally { await opener.dispose(); await f.cleanup(); }
});

test("timeout injection can only lower the 10 second cap", async () => {
  const f = await setup();
  try {
    for (const [timeoutMs, expected] of [[undefined, 10_000], [50.9, 50], [0.5, 1], [0, 10_000], [-1, 10_000], [NaN, 10_000], [Infinity, 10_000], [60_000, 10_000]]) {
      const opener = createVscodeImageOpener({ ...f, tempRoot: f.root, env: environment(), timeoutMs });
      try {
        await opener.open(png().toString("base64"));
        assert.equal(f.calls.at(-1)!.options.timeout, expected);
      } finally { await opener.dispose(); }
    }
  } finally { await f.cleanup(); }
});

for (const mode of ["timeout", "orphan-timeout", "stdout-overflow", "stderr-overflow"]) {
  test(`real offline CLI process group: ${mode} leaves no running descendant`, { skip: process.platform === "win32", timeout: 10_000 }, async () => {
    const f = await setup();
    const executable = join(f.root, "code");
    const childScript = join(f.root, "child.cjs");
    await writeFile(childScript, `
setInterval(() => {}, 1000);
if (process.env.FAKE_MODE.endsWith('overflow')) {
  const stream = process.env.FAKE_MODE.startsWith('stdout') ? process.stdout : process.stderr;
  stream.write('PRIVATE_CLI_OUTPUT_' + 'x'.repeat(65536));
}
`);
    // Reproduce the real Remote SSH wrapper shape: a shell starts Node WITHOUT
    // exec. Both live in the new CLI process group; no VS Code is ever invoked.
    await writeFile(executable, `#!/bin/sh
printf '%s\\n' "$$" > "$FAKE_DIR/wrapper.pid"
"$FAKE_NODE" "$FAKE_CHILD_SCRIPT" &
child=$!
printf '%s\\n' "$child" > "$FAKE_DIR/child.pid"
if [ "$FAKE_MODE" = "orphan-timeout" ]; then exit 0; fi
wait "$child"
`, { mode: 0o700 });
    await chmod(executable, 0o700);
    const opener = createVscodeImageOpener({
      tempRoot: f.root, notify: f.notify, timeoutMs: mode.endsWith("timeout") ? 350 : 2000,
      env: { ...environment(), PATH: f.root, FAKE_NODE: process.execPath, FAKE_CHILD_SCRIPT: childScript, FAKE_DIR: f.root, FAKE_MODE: mode },
    });
    let watchdogFired = false;
    let emergencyCleanup: Promise<void> | undefined;
    // A regressed launcher must not leave the test hung or leak its fake child.
    const watchdog = setTimeout(() => {
      watchdogFired = true;
      emergencyCleanup = killKnownTestProcesses(f.root);
      void emergencyCleanup.catch(() => {});
    }, 5000);
    try {
      await opener.open(png().toString("base64"));
      assert.equal(watchdogFired, false, "launcher needed the test watchdog to terminate its process tree");
      const wrapper = await knownPid(f.root, "wrapper");
      const child = await knownPid(f.root, "child");
      assert.ok(wrapper !== undefined && child !== undefined, "fake wrapper did not create the expected child");
      for (let i = 0; i < 40 && (await isRunning(child)); i++) await delay(10);
      assert.equal(await isRunning(child), false, "CLI descendant survived group termination");
      assert.equal(await isRunning(wrapper), false, "CLI wrapper survived group termination");
      assert.equal(f.messages.length, 1);
      assert.match(f.messages[0]!, mode.endsWith("timeout") ? /timed out/ : /output limit/);
      assert.ok(f.messages.every(message => !message.includes("PRIVATE_CLI_OUTPUT")));
      await opener.dispose();
      assert.ok(!(await readdir(f.root)).some(name => name.startsWith("pi-math-images-")));
    } finally {
      clearTimeout(watchdog);
      // Also cleans leaked children on assertion failure, not just the happy path.
      try { await emergencyCleanup; await killKnownTestProcesses(f.root); }
      finally { await opener.dispose(); await f.cleanup(); }
    }
  });
}

test("real offline launcher handles successful, nonzero and missing CLI without lingering timers", { skip: process.platform === "win32" }, async () => {
  const f = await setup();
  try {
    for (const exitCode of [0, 7, undefined]) {
      const executable = join(f.root, "code");
      if (exitCode === undefined) await rm(executable);
      else { await writeFile(executable, `#!/bin/sh\nexit ${exitCode}\n`, { mode: 0o700 }); await chmod(executable, 0o700); }
      const before = f.messages.length;
      const opener = createVscodeImageOpener({ tempRoot: f.root, env: { ...environment(), PATH: f.root }, notify: f.notify });
      try {
        await opener.open(png().toString("base64"));
        if (exitCode === 0) assert.equal(f.messages.length, before);
        else assert.match(f.messages.at(-1)!, exitCode === undefined ? /was not found/ : /failed to open/);
      } finally { await opener.dispose(); }
    }
  } finally { await f.cleanup(); }
});

test("native Windows launcher reports an explicit platform boundary", { skip: process.platform !== "win32" }, async () => {
  const f = await setup();
  const opener = createVscodeImageOpener({ tempRoot: f.root, env: environment(), notify: f.notify });
  try {
    await opener.open(png().toString("base64"));
    assert.match(f.messages[0]!, /native Windows CLI launching is not supported/);
    assert.deepEqual(await readdir(f.root), [], "unsupported native launch must not write snapshots");
  } finally { await opener.dispose(); await f.cleanup(); }
});
