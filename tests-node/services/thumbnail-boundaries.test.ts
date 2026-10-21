/** Real Sharp codec properties, not mocked image behavior. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import sharp from 'sharp';
import { crc32 } from 'node:zlib';
import { make, TARGET, LONGEST, MAX_PIXELS } from '../../packages/backend/thumbs.ts';
test('thumbnails flatten transparency onto paper, bound high-entropy bytes and refuse oversized decoded images', async () => {
  const transparent = await sharp({ create: { width: 800, height: 400, channels: 4, background: '#00000000' } })
    .png()
    .toBuffer();
  const paper = await make(transparent);
  assert.ok(paper);
  assert.deepEqual([paper.width, paper.height], [640, 320]);
  const pixel = await sharp(paper.body).extract({ left: 10, top: 10, width: 1, height: 1 }).raw().toBuffer();
  // JPEG is lossy: preserve the paper colour within rounding, not codec bytes.
  [255, 251, 242].forEach((channel, i) => assert.ok(Math.abs(pixel[i]! - channel) <= 2));
  const bytes = Buffer.alloc(640 * 480 * 3);
  let state = 7;
  for (let i = 0; i < bytes.length; i++) {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    bytes[i] = state & 255;
  }
  const noisy = await make(
    await sharp(bytes, { raw: { width: 640, height: 480, channels: 3 } })
      .png()
      .toBuffer()
  );
  assert.ok(noisy);
  assert.ok(noisy.body.length <= TARGET);
  assert.ok(Math.max(noisy.width, noisy.height) <= LONGEST);
  // Valid PNG framing with oversized IHDR is refused before allocating pixels.
  const side = Math.ceil(Math.sqrt(MAX_PIXELS)) + 1,
    oversized = Buffer.from(transparent);
  oversized.writeUInt32BE(side, 16);
  oversized.writeUInt32BE(side, 20);
  oversized.writeUInt32BE(crc32(oversized.subarray(12, 29)), 29);
  await assert.rejects(sharp(oversized, { limitInputPixels: MAX_PIXELS }).metadata(), /pixel limit/i);
  assert.equal(await make(oversized), null);
});
