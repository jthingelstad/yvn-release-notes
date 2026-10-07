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

- **Email is the whole interface.** There is no web app and no sign-up form.
  Every note arrives by email, from the subscriber's own address, to a reply
  address only their inbox has seen.
- **A note belongs to the day of the email it answers.** Reply to Tuesday's
  email on Thursday and it is still Tuesday's note.
- **Raw mail is kept.** For now only the text of a reply is filed. Photos,
  audio and other attachments stay in the original message, to be handled later.
- **Nothing is tracked.** No open or click tracking, and the HTML email loads
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
