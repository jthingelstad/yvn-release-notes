import { test } from 'node:test';
import assert from 'node:assert/strict';
import { audioSeconds, HEAD_BYTES, MAX_SECONDS, MIN_SECONDS } from '../../packages/backend/audio-length.ts';

const reader = (file: Buffer) => {
  const reads: [number, number][] = [];
  return {
    reads,
    read: async (from: number, to: number) => {
      reads.push([from, to]);
      return file.subarray(from, to);
    }
  };
};
const u32 = (n: number) => {
  const b = Buffer.alloc(4);
  b.writeUInt32BE(n);
  return b;
};
const box = (kind: string, body: Buffer) => Buffer.concat([u32(8 + body.length), Buffer.from(kind, 'latin1'), body]);
const mvhd0 = (scale: number, duration: number) =>
  box('mvhd', Buffer.concat([Buffer.alloc(4), Buffer.alloc(8), u32(scale), u32(duration), Buffer.alloc(80)]));
const mvhd1 = (scale: number, duration: number) => {
  const d = Buffer.alloc(8);
  d.writeBigUInt64BE(BigInt(duration));
  return box('mvhd', Buffer.concat([Buffer.from([1, 0, 0, 0]), Buffer.alloc(16), u32(scale), d, Buffer.alloc(80)]));
};
const length = async (type: string, file: Buffer, size = file.length) => audioSeconds(type, size, reader(file).read);

test('an M4A says its length in its movie header, at the front or after the audio', async () => {
  const front = Buffer.concat([
    box('ftyp', Buffer.from('M4A isom')),
    box('moov', mvhd0(1000, 600_000)),
    box('mdat', Buffer.alloc(64))
  ]);
  assert.deepEqual(await length('audio/mp4', front), { seconds: 600, from: 'header' });
  // An iPhone recording keeps the movie header after the audio, past the first read.
  const back = Buffer.concat([
      box('ftyp', Buffer.from('M4A isom')),
      box('mdat', Buffer.alloc(HEAD_BYTES + 4096)),
      box('moov', Buffer.concat([mvhd1(44100, 44100 * 90), box('trak', Buffer.alloc(32))]))
    ]),
    r = reader(back);
  assert.deepEqual(await audioSeconds('audio/mp4', back.length, r.read), { seconds: 90, from: 'header' });
  assert.ok(r.reads.some(([from]) => from > HEAD_BYTES));
  assert.ok(r.reads.every(([from, to]) => to - from <= HEAD_BYTES));
});

