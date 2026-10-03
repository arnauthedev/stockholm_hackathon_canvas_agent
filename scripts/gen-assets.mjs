// Generates PWA icons (PNG) and short UI sounds (WAV) with no external tools.
import { writeFileSync, mkdirSync } from "node:fs";
import { deflateSync } from "node:zlib";
import path from "node:path";

const out = path.resolve(import.meta.dirname, "../app/public");

function crc32(buf) {
  let c, crc = 0xffffffff;
  for (let n = 0; n < buf.length; n++) {
    c = (crc ^ buf[n]) & 0xff;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    crc = (crc >>> 8) ^ c;
  }
  return (crc ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}
function png(size) {
  const raw = Buffer.alloc(size * (size * 4 + 1));
  const bg = [14, 15, 17], acc = [109, 155, 255], white = [255, 255, 255];
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0;
    for (let x = 0; x < size; x++) {
      const u = (x + 0.5) / size, v = (y + 0.5) / size;
      let col = bg;
      // canvas card
      const inCard = u > 0.2 && u < 0.8 && v > 0.18 && v < 0.62;
      if (inCard) col = acc;
      // chart line inside card
      const lineY = 0.42 - 0.1 * Math.sin((u - 0.26) * 13) * (u > 0.24 && u < 0.76 ? 1 : 0);
      if (u > 0.26 && u < 0.74 && Math.abs(v - lineY) < 0.018) col = white;
      // talk button
      const d = Math.hypot(u - 0.5, v - 0.78);
      if (d < 0.1) col = acc;
      if (d < 0.04) col = white;
      const o = y * (size * 4 + 1) + 1 + x * 4;
      raw[o] = col[0]; raw[o + 1] = col[1]; raw[o + 2] = col[2]; raw[o + 3] = 255;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", ihdr), chunk("IDAT", deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]);
}
function wav(notes, rate = 22050) {
  const samples = [];
  for (const [freq, dur] of notes) {
    const n = Math.floor(rate * dur);
    for (let i = 0; i < n; i++) {
      const t = i / rate, env = Math.min(1, i / (rate * 0.005)) * Math.exp(-t * 9);
      samples.push(Math.sin(2 * Math.PI * freq * t) * env * 0.5);
    }
  }
  const data = Buffer.alloc(samples.length * 2);
  samples.forEach((s, i) => data.writeInt16LE(Math.round(s * 32767), i * 2));
  const h = Buffer.alloc(44);
  h.write("RIFF", 0); h.writeUInt32LE(36 + data.length, 4); h.write("WAVE", 8); h.write("fmt ", 12);
  h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(1, 22); h.writeUInt32LE(rate, 24);
  h.writeUInt32LE(rate * 2, 28); h.writeUInt16LE(2, 32); h.writeUInt16LE(16, 34); h.write("data", 36); h.writeUInt32LE(data.length, 40);
  return Buffer.concat([h, data]);
}

mkdirSync(path.join(out, "icons"), { recursive: true });
mkdirSync(path.join(out, "sounds"), { recursive: true });
for (const s of [192, 512]) writeFileSync(path.join(out, "icons", `icon-${s}.png`), png(s));
writeFileSync(path.join(out, "sounds", "ding.wav"), wav([[880, 0.25]]));
writeFileSync(path.join(out, "sounds", "success.wav"), wav([[660, 0.09], [990, 0.25]]));
writeFileSync(path.join(out, "sounds", "error.wav"), wav([[330, 0.12], [220, 0.3]]));
writeFileSync(path.join(out, "sounds", "pop.wav"), wav([[1320, 0.08]]));
console.log("assets written to", out);
