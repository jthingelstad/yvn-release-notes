/** Tiny made-up images for tests, each carrying the metadata a camera or an
 * editor writes beside the picture (a fictional GPS spot and comment), so a
 * test can show it is gone. No real photo. */
import { crc32 } from 'node:zlib';

export const SECRET = 'GPS 44.9778 -93.2650 fictional';

function chunk(name: string, data: Buffer): Buffer {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(data.length, 0);
  head.write(name, 4, 'latin1');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([Buffer.from(name, 'latin1'), data])) >>> 0, 0);
  return Buffer.concat([head, data, crc]);
}
/** A PNG, `width` by `height`, with eXIf and tEXt chunks naming SECRET. */
export function png(width = 640, height = 480): Buffer {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  return Buffer.concat([
    Buffer.from('\x89PNG\r\n\x1a\n', 'latin1'),
    chunk('IHDR', ihdr),
    chunk('tEXt', Buffer.from('Comment\0' + SECRET, 'latin1')),
    chunk('eXIf', Buffer.from('MM\0*' + SECRET, 'latin1')),
    chunk('IDAT', Buffer.from([0x78, 0x9c, 0x63, 0, 0, 0, 1, 0, 1])),
    chunk('IEND', Buffer.alloc(0))
  ]);
}
function segment(marker: number, data: Buffer): Buffer {
  const head = Buffer.from([0xff, marker, 0, 0]);
  head.writeUInt16BE(data.length + 2, 2);
  return Buffer.concat([head, data]);
}
/** A JPEG's frame, with APP1 Exif and a comment naming SECRET. */
export function jpeg(width = 640, height = 480): Buffer {
  const sof = Buffer.from([8, 0, 0, 0, 0, 1, 1, 0x11, 0]);
  sof.writeUInt16BE(height, 1);
  sof.writeUInt16BE(width, 3);
  return Buffer.concat([
    Buffer.from([0xff, 0xd8]),
    segment(0xe0, Buffer.from('JFIF\0\x01\x01\0\0\x01\0\x01\0\0', 'latin1')),
    segment(0xe1, Buffer.from('Exif\0\0' + SECRET, 'latin1')),
    segment(0xfe, Buffer.from(SECRET, 'latin1')),
    segment(0xc0, sof),
    segment(0xda, Buffer.from([1, 1, 0, 0, 0x3f, 0])),
    Buffer.from([0x12, 0x34, 0x56]),
    Buffer.from([0xff, 0xd9])
  ]);
}
/** An extended WebP with EXIF and XMP chunks naming SECRET. */
export function webp(width = 640, height = 480): Buffer {
  const piece = (name: string, data: Buffer) => {
    const head = Buffer.alloc(8);
    head.write(name, 0, 'latin1');
    head.writeUInt32LE(data.length, 4);
    return Buffer.concat([head, data, data.length % 2 ? Buffer.alloc(1) : Buffer.alloc(0)]);
  };
  const vp8x = Buffer.alloc(10);
  vp8x[0] = 0x0c;
  vp8x.writeUIntLE(width - 1, 4, 3);
  vp8x.writeUIntLE(height - 1, 7, 3);
  const body = Buffer.concat([
    piece('VP8X', vp8x),
    piece('VP8L', Buffer.from([0x2f, 0, 0, 0, 0])),
    piece('EXIF', Buffer.from(SECRET, 'latin1')),
    piece('XMP ', Buffer.from(SECRET, 'latin1'))
  ]);
  const head = Buffer.alloc(12);
  head.write('RIFF', 0, 'latin1');
  head.writeUInt32LE(body.length + 4, 4);
  head.write('WEBP', 8, 'latin1');
  return Buffer.concat([head, body]);
}
export const b64 = (data: Buffer) => data.toString('base64');
