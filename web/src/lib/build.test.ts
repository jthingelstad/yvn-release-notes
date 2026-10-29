// The build line's commit.
import { describe, expect, it } from 'vitest';
import { BUILD, buildCommit, buildVersion } from './build.ts';

describe('buildCommit', () => {
  it('shortens a commit and links its page', () => {
    expect(buildCommit('94b3235' + 'a'.repeat(33))).toEqual({
      short: '94b3235',
      url: 'https://github.com/jthingelstad/yvn-release-notes/commit/94b3235' + 'a'.repeat(33)
    });
  });
  it('is none for a build with no commit', () => {
    expect(buildCommit('')).toBeNull();
  });
  it('is stamped with when it was built', () => {
    expect(Number.isNaN(Date.parse(BUILD.at))).toBe(false);
  });
});

describe('buildVersion', () => {
  it('counts from Release Notes’ launch, by the build’s day in Chicago', () => {
    expect(buildVersion('2026-10-07T17:00:00Z')).toBe('0.0.0');
    // 9:41 PM in Chicago on Oct 28 is already Oct 29 in UTC.
    expect(buildVersion('2026-10-29T02:41:54Z')).toBe('0.0.21');
    expect(buildVersion('2027-10-07T17:00:00Z')).toBe('0.1.0');
  });
});
