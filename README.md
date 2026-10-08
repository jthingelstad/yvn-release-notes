# Release Notes

A daily email from [Your Version Number](https://yourversionnumber.com).

Your version number is your age written the way software is versioned:
decades, years into the decade, and days since your last birthday. Every
morning Release Notes sends you today's number ("You're 5.4.278 today"). Reply
with anything about the day, and your reply is kept as the release notes for
that version.

## How it works

```
EventBridge, every quarter hour
  -> sender Lambda     anyone whose local send time has come gets one email,
                       with a reply address unique to them and that day

reply email
  -> SES inbound       stores the raw message in S3, untouched
  -> inbound Lambda    checks the reply address, the sender and their domain's
                       DMARC, then files the text as that day's note in DynamoDB
```

- **Email first, with a web app on the way.** Every day starts with the
  email, and replies are filed from the subscriber's own address only. A web
  app at notes.yourversionnumber.com (sign-up, past days, pause, export) is
  being built; `docs/WEB-APP.md` is the plan.
- **A note belongs to the day of the email it answers.** Reply to Tuesday's
  email on Thursday and it is still Tuesday's note.
- **Reply as often as you like.** Every reply to a day's email is kept, and
  together, in the order they arrived, they are that day's release notes.
- **Streaks.** The email shows how many days in a row you have replied.
  Replying late to an earlier email still counts for that day; a missed day
  starts the count over and the email shows your longest instead.
- **Photos and voice memos.** Reply with them and they are kept with that
  day's notes, for your eyes only. Other attachments stay in the original
  message, which is kept too.
- **Yours to keep.** Export everything any time: a zip with every note, as
  Markdown and JSON, and every photo and recording.
- **Links show by name.** When a note has a web address, its page is visited
  once, as the note is saved, to keep its title; a phrase you linked in your
  mail app keeps your words. Nothing is fetched when a note is shown.
- **The email tracks nothing.** No open or click tracking, and the HTML email loads
  nothing remote: no images, fonts or stylesheets.
- **The arithmetic is the site's.** `version.py` is a port of the site's
  `computeVersion`, checked against thousands of cases generated from the
  site's own code.

## Develop

Python standard library only, with nothing to install.

```sh
PYTHONPATH=src python3 -m unittest discover -s tests
```

`infra/template.yaml` is the whole stack (CloudFormation) and `deploy.sh`
deploys it. `AGENTS.md` has the design rules and the operating notes.

## License

MIT. See `LICENSE`.
