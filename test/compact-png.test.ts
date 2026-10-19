import assert from "node:assert/strict";
import test from "node:test";
import { crc32, deflateSync, inflateSync } from "node:zlib";
import { Resvg } from "@resvg/resvg-js";
import { compactPng } from "../src/compact-png.js";

function chunk(type: string, bytes: Buffer): Buffer {
  const result = Buffer.alloc(bytes.length + 12);
  result.writeUInt32BE(bytes.length);
  result.write(type, 4, "ascii");
  bytes.copy(result, 8);
  result.writeUInt32BE(crc32(result.subarray(4, -4)), result.length - 4);
  return result;
}
function chunks(png: Buffer) {
  const result: { type: string; bytes: Buffer }[] = [];
  for (let offset = 8; offset < png.length;) {
    const length = png.readUInt32BE(offset);
    result.push({ type: png.toString("ascii", offset + 4, offset + 8), bytes: png.subarray(offset + 8, offset + 8 + length) });
    assert.equal(crc32(png.subarray(offset + 4, offset + 8 + length)), png.readUInt32BE(offset + 8 + length));
    offset += length + 12;
  }
  return result;
}
function filtered(png: Buffer) {
  return inflateSync(Buffer.concat(chunks(png).filter(c => c.type === "IDAT").map(c => c.bytes)));
}
const fixture = new Resvg(`<svg xmlns="http://www.w3.org/2000/svg" width="180" height="36">
  <rect width="180" height="18" fill="#4488aa" fill-opacity="0.4"/>
  <circle cx="40" cy="20" r="13" fill="red"/>
</svg>`).render().asPng();

test("PNG compaction preserves all filtered pixels/alpha and valid chunk CRCs", () => {
  const compact = compactPng(fixture);
  assert.ok(compact.length <= fixture.length);
  assert.deepEqual(filtered(compact), filtered(fixture));
  const render = (png: Buffer) => new Resvg(`<svg xmlns="http://www.w3.org/2000/svg" width="180" height="36"><image width="180" height="36" href="data:image/png;base64,${png.toString("base64")}"/></svg>`).render().pixels;
  assert.deepEqual(render(compact), render(fixture));
  assert.ok(compactPng(compact).length <= compact.length);
});

test("lossless compaction joins IDAT chunks and shrinks poorly compressed rows", () => {
  const parts = chunks(fixture);
  const uncompressed = deflateSync(filtered(fixture), { level: 0 });
  const large = Buffer.concat([
    fixture.subarray(0, 8), chunk("IHDR", parts[0].bytes),
    chunk("IDAT", uncompressed.subarray(0, 37)), chunk("IDAT", uncompressed.subarray(37)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
  const compact = compactPng(large);
  assert.ok(compact.length < large.length / 2);
  assert.deepEqual(filtered(compact), filtered(large));
  assert.equal(chunks(compact).filter(c => c.type === "IDAT").length, 1);
});

test("malformed/unsupported PNGs are passed through with bounded inflation", () => {
  const badCrc = Buffer.from(fixture); badCrc[29] ^= 1;
  const parts = chunks(fixture);
  const hugeHeader = Buffer.from(parts[0].bytes); hugeHeader.writeUInt32BE(0xffffffff, 0);
  const unsupported = Buffer.from(parts[0].bytes); unsupported[9] = 2; // RGB is outside this helper's contract.
  const smallHeader = Buffer.from(parts[0].bytes); smallHeader.writeUInt32BE(1, 0); smallHeader.writeUInt32BE(1, 4);
  for (const header of [hugeHeader, unsupported, smallHeader]) {
    const changed = Buffer.concat([fixture.subarray(0, 8), chunk("IHDR", header), ...parts.slice(1).map(c => chunk(c.type, c.bytes))]);
    assert.equal(compactPng(changed), changed);
  }
  for (const malformed of [Buffer.from("not PNG"), fixture.subarray(0, 40), badCrc, Buffer.concat([fixture, Buffer.from("extra")])]) {
    assert.equal(compactPng(malformed), malformed);
  }
});