test('WAV, FLAC, MP3, Ogg and WebM headers each say how long they run', async () => {
  const wav = Buffer.alloc(44);
  wav.write('RIFF', 0, 'latin1');
  wav.write('WAVE', 8, 'latin1');
  wav.write('fmt ', 12, 'latin1');
  wav.writeUInt32LE(16, 16);
  wav.writeUInt32LE(16_000, 28);
  wav.write('data', 36, 'latin1');
  wav.writeUInt32LE(16_000 * 30, 40);
  assert.deepEqual(await length('audio/wav', wav, 44 + 16_000 * 30), { seconds: 30, from: 'header' });

  const flac = Buffer.alloc(42);
  flac.write('fLaC', 0, 'latin1');
  flac[4] = 0x80;
  flac[7] = 34;
  const total = 44100 * 45;
  flac[18] = 44100 >> 12;
  flac[19] = (44100 >> 4) & 0xff;
  flac[20] = (44100 & 0x0f) << 4;
  flac.writeUInt32BE(total, 22);
  assert.deepEqual(await length('audio/flac', flac), { seconds: 45, from: 'header' });

  // MPEG-1 layer III, 128 kbit/s, 44.1 kHz, stereo, with a Xing frame count.
  const xing = Buffer.alloc(200);
  Buffer.from([0xff, 0xfb, 0x90, 0x00]).copy(xing, 0);
  xing.write('Xing', 36, 'latin1');
  xing.writeUInt32BE(1, 40);
  xing.writeUInt32BE(1000, 44);
  assert.deepEqual(await length('audio/mpeg', xing), { seconds: Math.ceil((1000 * 1152) / 44100), from: 'header' });
  // Without one, its constant bitrate, after the ID3 tag.
  const id3 = Buffer.alloc(10 + 100);
  id3.write('ID3', 0, 'latin1');
  id3[9] = 100;
  const cbr = Buffer.concat([id3, Buffer.from([0xff, 0xfb, 0x90, 0x00]), Buffer.alloc(64)]);
  assert.deepEqual(await length('audio/mpeg', cbr, 110 + 960_000), { seconds: 60, from: 'header' });

  const page = (granule: number, body: Buffer) => {
    const h = Buffer.alloc(27);
    h.write('OggS', 0, 'latin1');
    h.writeBigInt64LE(BigInt(granule), 6);
    return Buffer.concat([h, body]);
  };
  const ogg = Buffer.concat([
    page(0, Buffer.from('OpusHead\x01\x01\x38\x01', 'latin1')),
    Buffer.alloc(HEAD_BYTES * 2),
    page(48000 * 70, Buffer.alloc(32)),
    page(48000 * 75, Buffer.alloc(32))
  ]);
  assert.deepEqual(await length('audio/ogg', ogg), { seconds: 75, from: 'header' });

  const ebml = Buffer.from([0x1a, 0x45, 0xdf, 0xa3, 0x80]),
    duration = Buffer.alloc(8);
  duration.writeDoubleBE(120_000);
  const info = (children: Buffer) =>
      Buffer.concat([Buffer.from([0x15, 0x49, 0xa9, 0x66, 0x80 | children.length]), children]),
    scale = Buffer.from([0x2a, 0xd7, 0xb1, 0x83, 0x0f, 0x42, 0x40]);
  const stated = Buffer.concat([ebml, info(Buffer.concat([scale, Buffer.from([0x44, 0x89, 0x88]), duration]))]);
  assert.deepEqual(await length('audio/webm', stated), { seconds: 120, from: 'header' });
  // A browser's recording has no Duration: its last cluster, plus a block's most.
  const cluster = (ms: number) =>
    Buffer.concat([
      Buffer.from([0x1f, 0x43, 0xb6, 0x75, 0x01, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff]),
      Buffer.from([0xe7, 0x83, ms >> 16, (ms >> 8) & 0xff, ms & 0xff]),
      Buffer.alloc(40)
    ]);
  const recorded = Buffer.concat([ebml, info(scale), cluster(0), Buffer.alloc(1000), cluster(30_000), cluster(60_000)]);
  assert.deepEqual(await length('audio/webm', recorded), { seconds: Math.ceil(60 + 32.767), from: 'header' });
});

test('an unreadable header counts its size at 32 kbit/s, and every length is 15 s to 4 h', async () => {
  assert.deepEqual(await length('audio/mp4', Buffer.alloc(400_000)), { seconds: 100, from: 'size' });
  assert.deepEqual(await length('audio/x-unknown', Buffer.alloc(400_000)), { seconds: 100, from: 'size' });
  const failing = await audioSeconds('audio/mp4', 400_000, async () => {
    throw new Error('gone');
  });
  assert.deepEqual(failing, { seconds: 100, from: 'size' });
  const short = Buffer.concat([box('ftyp', Buffer.from('M4A ')), box('moov', mvhd0(1000, 2000))]);
  assert.deepEqual(await length('audio/mp4', short), { seconds: MIN_SECONDS, from: 'header' });
  const long = Buffer.concat([box('ftyp', Buffer.from('M4A ')), box('moov', mvhd0(1, 10 * 3600))]);
  assert.deepEqual(await length('audio/mp4', long), { seconds: MAX_SECONDS, from: 'header' });
  // A day or more is a wrong header, not a recording: the size decides.
  const wrong = Buffer.concat([box('ftyp', Buffer.from('M4A ')), box('moov', mvhd0(1, 2 * 86400))]);
  assert.deepEqual(await length('audio/mp4', wrong, 40_000), { seconds: MIN_SECONDS, from: 'size' });
});
