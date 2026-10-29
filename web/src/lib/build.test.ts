// The build line's commit.
import { describe, expect, it } from 'vitest';
import { BUILD, buildCommit } from './build.ts';

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
