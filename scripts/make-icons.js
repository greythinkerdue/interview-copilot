// One-off script to generate simple placeholder PNG icons for the extension.
import zlib from "zlib";
import fs from "fs";
import path from "path";

function crc32(buf) {
  let c, table = crc32.table || (crc32.table = (() => {
    const t = [];
    for (let n = 0; n < 256; n++) {
      c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
      t[n] = c >>> 0;
    }
    return t;
  })());
  let crc = 0xffffffff;
  for (let i = 0; i < buf.length; i++) crc = table[(crc ^ buf[i]) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const typeData = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(typeData), 0);
  return Buffer.concat([len, typeData, crc]);
}

function makePng(size, drawPixel) {
  const width = size, height = size;
  const raw = Buffer.alloc((width * 4 + 1) * height);
  let offset = 0;
  for (let y = 0; y < height; y++) {
    raw[offset++] = 0; // filter type 0
    for (let x = 0; x < width; x++) {
      const [r, g, b, a] = drawPixel(x, y, width, height);
      raw[offset++] = r;
      raw[offset++] = g;
      raw[offset++] = b;
      raw[offset++] = a;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // color type RGBA
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;

  const idat = zlib.deflateSync(raw);
  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  return Buffer.concat([
    sig,
    chunk("IHDR", ihdr),
    chunk("IDAT", idat),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

function drawIcon(x, y, w, h) {
  const cx = w / 2, cy = h / 2;
  const dx = x - cx + 0.5, dy = y - cy + 0.5;
  const dist = Math.sqrt(dx * dx + dy * dy);
  const r = w / 2;

  // background: dark rounded square-ish via circle mask with margin, teal/indigo gradient feel
  const bgColor = [20, 23, 34, 255]; // near-black
  if (dist > r - 1) return [0, 0, 0, 0]; // transparent outside circle

  // Outer ring (accent teal)
  if (dist > r - r * 0.12) {
    return [56, 224, 196, 255]; // accent teal ring
  }

  // Inner "mic" glyph: vertical rounded bar + base arc, simple geometric approx
  const micWidth = w * 0.16;
  const micTop = h * 0.26;
  const micBottom = h * 0.58;
  if (Math.abs(dx) < micWidth / 2 && y > micTop && y < micBottom) {
    return [56, 224, 196, 255];
  }
  // base stand
  if (Math.abs(dx) < w * 0.22 && y >= micBottom && y < micBottom + h * 0.06) {
    const archDist = Math.sqrt(dx * dx + (y - micBottom) * (y - micBottom));
    if (archDist < w * 0.22) return [56, 224, 196, 255];
  }
  // stem
  if (Math.abs(dx) < w * 0.03 && y >= micBottom + h * 0.02 && y < micBottom + h * 0.14) {
    return [56, 224, 196, 255];
  }

  return bgColor;
}

const outDir = path.resolve(process.argv[2] || ".");
fs.mkdirSync(outDir, { recursive: true });
for (const size of [16, 48, 128]) {
  const png = makePng(size, (x, y, w, h) => drawIcon(x, y, w, h));
  fs.writeFileSync(path.join(outDir, `icon${size}.png`), png);
  console.log("wrote", path.join(outDir, `icon${size}.png`));
}
