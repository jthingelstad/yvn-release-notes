---
title: Privacy
description: What Release Notes keeps, who can see it, and how to take it with you or delete it.
---

## What's kept

Your email address, your birthday, your city and the time your email comes. Every note, photo, voice memo and PDF you send or add, with the original emails they came in. Release Notes keeps them on Amazon Web Services, and shows your files only to you, through links that expire.

If you turn on [check-ins](/guide/check-ins/) in Changelog, the iPhone app, or another app sends them, the places you stop are kept too: each spot, when you got there and left, and any name you give it. That's a history of where you've been, kept until you delete it. Delete any one, or all of them, on the web or in the app.

## Who can see it

You can. So can Jamie Thingelstad, who runs Release Notes: as its operator, he can read what's stored. Nothing is sold or shared, and there are no ads.

## What goes to other services

Only what each job needs:

- **Email** is sent and received through Amazon. Mail to Release Notes must come encrypted, as every major email provider sends it, and mail that doesn't is bounced.
- **Your city** goes to Open-Meteo for the weather. Never your notes.
- **Places:** "Here" and "Add where I am" send the spot where you saved a note to Amazon Location, to name the neighbourhood and nearby places. A photo that carries its own location sends that spot the same way, and so does a check-in, once as it arrives and again if you ask for the businesses nearby. Only the spot, never the note.
- **Signing in** checks for bots with Cloudflare Turnstile.
- **Signing up** checks your address against the Weekly Thing's list, and looks again now and then.

## AI, only when you ask

Nothing you write goes to a model unless you turn it on. "Write out what I say" sends voice memos to Amazon Transcribe. "Describe my photos" sends photos to Claude, from Anthropic. A Supporting Member can ask for Claude's commentary in a book, and only that book's notes are read. Each is off until you choose it.

## Agents, only with your consent

You can connect an agent such as Claude or ChatGPT to your notes. It asks for each kind of access, you approve it, and you can disconnect it in Settings at any time. Its reads show in your Activity, one line for each connection each day. An agent that can read your notes can read your check-ins too, spots and all, and so can an app whose [token](/guide/tokens/) may read the activity log.

## The iPhone app

[Changelog](/guide/changelog/), the iPhone app, talks only to Release Notes, with the [API token](/guide/tokens/) it signs in with. The phone keeps that token, the note you're writing and any notes waiting to send. Notes you read in it stay in its memory and aren't saved on the phone, and a file you open sits in a temporary folder until you close it. It asks where you are for Here, "Add where I am" and Check in now. Check-ins are off until you turn them on in its Settings: then it asks to use your location Always, iOS tells it in the background when you stop, and each stop goes to Release Notes. Turn them off and that ends. What was sent stays until you delete it. It has no analytics, and its widgets and notifications never show a note's words. Revoking its token in Settings signs it out, even on a phone you no longer have.

## No tracking

The email counts no opens and no clicks. Pages are counted with Tinylytics, without cookies and without anything that names you. The sign-in cookie only keeps you signed in, for 14 days from your last visit.

## Taking it with you, and leaving

Export everything as a zip, files and all, from Settings at any time. Deleting your account deletes every note, its photos and recordings, the original emails and your settings at once; old copies of files are gone within 30 days. A copy of the database is kept each month as a backup, so a deleted note can remain in backups made before you deleted it.

Questions? Signed in, send Jamie [feedback](/feedback/).
