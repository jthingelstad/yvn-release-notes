// Which build of the web app this is, stamped in by vite.config.ts: the
// commit it was built from and when. Settings shows it at its foot, so an
// installed app that hasn't reloaded can be told from the live one.
import { localDay } from '../../../packages/domain/dates.ts';
import { computeVersion } from '../../../packages/domain/version.ts';

declare const __BUILD__: { commit: string; at: string };

export const BUILD = __BUILD__;

const REPO = 'https://github.com/jthingelstad/yvn-release-notes';

/** The commit's short form and its page, or null for a build with none. */
export function buildCommit(commit = BUILD.commit): { short: string; url: string } | null {
  return /^[0-9a-f]{40}$/.test(commit) ? { short: commit.slice(0, 7), url: `${REPO}/commit/${commit}` } : null;
}

// The version a build carries counts from Release Notes' own launch, by
// Your Version Number's arithmetic (Jamie, 2026-10-28: "Should release
// notes get its own start date based on when the app was launched? I think
// we should."). It launched on 7 October 2026, the repository's first
// commit and the evening the first emails went. A build is numbered by the
// day it was made, in Jamie's zone, so it reads the same to everyone.
export const LAUNCH = '2026-10-07';
const HOME_ZONE = 'America/Chicago';

export function buildVersion(at = BUILD.at): string {
  return computeVersion(LAUNCH, localDay(Date.parse(at) / 1000, HOME_ZONE)).toString();
}
