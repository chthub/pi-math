import { crc32, deflateSync, inflateSync } from "node:zlib";

const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const MAX_FILTERED_BYTES = 20 * 1024 * 1024;

/** Losslessly compact Resvg's PNG output once, before caching/transmitting it. */
export function compactPng(png: Buffer): Buffer {
  // This helper receives locally rasterized RGBA8 PNGs, not user files.
  // Unknown formats and malformed inputs are preserved rather than re-encoded.
  if (png.length < 45 || !png.subarray(0, 8).equals(PNG_SIGNATURE)) return png;
  const chunks: { type: string; start: number; end: number }[] = [];
  const data: Buffer[] = [];
  let offset = 8;
  let expectedBytes = 0;
  let finished = false;
  while (offset + 12 <= png.length) {
    const length = png.readUInt32BE(offset);
    const end = offset + length + 12;
    if (end > png.length) return png;
    const type = png.toString("ascii", offset + 4, offset + 8);
    if (crc32(png.subarray(offset + 4, end - 4)) !== png.readUInt32BE(end - 4)) return png;
    if (chunks.length === 0) {
      if (type !== "IHDR" || length !== 13 || png[offset + 16] !== 8 || png[offset + 17] !== 6
        || png[offset + 18] !== 0 || png[offset + 19] !== 0 || png[offset + 20] !== 0) return png;
      const width = png.readUInt32BE(offset + 8);
      const height = png.readUInt32BE(offset + 12);
      expectedBytes = (width * 4 + 1) * height;
      if (!width || !height || expectedBytes > MAX_FILTERED_BYTES) return png;
    } else if (type !== "IDAT" && type !== "IEND") {
      return png; // Resvg's simple output has no extra metadata/animation chunks.
    }
    chunks.push({ type, start: offset, end });
    if (type === "IDAT") data.push(png.subarray(offset + 8, end - 4));
    offset = end;
    if (type === "IEND") { finished = length === 0; break; }
  }
  if (!finished || offset !== png.length || !data.length) return png;
  try {
    // Keep the original PNG scanline filters and every RGBA value unchanged.
    const filtered = inflateSync(Buffer.concat(data), { maxOutputLength: expectedBytes });
    if (filtered.length !== expectedBytes) return png;
    const compressed = deflateSync(filtered, { level: 6 });
    const idat = Buffer.alloc(compressed.length + 12);
    idat.writeUInt32BE(compressed.length, 0);
    idat.write("IDAT", 4, "ascii");
    compressed.copy(idat, 8);
    idat.writeUInt32BE(crc32(idat.subarray(4, -4)), idat.length - 4);
    let inserted = false;
    const output: Buffer[] = [PNG_SIGNATURE];
    for (const chunk of chunks) {
      if (chunk.type !== "IDAT") output.push(png.subarray(chunk.start, chunk.end));
      else if (!inserted) { output.push(idat); inserted = true; }
    }
    const result = Buffer.concat(output);
    return result.length < png.length ? result : png;
  } catch {
    return png;
  }
}
