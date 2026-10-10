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

reply email
  -> SES inbound       stores the raw message in S3, untouched
  -> inbound Lambda    checks the reply address, the sender and their domain's
                       DMARC (or DKIM), then files the text as that day's note
                       in DynamoDB

notes.yourversionnumber.com
  -> CloudFront        the web app (React, built by Vite) from S3, and /api
  -> web Lambda        sign-in, notes, files, search, settings, export
```

Smaller functions stop the emails after a hard bounce or complaint, build
the zip export, and, for those who turn them on, write out recordings and
describe photos.

- **Email and the web.** Every day starts with the email. Reply to it, or
  sign in to the web app to write, add photos, recordings and PDFs, look
  back, search, pause or change settings.
- **A note belongs to the day of the email it answers.** Reply to Tuesday's
  email on Thursday and it is still Tuesday's note. A reply address takes
  notes for 72 hours; after that, the web takes them, for any day.
- **Write as often as you like.** Every note for a day is kept, and
  together, in the order they were written, they are that day's release
  notes.
- **Streaks.** The email shows how many days in a row you have written,
  then a line of lifetime counts, then "On this day": your notes from the
  same day of every earlier release. A late note still counts for its day;
  a missed day starts the count over and the email shows your longest
  instead.
- **Photos and voice memos.** Send them by reply or add them on the web,
  and they are kept with that day's notes, shown only to you. Other email
  attachments stay in the original message, which is kept too.
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
- **The email tracks nothing.** No open or click tracking, and the HTML email loads
  nothing remote: no images, fonts or stylesheets.
- **Private, not secret.** Your notes are yours: no one else sees them and
  no model reads them unless you turn something on. The operator can read
  every note.
- **The arithmetic is the site's.** `version.py` is a port of the site's
  `computeVersion`, checked against thousands of cases generated from the
  site's own code.

## Develop

The backend is Python, standard library only, with nothing to install:

```sh
PYTHONPATH=src python3 -m unittest discover -s tests
```

The web app (`web/`) needs Node 24:

```sh
npm ci --ignore-scripts
npm run verify        # prettier, oxlint, tsc, vitest, the build
python3 scripts/dev_server.py   # the built app and the real API, against in-memory fakes
```

`infra/template.yaml` is the whole stack (CloudFormation) and `deploy.sh`
deploys it. `AGENTS.md` has the design rules and the operating notes, and
`docs/WEB-APP.md` the web app's design.

## License

MIT. See `LICENSE`.
