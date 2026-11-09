/** How long a recording runs, for the transcription budget (Jamie,
 * 2026-11-08, product call 7 of the security audit: 120 minutes an account a
 * UTC day). Read from the file's own header where its format keeps one:
 * MP4/M4A's movie header, WAV's byte rate and data size, FLAC's sample count,
 * an MP3's Xing, Info or VBRI frame count or else its constant bitrate, an Ogg
 * file's last granule position, a WebM's Duration or else its last cluster.
 * A file whose length can't be read counts as its size at 32 kbit/s. Always
 * 15 s to 4 h: Transcribe bills at least 15 s and takes no more than 4 h.
 *
 * A header can lie. A file made to claim less than it holds gets more than
 * its share; the 30 recordings a day stay behind that. */

export const MIN_SECONDS = 15,
  MAX_SECONDS = 4 * 3600,
  FALLBACK_BITS_A_SECOND = 32_000,
  HEAD_BYTES = 256 * 1024,
  TAIL_BYTES = 256 * 1024,
  MOOV_BYTES = 4 * 1024 * 1024;

/** Bytes `start` up to, not including, `end`. */
export type Read = (start: number, end: number) => Promise<Buffer>;
type Parser = (head: Buffer, size: number, at: Read) => number | null | Promise<number | null>;

export async function audioSeconds(
  type: string,
  size: number,
  read: Read
): Promise<{ seconds: number; from: 'header' | 'size' }> {
  let found: number | null = null;
  const parse = PARSERS[type];
  if (parse && size > 0)
    try {
      const head = await read(0, Math.min(size, HEAD_BYTES));
      found = await parse(head, size, (start, end) =>
        end <= head.length ? Promise.resolve(head.subarray(start, end)) : read(start, end)
      );
    } catch {
      found = null;
    }
  // A day or more is no recording Transcribe takes: the header is wrong.
  const ok = found !== null && Number.isFinite(found) && found > 0 && found < 86400,
    raw = ok ? found! : (Math.max(0, size) * 8) / FALLBACK_BITS_A_SECOND;
  return {
    seconds: Math.ceil(Math.min(MAX_SECONDS, Math.max(MIN_SECONDS, raw))),
    from: ok ? 'header' : 'size'
  };
}

const text = (b: Buffer, start: number, end: number) => (end <= b.length ? b.toString('latin1', start, end) : '');

async function mp4(_head: Buffer, size: number, at: Read): Promise<number | null> {
  let off = 0;
  for (let step = 0; step < 64 && off + 8 <= size; step++) {
    const h = await at(off, Math.min(size, off + 16));
    if (h.length < 8) return null;
    let box = h.readUInt32BE(0),
      header = 8;
    if (box === 1) {
      if (h.length < 16) return null;
      box = Number(h.readBigUInt64BE(8));
      header = 16;
    } else if (box === 0) box = size - off;
    if (box < header) return null;
    if (text(h, 4, 8) === 'moov')
      return mvhd(await at(off + header, Math.min(off + box, off + header + MOOV_BYTES, size)));
    off += box;
  }
  return null;
}

function mvhd(moov: Buffer): number | null {
  for (let off = 0; off + 8 <= moov.length;) {
    const box = moov.readUInt32BE(off);
    if (box < 8) return null;
    if (text(moov, off + 4, off + 8) === 'mvhd') {
      const d = off + 8;
      if (moov[d] === 1) {
        if (d + 32 > moov.length) return null;
        const scale = moov.readUInt32BE(d + 20);
        return scale ? Number(moov.readBigUInt64BE(d + 24)) / scale : null;
      }
      if (d + 20 > moov.length) return null;
      const scale = moov.readUInt32BE(d + 12),
        duration = moov.readUInt32BE(d + 16);
      return scale && duration !== 0xffffffff ? duration / scale : null;
    }
    off += box;
  }
  return null;
}

function wav(head: Buffer, size: number): number | null {
  if (text(head, 0, 4) !== 'RIFF' || text(head, 8, 12) !== 'WAVE') return null;
  let rate = 0;
  for (let off = 12; off + 8 <= head.length;) {
    const id = text(head, off, off + 4),
      length = head.readUInt32LE(off + 4);
    if (id === 'fmt ' && off + 20 <= head.length) rate = head.readUInt32LE(off + 16);
    if (id === 'data') {
      if (!rate) return null;
      // A recorder still writing leaves the length 0 or all ones: the rest of the file.
      const data = length && length !== 0xffffffff && off + 8 + length <= size ? length : size - off - 8;
      return data / rate;
    }
    off += 8 + length + (length & 1);
  }
  return null;
}

function flac(head: Buffer): number | null {
  if (text(head, 0, 4) !== 'fLaC' || head.length < 26 || (head[4]! & 0x7f) !== 0) return null;
  const rate = (head[18]! << 12) | (head[19]! << 4) | (head[20]! >> 4),
    samples = (head[21]! & 0x0f) * 2 ** 32 + head.readUInt32BE(22);
  return rate && samples ? samples / rate : null;
}

const MP3_KBPS_1 = [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320],
  MP3_KBPS_2 = [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160],
  MP3_HZ = [44100, 48000, 32000];

