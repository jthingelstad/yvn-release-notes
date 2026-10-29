// Which build of the web app this is, stamped in by vite.config.ts: the
// commit it was built from and when. Settings shows it at its foot, so an
// installed app that hasn't reloaded can be told from the live one.
declare const __BUILD__: { commit: string; at: string };

export const BUILD = __BUILD__;

const REPO = 'https://github.com/jthingelstad/yvn-release-notes';

/** The commit's short form and its page, or null for a build with none. */
export function buildCommit(commit = BUILD.commit): { short: string; url: string } | null {
  return /^[0-9a-f]{40}$/.test(commit) ? { short: commit.slice(0, 7), url: `${REPO}/commit/${commit}` } : null;
}
