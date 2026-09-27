import { deflateSync } from 'node:zlib';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

const size = 128;
const digits = {
  '7': ['11111', '00001', '00010', '00100', '01000', '01000', '01000'],
  '0': ['01110', '10001', '10011', '10101', '11001', '10001', '01110'],
  '6': ['00110', '01000', '10000', '11110', '10001', '10001', '01110']
};
const raw = Buffer.alloc(size * (size * 4 + 1));
for (let y = 0; y < size; y++) {
  const row = y * (size * 4 + 1);
  for (let x = 0; x < size; x++) {
    const offset = row + 1 + x * 4;
    const border = x < 3 || x >= size - 3 || y < 3 || y >= size - 3;
    raw[offset] = border ? 126 : 30;
    raw[offset + 1] = border ? 196 : 43;
    raw[offset + 2] = border ? 255 : 59;
    raw[offset + 3] = 255;
  }
}
const scale = 5;
const startX = 17;
const startY = 46;
for (const [index, digit] of [...'706'].entries()) {
  digits[digit].forEach((row, ry) => {
    [...row].forEach((pixel, rx) => {
      if (pixel === '0') return;
      for (let dy = 0; dy < scale; dy++) for (let dx = 0; dx < scale; dx++) {
        const x = startX + index * 37 + rx * scale + dx;
        const y = startY + ry * scale + dy;
        const offset = y * (size * 4 + 1) + 1 + x * 4;
        raw[offset] = 238;
        raw[offset + 1] = 248;
        raw[offset + 2] = 255;
      }
    });
  });
}
const crcTable = Array.from({ length: 256 }, (_, index) => {
  let value = index;
  for (let bit = 0; bit < 8; bit++) value = (value & 1) ? (0xedb88320 ^ (value >>> 1)) : (value >>> 1);
  return value >>> 0;
});
function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) crc = crcTable[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}
function chunk(name, data) {
  const type = Buffer.from(name);
  const header = Buffer.alloc(4);
  header.writeUInt32BE(data.length);
  const checksum = Buffer.alloc(4);
  checksum.writeUInt32BE(crc32(Buffer.concat([type, data])));
  return Buffer.concat([header, type, data, checksum]);
}
const header = Buffer.alloc(13);
header.writeUInt32BE(size, 0);
header.writeUInt32BE(size, 4);
header[8] = 8;
header[9] = 6;
const png = Buffer.concat([
  Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
  chunk('IHDR', header),
  chunk('IDAT', deflateSync(raw)),
  chunk('IEND', Buffer.alloc(0))
]);
const icoHeader = Buffer.alloc(22);
icoHeader.writeUInt16LE(1, 2);
icoHeader.writeUInt16LE(1, 4);
icoHeader[6] = size;
icoHeader[7] = size;
icoHeader.writeUInt16LE(1, 10);
icoHeader.writeUInt16LE(32, 12);
icoHeader.writeUInt32LE(png.length, 14);
icoHeader.writeUInt32LE(22, 18);
const directory = path.resolve(import.meta.dirname, '../src-tauri/icons');
await mkdir(directory, { recursive: true });
await writeFile(path.join(directory, 'icon.png'), png);
await writeFile(path.join(directory, 'icon.ico'), Buffer.concat([icoHeader, png]));
