---
title: API tokens
description: Keys that let an app or a script add notes as you, what each one may do, and how to revoke one.
---

## What a token is

A token is a key you make for one app or script, so it can add notes as you: a line typed in a terminal, a shortcut on your phone, a script that writes a note when a job is done. It works only with [the API](/guide/api/). It can't sign in, change your settings or read your notes.

For now only Jamie sees API tokens in Settings, to try them first. They open to every account after that.

## Making one

Signed in, open Settings, then **API tokens** and **Make a token**:

- **Name** it for where it will live, like "Changelog on my iPhone" or "Terminal", up to 40 characters. No two of your tokens share a name.
- Tick what **it may** do: **Add notes, and change or delete the notes it adds**, and **Read the activity log, without any words from it**.
- Pick when it **expires**: in 90 days, in a year, or never.

Every token can read your version, today's date and your tags, whatever you tick. You can have up to 20 tokens at a time.

**Make token** shows the token once. Copy it then: Release Notes keeps only a hash of it, so it can never show it again. If you lose it, revoke it and make another.

Treat a token like a password. Anyone who has it can add notes as you, so keep it out of anything you share, like a screenshot or a public repository.

## Notes from a token

A note a token adds is yours, in your own voice. On the web it shows "via" the token's name, like "via Terminal", and nothing marks it in the email. It counts toward your streak like a note you typed, and you can edit or delete it like any other.

A token can change or delete only the notes it added itself, never your others. Your [activity log](/activity/) shows each thing a token did, by its name.

## Revoking one

Under **API tokens**, each token says what it may do, when it was made, when it was last used and when it expires. **Revoke** ends it at once: whatever uses it stops working at its next request. The notes it added stay yours.

An app can revoke its own token too, when you sign out of it. Deleting your account deletes every token.
