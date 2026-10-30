---
title: Privacy
description: What Release Notes keeps, who can see it, and how to take it with you or delete it.
---

## What's kept

Your email address, your birthday, your city and the time your email comes. Every note, photo, voice memo and PDF you send or add, with the original emails they came in. Release Notes keeps them on Amazon Web Services, and shows your files only to you, through links that expire.

## Who can see it

You can. So can Jamie Thingelstad, who runs Release Notes: as its operator, he can read what's stored. Nothing is sold or shared, and there are no ads.

## What goes to other services

Only what each job needs:

- **Email** is sent and received through Amazon.
- **Your city** goes to Open-Meteo for the weather. Never your notes.
- **Places:** "Here" and "Add where I am" send the spot where you saved a note to Amazon Location, to name the neighbourhood and nearby places. A photo that carries its own location sends that spot the same way. Only the spot, never the note.
- **Signing in** checks for bots with Cloudflare Turnstile.
- **Signing up** checks your address against the Weekly Thing's list, and looks again now and then.

## AI, only when you ask

Nothing you write goes to a model unless you turn it on. "Write out what I say" sends voice memos to Amazon Transcribe. "Describe my photos" sends photos to Claude, from Anthropic. A Supporting Member can ask for Claude's commentary in a book, and only that book's notes are read. Each is off until you choose it.

## Agents, only with your consent

You can connect an agent such as Claude or ChatGPT to your notes. It asks for each kind of access, you approve it, and you can disconnect it in Settings at any time. Its reads show in your Activity, one line for each connection each day.

## The iPhone app

[Changelog](/guide/changelog/), the iPhone app, talks only to Release Notes, with the [API token](/guide/tokens/) it signs in with. The phone keeps that token, the note you're writing and any notes waiting to send. It asks where you are only for Here or "Add where I am", never in the background. It has no analytics, and its widgets and notifications never show a note's words. A moment you pick from Apple's Journaling Suggestions in Changelog is kept with its note, as the words are (a walk's distance and time, a song, how you felt, who you were with), and goes when the note does. Revoking its token in Settings signs it out, even on a phone you no longer have.

## No tracking

The email counts no opens and no clicks. Pages are counted with Tinylytics, without cookies and without anything that names you. The sign-in cookie only keeps you signed in, for 14 days from your last visit.

## Taking it with you, and leaving

Export everything as a zip, files and all, from Settings at any time. Deleting your account deletes every note, its photos and recordings, the original emails and your settings at once; old copies of files are gone within 30 days. A copy of the database is kept each month as a backup, so a deleted note can remain in backups made before you deleted it.

Questions? Signed in, send Jamie [feedback](/feedback/).
