// The front page's sample email drawn from a birthday, and the birthday a
// link from yourversionnumber.com carries (lib/sample.ts).
import { describe, expect, it } from 'vitest';
import { anniversary, parseDay } from '../../../packages/domain/dates.ts';
import { computeVersion } from '../../../packages/domain/version.ts';
import { birthdayFromHash, carriesBirthday, emailDate, MADE_UP, ownMorning } from './sample.ts';
import type { Sample } from './types.ts';

// What /api/sample answers for a birthday on a day (server/app/account-routes.ts).
function answer(birthday: string, today: string): Sample {
  const v = computeVersion(birthday, today),
    born = parseDay(birthday),
    age = v.age + 1;
  return {
    version: v.toString(),
    age: String(v.age),
    next: {
      version: `${Math.floor(age / 10)}.${age % 10}.0`,
      date: anniversary(born.year + age, born.month, born.day),
      days: v.daysUntil
    }
  };
}

describe('birthdayFromHash', () => {
  const today = '2026-10-29';

  it('reads a real birthday, with or without the #', () => {
    expect(birthdayFromHash('#birthday=1981-06-14', today)).toBe('1981-06-14');
    expect(birthdayFromHash('birthday=1981-06-14', today)).toBe('1981-06-14');
    expect(birthdayFromHash('#birthday=1900-01-01', today)).toBe('1900-01-01');
  });

  it('ignores anything malformed', () => {
    for (const hash of [
      '',
      '#',
      '#birthday=',
      '#birthday=1981-6-14',
      '#birthday=19810614',
      '#birthday=81-06-14',
      '#birthday=1981-06-14&x=1',
      '#birthday=1981-06-14 ',
      '#birthday= 1981-06-14',
      '#birthday=1981-06-14T00:00',
      '#birthday=1981%2D06%2D14',
      '#Birthday=1981-06-14',
      '#x=1&birthday=1981-06-14',
      '#birthday=1981-13-01',
      '#birthday=1981-00-10',
      '#birthday=1981-04-31',
      '#birthday=1981-02-30',
      '#birthday=1899-12-31',
      '#birthday=١٩٨١-٠٦-١٤',
      '#sign-in'
    ])
      expect(birthdayFromHash(hash, today), hash).toBeNull();
  });

  it('ignores a birthday after today, and takes today itself', () => {
    expect(birthdayFromHash('#birthday=2026-10-30', today)).toBeNull();
    expect(birthdayFromHash('#birthday=2099-01-01', today)).toBeNull();
    expect(birthdayFromHash('#birthday=2026-10-29', today)).toBe('2026-10-29');
  });

  it('takes 29 February only in a leap year', () => {
    expect(birthdayFromHash('#birthday=2000-02-29', today)).toBe('2000-02-29');
    expect(birthdayFromHash('#birthday=1996-02-29', today)).toBe('1996-02-29');
    expect(birthdayFromHash('#birthday=2001-02-29', today)).toBeNull();
    expect(birthdayFromHash('#birthday=1900-02-29', today)).toBeNull();
  });

  it('knows a fragment that carries a birthday, so the page can clear it', () => {
    expect(carriesBirthday('#birthday=1981-06-14')).toBe(true);
    expect(carriesBirthday('#birthday=nonsense')).toBe(true);
    expect(carriesBirthday('#sign-in')).toBe(false);
    expect(carriesBirthday('')).toBe(false);
  });
});

describe('the sample email', () => {
  it('is made up before a birthday is typed: 5.2.113, always the same', () => {
    expect(MADE_UP).toEqual({
      version: '5.2.113',
      day: '2026-10-27',
      next: '5.3.0',
      ships: 'in 252 days',
      past: ['5.1.113', '5.0.113'],
      own: false
    });
    expect(emailDate(MADE_UP.day)).toBe('Tuesday, October 27');
  });

  it('is drawn with the visitor’s own number, day, patches and next release', () => {
    expect(ownMorning('1981-06-14', answer('1981-06-14', '2026-10-29'))).toEqual({
      version: '4.5.137',
      day: '2026-10-29',
      next: '4.6.0',
      ships: 'in 228 days',
      past: ['4.4.137', '4.3.137'],
      own: true
    });
    expect(ownMorning('1981-06-14', answer('1981-06-14', '2027-06-13'))).toMatchObject({
      version: '4.5.364',
      ships: 'tomorrow'
    });
  });

  it('counts a 29 February birthday from 1 March in other years', () => {
    expect(ownMorning('2000-02-29', answer('2000-02-29', '2026-10-29'))).toMatchObject({
      version: '2.6.242',
      next: '2.7.0',
      ships: 'in 123 days',
      past: ['2.5.242', '2.4.242']
    });
  });

  it('skips a release that never reached the patch, and has none before a first release', () => {
    // Patch 365 is only in a release with 29 February in it.
    expect(ownMorning('1990-03-01', answer('1990-03-01', '2024-02-29'))?.past).toEqual(['2.9.365', '2.5.365']);
    expect(ownMorning('2025-06-01', answer('2025-06-01', '2026-10-29'))?.past).toEqual(['0.0.150']);
    expect(ownMorning('2026-10-29', answer('2026-10-29', '2026-10-29'))).toMatchObject({ version: '0.0.0', past: [] });
  });

  it('is not drawn from an answer that doesn’t add up', () => {
    const a = answer('1981-06-14', '2026-10-29');
    expect(ownMorning('1981-06-14', { ...a, version: '4.5.138' })).toBeNull();
    expect(ownMorning('1981-06-14', { ...a, next: { ...a.next, version: '4.7.0' } })).toBeNull();
    expect(ownMorning('1981-06-14', { ...a, next: { ...a.next, date: 'soon' } })).toBeNull();
    expect(ownMorning('1981-06-14', { ...a, next: { ...a.next, days: 1.5 } })).toBeNull();
    expect(ownMorning('not-a-day', a)).toBeNull();
  });
});
