import assert from 'node:assert/strict';
import test from 'node:test';
import {
  NONPROFITS,
  givenDuring,
  givingId,
  givingLine,
  givingYearOf,
  givingYears,
  sawMember
} from '../../packages/domain/giving.ts';

test('a profile’s giving reads oldest first and leaves out anything malformed', () => {
  assert.deepEqual(
    givingYears({
      2026: { first: '2026-10-25', last: '2026-11-03' },
      2025: { first: '2025-02-01', last: '2025-12-30' },
      nope: { first: '2026-01-01', last: '2026-01-02' },
      2024: { first: '2024-05-01' },
      2023: { first: '2023-06-01', last: '2023-05-01' }
    }),
    [
      { year: 2025, first: '2025-02-01', last: '2025-12-30' },
      { year: 2026, first: '2026-10-25', last: '2026-11-03' }
    ]
  );
  for (const none of [undefined, null, 'x', 7]) assert.deepEqual(givingYears(none), []);
});

test('a member seen adds the year, then only widens it; a later year joins the earlier', () => {
  const first = sawMember(undefined, '2026-10-25');
  assert.deepEqual(first, { 2026: { first: '2026-10-25', last: '2026-10-25' } });
  const later = sawMember(first, '2026-11-03');
  assert.deepEqual(later, { 2026: { first: '2026-10-25', last: '2026-11-03' } });
  assert.equal(sawMember(later, '2026-10-30'), null, 'inside what is known: nothing to write');
  assert.deepEqual(sawMember(later, '2027-01-06'), {
    2026: { first: '2026-10-25', last: '2026-11-03' },
    2027: { first: '2027-01-06', last: '2027-01-06' }
  });
});

test('a release names the nonprofits whose days seen overlap it, and only known ones', () => {
  const giving = {
    2025: { first: '2025-03-01', last: '2025-12-28' },
    2026: { first: '2026-01-06', last: '2026-10-25' },
    2099: { first: '2099-01-02', last: '2099-01-02' }
  };
  assert.deepEqual(givenDuring(giving, '2025-06-14', '2026-06-13'), ['EFF', 'Signal']);
  assert.deepEqual(givenDuring(giving, '2026-06-14', '2027-06-13'), ['Signal']);
  assert.deepEqual(givenDuring(giving, '2024-06-14', '2025-02-28'), [], 'the year was seen only after');
  assert.deepEqual(givenDuring(giving, '2098-06-14', '2099-06-13'), [], 'no nonprofit named for 2099 yet');
  assert.ok(NONPROFITS[2026], 'this year’s nonprofit is listed');
});

test('the birthday thank-you names one or two', () => {
  assert.equal(
    givingLine('5.4', ['Signal']),
    'During 5.4 you supported Signal as a Weekly Thing Supporting Member. Thank you.'
  );
  assert.equal(
    givingLine('5.4', ['EFF', 'Signal']),
    'During 5.4 you supported EFF and Signal as a Weekly Thing Supporting Member. Thank you.'
  );
  assert.equal(givingLine('5.4', []), null);
});

test('a giving badge’s id carries its year', () => {
  assert.equal(givingId(2026), 'giving-2026');
  assert.equal(givingYearOf('giving-2026'), 2026);
  assert.equal(givingYearOf('round'), null);
});
