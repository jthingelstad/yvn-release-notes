/** Feedback's checks and the inline-image stripper, on made-up images only. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  answerFields,
  feedbackFields,
  feedbackItem,
  feedbackView,
  FEEDBACK_TEXT_MAX
} from '../../packages/domain/feedback.ts';
import { InlineImageError, inlineImages, stripMetadata } from '../../packages/backend/inline-images.ts';
import { imageSize } from '../../packages/backend/media.ts';
import { b64, jpeg, png, SECRET, webp } from '../../packages/testing/images.ts';

test('a filing is a kind, trimmed words within the cap and an optional item it follows', () => {
  assert.deepEqual(feedbackFields({ kind: 'bug', text: '  The map is blank\r\n' }), {
    kind: 'bug',
    text: 'The map is blank',
    follows: null
  });
  assert.equal(feedbackFields({ kind: 'severe', text: 'x' }), 'kind');
  assert.equal(feedbackFields({ kind: 'idea', text: '   ' }), 'text');
  assert.equal(feedbackFields({ kind: 'idea', text: 5 }), 'text');
  assert.equal(feedbackFields({ kind: 'idea', text: '💡'.repeat(FEEDBACK_TEXT_MAX + 1) }), 'too-long');
  assert.equal(typeof feedbackFields({ kind: 'idea', text: '💡'.repeat(FEEDBACK_TEXT_MAX) }), 'object');
  assert.equal(feedbackFields({ kind: 'idea', text: 'x', follows: 'not-an-id' }), 'follows');
  assert.deepEqual(feedbackFields({ kind: 'question', text: 'x', follows: '0123456789abcdef' }), {
    kind: 'question',
    text: 'x',
    follows: '0123456789abcdef'
  });
  assert.deepEqual(answerFields({ status: 'needs_info', text: ' Which page? ' }), {
    status: 'needs_info',
    text: 'Which page?'
  });
  assert.equal(answerFields({ status: 'open', text: 'x' }), 'status');
  assert.equal(answerFields({ status: 'done', text: '' }), 'text');
});

test('a view carries no table or file keys', () => {
  const view = feedbackView(
    feedbackItem({
      pk: 'USER#u',
      sk: 'FEEDBACK#0123456789abcdef',
      id: '0123456789abcdef',
      kind: 'bug',
      text: 'Broken',
      status: 'open',
      via: 'web',
      filed_at: '2026-10-28T12:00:00.000Z',
      screenshots: [{ n: 1, type: 'image/png', size: 10, width: 2, height: 3, key: 'media/u/feedback/x-1.png' }]
    })
  );
  assert.ok(!JSON.stringify(view).includes('media/'));
  assert.ok(!Object.hasOwn(view, 'pk') && !Object.hasOwn(view, 'sk'));
  assert.deepEqual(view.screenshots, [{ n: 1, type: 'image/png', size: 10, width: 2, height: 3 }]);
});

test('metadata is stripped from PNG, JPEG and WebP and the picture kept', () => {
  for (const [type, make] of [
    ['image/png', png],
    ['image/jpeg', jpeg],
    ['image/webp', webp]
  ] as const) {
    const raw = make(640, 480);
    assert.ok(raw.toString('latin1').includes(SECRET), type);
    const clean = stripMetadata(type, raw);
    assert.ok(!clean.toString('latin1').includes(SECRET), type);
    assert.deepEqual(imageSize(clean), [640, 480], type);
    const [decoded] = inlineImages([{ type, data: b64(raw) }], { max: 3 });
    assert.deepEqual(decoded, { type, data: clean, width: 640, height: 480 });
  }
  // The WebP's flags no longer claim EXIF or XMP, and its RIFF size is right.
  const clean = stripMetadata('image/webp', webp());
  assert.equal(clean[20]! & 0x0c, 0);
  assert.equal(clean.readUInt32LE(4), clean.length - 8);
});

test('a JPEG loses metadata after its first scan and anything after its end marker', () => {
  const seg = (marker: number, data: Buffer) => {
    const head = Buffer.from([0xff, marker, 0, 0]);
    head.writeUInt16BE(data.length + 2, 2);
    return Buffer.concat([head, data]);
  };
  const base = jpeg(),
    body = base.subarray(0, base.length - 2),
    // Scan data with a stuffed 0xFF00 and a restart marker, which are data.
    scan2 = Buffer.concat([
      seg(0xda, Buffer.from([1, 1, 0, 0, 0x3f, 0])),
      Buffer.from([0xff, 0, 0x22, 0xff, 0xd3, 0x44])
    ]),
    raw = Buffer.concat([
      body,
      seg(0xe1, Buffer.from('Exif\0\0' + SECRET, 'latin1')),
      seg(0xfe, Buffer.from(SECRET, 'latin1')),
      seg(0xc4, Buffer.from([0, 1, 2])),
      scan2,
      Buffer.from([0xff, 0xd9]),
      Buffer.from('trailing ' + SECRET, 'latin1')
    ]);
  const clean = stripMetadata('image/jpeg', raw);
  assert.ok(!clean.toString('latin1').includes(SECRET));
  assert.ok(!clean.toString('latin1').includes('trailing'));
  assert.deepEqual(clean.subarray(-2), Buffer.from([0xff, 0xd9]));
  // Both scans and the table between them are kept whole.
  assert.ok(clean.includes(scan2));
  assert.ok(clean.includes(seg(0xc4, Buffer.from([0, 1, 2]))));
  assert.deepEqual(imageSize(clean), [640, 480]);
  // A scan that never reaches a marker is refused.
  assert.throws(() => stripMetadata('image/jpeg', body));
});

test('a WebP keeps nothing after its RIFF size', () => {
  const raw = Buffer.concat([webp(), Buffer.from('JUNK\x10\0\0\0' + SECRET.slice(0, 16), 'latin1')]);
  const clean = stripMetadata('image/webp', raw);
  assert.ok(!clean.toString('latin1').includes(SECRET.slice(0, 16)));
  assert.equal(clean.readUInt32LE(4), clean.length - 8);
});

test('inline images are refused by count, type, bytes and size before anything is kept', () => {
  const refused = (value: unknown, options = { max: 3 }) => {
    try {
      inlineImages(value, options);
    } catch (error) {
      assert.ok(error instanceof InlineImageError);
      return [error.reason, error.index];
    }
    assert.fail('accepted');
  };
  assert.deepEqual(inlineImages(undefined, { max: 3 }), []);
  assert.deepEqual(refused([1, 2, 3, 4]), ['image-count', -1]);
  assert.deepEqual(refused('x'), ['image-count', -1]);
  assert.deepEqual(refused([{ type: 'image/gif', data: b64(png()) }]), ['image-type', 0]);
  assert.deepEqual(
    refused([
      { type: 'image/png', data: b64(png()) },
      { type: 'image/png', data: b64(jpeg()) }
    ]),
    ['image-data', 1]
  );
  assert.deepEqual(refused([{ type: 'image/png', data: 'data:image/png;base64,AAAA' }]), ['image-data', 0]);
  assert.deepEqual(refused([{ type: 'image/png', data: b64(png()) }], { max: 3, bytes: 50 } as never), [
    'image-too-big',
    0
  ]);
  // A file cut short is not walked past its end.
  assert.deepEqual(refused([{ type: 'image/png', data: b64(png().subarray(0, 40)) }]), ['image-data', 0]);
});