function mp3(head: Buffer, size: number): number | null {
  let off = 0;
  if (text(head, 0, 3) === 'ID3' && head.length >= 10)
    off =
      10 +
      (((head[6]! & 0x7f) << 21) | ((head[7]! & 0x7f) << 14) | ((head[8]! & 0x7f) << 7) | (head[9]! & 0x7f)) +
      (head[5]! & 0x10 ? 10 : 0);
  for (const end = Math.min(head.length - 4, off + 64 * 1024); off < end; off++) {
    if (head[off] !== 0xff || (head[off + 1]! & 0xe0) !== 0xe0) continue;
    const version = (head[off + 1]! >> 3) & 3,
      layer = (head[off + 1]! >> 1) & 3,
      index = head[off + 2]! >> 4,
      hzIndex = (head[off + 2]! >> 2) & 3;
    // MPEG audio layer III only, with a real bitrate and sample rate.
    if (version === 1 || layer !== 1 || index === 0 || index === 15 || hzIndex === 3) continue;
    const one = version === 3,
      kbps = (one ? MP3_KBPS_1 : MP3_KBPS_2)[index]!,
      hz = MP3_HZ[hzIndex]! / (one ? 1 : version === 2 ? 2 : 4),
      perFrame = one ? 1152 : 576,
      mono = head[off + 3]! >> 6 === 3,
      xing = off + 4 + (one ? (mono ? 17 : 32) : mono ? 9 : 17),
      vbri = off + 36;
    if (
      ['Xing', 'Info'].includes(text(head, xing, xing + 4)) &&
      xing + 12 <= head.length &&
      head.readUInt32BE(xing + 4) & 1
    )
      return (head.readUInt32BE(xing + 8) * perFrame) / hz;
    if (text(head, vbri, vbri + 4) === 'VBRI' && vbri + 18 <= head.length)
      return (head.readUInt32BE(vbri + 14) * perFrame) / hz;
    return ((size - off) * 8) / (kbps * 1000);
  }
  return null;
}

async function ogg(head: Buffer, size: number, at: Read): Promise<number | null> {
  if (text(head, 0, 4) !== 'OggS') return null;
  const opus = head.indexOf('OpusHead', 0, 'latin1'),
    vorbis = head.indexOf('\x01vorbis', 0, 'latin1');
  // Opus counts at 48 kHz whatever was recorded; Vorbis says its rate.
  const hz =
    opus >= 0 && opus < 512
      ? 48000
      : vorbis >= 0 && vorbis < 512 && vorbis + 16 <= head.length
        ? head.readUInt32LE(vorbis + 12)
        : 0;
  if (!hz) return null;
  const tail = await at(Math.max(0, size - TAIL_BYTES), size);
  for (let i = tail.length, tries = 0; i > 0 && tries < 64; tries++) {
    i = tail.lastIndexOf('OggS', i - 1, 'latin1');
    if (i < 0) break;
    if (i + 14 > tail.length || tail[i + 4] !== 0) continue;
    const granule = tail.readBigInt64LE(i + 6);
    if (granule > 0n) return Number(granule) / hz;
  }
  return null;
}

/** An EBML size or ID length: its first byte's leading zeros. */
function vint(b: Buffer, off: number, keepMarker = false): { value: number; length: number } | null {
  const first = b[off];
  if (!first) return null;
  const length = Math.clz32(first) - 23;
  if (length > 8 || off + length > b.length) return null;
  let value = keepMarker ? first : first & (0xff >> length);
  for (let i = 1; i < length; i++) value = value * 256 + b[off + i]!;
  return { value, length };
}
const uint = (b: Buffer, off: number, n: number) => {
  let v = 0;
  for (let i = 0; i < n; i++) v = v * 256 + b[off + i]!;
  return v;
};
const EBML_INFO = Buffer.from([0x15, 0x49, 0xa9, 0x66]),
  EBML_CLUSTER = Buffer.from([0x1f, 0x43, 0xb6, 0x75]);

async function webm(head: Buffer, size: number, at: Read): Promise<number | null> {
  if (head.length < 4 || head.readUInt32BE(0) !== 0x1a45dfa3) return null;
  let scale = 1_000_000,
    duration = 0;
  const info = head.indexOf(EBML_INFO),
    infoSize = info >= 0 ? vint(head, info + 4) : null;
  if (infoSize) {
    let off = info + 4 + infoSize.length;
    const end = Math.min(head.length, off + infoSize.value);
    while (off < end) {
      const id = vint(head, off, true),
        sz = id && vint(head, off + id.length);
      if (!id || !sz) break;
      const data = off + id.length + sz.length;
      if (data + sz.value > head.length) break;
      if (id.value === 0x2ad7b1 && sz.value >= 1 && sz.value <= 8) scale = uint(head, data, sz.value) || scale;
      if (id.value === 0x4489)
        duration = sz.value === 4 ? head.readFloatBE(data) : sz.value === 8 ? head.readDoubleBE(data) : 0;
      off = data + sz.value;
    }
  }
  if (duration > 0) return (duration * scale) / 1e9;
  // A browser's recorder writes no Duration: take the last cluster's start,
  // plus the most a block inside it can add (32.767 s).
  const tail = await at(Math.max(0, size - TAIL_BYTES), size);
  for (let i = tail.length, tries = 0; i > 0 && tries < 64; tries++) {
    i = tail.lastIndexOf(EBML_CLUSTER, i - 1);
    if (i < 0) break;
    const sz = vint(tail, i + 4),
      t = sz ? i + 4 + sz.length : -1,
      tl = t >= 0 && tail[t] === 0xe7 ? vint(tail, t + 1) : null;
    if (!tl || tl.value < 1 || tl.value > 8 || t + 1 + tl.length + tl.value > tail.length) continue;
    return (uint(tail, t + 1 + tl.length, tl.value) * scale) / 1e9 + 32.767;
  }
  return null;
}

/** By the stored type, as `transcribe.FORMATS` takes them. */
const PARSERS: Record<string, Parser> = {
  'audio/mp4': mp4,
  'audio/mpeg': mp3,
  'audio/wav': wav,
  'audio/ogg': ogg,
  'audio/webm': webm,
  'audio/flac': flac
};
