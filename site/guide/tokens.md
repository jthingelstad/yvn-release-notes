---
title: API tokens
description: Keys that let an app or a script add notes as you, what each one may do, and how to revoke one.
---

## What a token is

A token is a key you make for one app or script, so it can add notes as you: a line typed in a terminal, a shortcut on your phone, a script that writes a note when a job is done. It works only with [the API](/guide/api/). It can't sign in or change your settings, and unless you let it read all your notes, the only notes it can read are the ones it added, as they stand now: change one on the web and the token reads your change. If you allow it, a token can add photos, recordings and PDFs to the notes it adds, and keep your [Upcoming](/guide/upcoming/) dates, so an app can show them and remind you of them.

## Making one

Signed in, open Settings, then **API tokens** and **Make a token**:

- **Name** it for where it will live, like "Changelog on my iPhone" or "Terminal", up to 40 characters. No two of your tokens share a name.
- Tick what **it may** do: **Add notes, and change or delete the notes it adds**; **Add files to the notes it adds: photos, recordings and PDFs**, which comes only with adding notes; **Read all your notes, from anywhere, and change their words**, which comes only with adding notes too; **Read and change your Upcoming dates and their reminders**; and **Read the activity log, without any words from it**.
- Pick when it **expires**: in 90 days, in a year, or never.

Every token can read your version, today's date and your tags, whatever you tick. You can have up to 20 tokens at a time.

**Make token** shows the token once. Copy it then: Release Notes keeps only a hash of it, so it can never show it again. If you lose it, revoke it and make another.

Treat a token like a password. Anyone who has it can add notes as you, so keep it out of anything you share, like a screenshot or a public repository.

## Signing in an app

An app can sign you in instead, so there's nothing to copy. It opens Release Notes in your browser (sign in there if you need to), and the page says which app is asking. It's the same form: the token's name, what it may do, ticked from what the app asked for, and when it expires. Untick anything you'd rather it didn't do. **Allow** gives the app its token and **Cancel** makes nothing. The token is listed under **API tokens** with the others, and your activity log says which app you signed in.

## Notes from a token

A note a token adds is yours, in your own voice. On the web it shows "via" the token's name, like "via Terminal", and nothing marks it in the email. It counts toward your streak like a note you typed, and you can edit or delete it like any other.

A token can read, change or delete only the notes it added itself, never your others, unless you ticked **Read all your notes**. Then it can read every note, however you wrote it, and change or add to its words, as you can on the web. It still deletes, and adds files to, only the notes it added. With Upcoming ticked, it reads and changes every Upcoming date, whoever added it, as you can on the web. Your [activity log](/activity/) shows each thing a token did, by its name.

## Revoking one

Under **API tokens**, each token says what it may do, when it was made, when it was last used and when it expires. **Revoke** ends it at once: whatever uses it stops working at its next request. The notes it added stay yours.

An app can revoke its own token too, when you sign out of it. Deleting your account deletes every token.
