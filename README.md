# Release Notes

A daily email from [Your Version Number](https://yourversionnumber.com).

Your version number is your age written the way software is versioned:
decades, years into the decade, and days since your last birthday. Every
morning Release Notes sends you today's number ("You're 5.4.278 today"). Reply
with anything about the day, or write it at
[notes.yourversionnumber.com](https://notes.yourversionnumber.com), and it is
kept as the release notes for that version.

## How it works

```
EventBridge, every quarter hour
  -> sender Lambda     anyone whose local send time has come gets one email,
                       with a reply address unique to them and that day

reply email, or one to the subscriber's standing address
  -> SES inbound       stores the raw message in S3, untouched
  -> inbound Lambda    checks the reply address, the sender and their domain's
                       DMARC (or DKIM), then files the text as that day's note
                       in DynamoDB

notes.yourversionnumber.com
  -> CloudFront        the web app (React, built by Vite) from S3, and /api
  -> Lambda Web Function (Hono/Node 24) sign-in, notes, files, search, settings, export
  -> separate Web Function for /mcp, with owner-approved agent access
```

Smaller functions stop the emails after a hard bounce or complaint, build
the zip export, and, for those who turn them on, write out recordings and
describe photos.

- **Email and the web.** Every day starts with the email. Reply to it, or
  write any day to your own address (in settings and at the foot of every
  email: no reply needed, filed for the day it arrives), or sign in to the
  web app to write, add photos, recordings and PDFs, look back, search,
  pause or change settings.
- **A note belongs to the day of the email it answers.** Reply to Tuesday's
  email on Thursday and it is still Tuesday's note. A reply address takes
  notes for 72 hours; after that, the web takes them, for any day.
- **Write as often as you like.** Every note for a day is kept, and
  together, in the order they were written, they are that day's release
  notes.
- **Streaks.** The email shows how many days in a row you have written,
  then a line of lifetime counts, then yesterday's notes, so you can see
  everything you sent came through, then "On this day": your notes from the
  same day of every earlier release. A late note still counts for its day;
  a missed day starts the count over and the email shows your longest
  instead.
- **Photos and voice memos.** Send them by reply or add them on the web,
  and they are kept with that day's notes, shown only to you. Small copies
  of your photos come back inside your morning email, never as a link.
  Other email attachments stay in the original message, which is kept too.
- **Tags and search.** Hashtags in a note are its tags; every tag has its
  page, and search finds words across every note.
- **Opt-in extras.** Recordings written out (Amazon Transcribe) and photos
  described for search (Claude), each off until you turn it on.
- **Bring your journal.** A Day One export can be imported.
- **Yours to keep.** Export everything any time: a zip with every note, as
  Markdown and JSON, and every photo and recording.
- **Links show by name.** When a note has a web address, its page is visited
  once, as the note is saved, to keep its title; a phrase you linked in your
  mail app keeps your words. Nothing is fetched when a note is shown.
- **Weather.** Each day's high, low and conditions are kept with your notes,
  for the city you were in, and the morning email carries one line of
  today's forecast. [Weather from Open-Meteo](https://open-meteo.com/),
  CC BY 4.0, which is told the city, never your notes.
- **Places.** A note can say where it was: chosen on the web, or from the
  place a photo was taken. A photo's spot is named once, at the city, by
  Amazon Location, which is told the coordinates and nothing else; a past
  day's weather then follows you there.
- **The email tracks nothing.** No open or click tracking, and the HTML email loads
  nothing remote: no images, fonts or stylesheets.
- **Private, not secret.** Your notes are yours: no one else sees them and
  no model reads them unless you turn something on. The operator can read
  every note. An agent connection shares only the scopes you explicitly
  approve, under that service's own privacy and retention policy.
- **The arithmetic is the site's.** `packages/domain/version.ts` is a port of the site's
  `computeVersion`, checked against thousands of cases generated from the
  site's own code.

## Develop

The application, Event Function workers and operator tools use TypeScript on
Node 24. The React frontend and Hono HTTP servers share the domain and storage
contracts. Install without package scripts, then verify both sides:

```sh
npm ci --ignore-scripts
npm run verify        # format, lint, types, unit tests, web and server builds
node --import tsx tools/dev-server.ts --fake-places --fake-links
```

The local harness serves the built app and real HTTP/MCP routes against
fictional in-memory stores, objects and mail. It never uses AWS. Browser
regressions run with `npm run e2e`; the server tests alone with `npm run test:server`.
CloudFront signs requests to the private Web Function origins using OAC;
email link/code sign-in still proves ownership before any subscriber write.

`infra/template.yaml` is the whole stack (CloudFormation). Merging to main
deploys it: the `deploy` workflow runs the release (`scripts/release.sh`) from
GitHub Actions, and reverting a merge rolls it back. `deploy.sh` runs the same
release from the Mac. `AGENTS.md` has the design rules, `docs/OPERATING.md` the
operating notes, and `docs/WEB-APP.md` the web app's design.

## License

MIT. See `LICENSE`.
