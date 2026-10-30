---
title: Building a client
description: How an app that adds notes should behave, so every client acts alike, offline and on.
---

## Who this is for

Anyone building an app on [the API](/guide/api/), for a phone, a desktop or anything else. Write your client to these and it behaves like every other, and a note is never lost or sent twice.

## Ask for a token, never a password

Your app signs the person in, or takes a token they make in Settings, named for the app and the device, like "Changelog on my iPhone" (see [API tokens](/guide/tokens/)). Either way it ends up with one token. Keep it in the platform's secure storage, like the Keychain on an iPhone or the Keystore on Android, and never in a log line, a crash report or anything you send elsewhere. When the person signs out of your app, send `DELETE /v1/token` so the token ends there too.

## Signing in

Signing in is OAuth's authorization code with PKCE, and what it gives your app is a token like any other.

- Register at `POST /oauth/register` as a public client with your own callback: an `https` address, or a scheme of your own written as a domain you control in reverse, like `com.example.jotter:/oauth`.
- Open `/oauth/authorize` in the platform's sign-in browser (`ASWebAuthenticationSession` on an iPhone, a Custom Tab on Android) with `response_type=code`, your `client_id` and `redirect_uri`, `resource=https://notes.yourversionnumber.com/v1`, the scopes you need from `notes:write`, `media:write`, `upcoming` and `activity`, a `state`, and a `code_challenge` with `code_challenge_method=S256`.
- The person names the token, can untick what you asked for, and picks when it expires. Your callback gets a `code` and your `state`. Within five minutes, post the code to `/oauth/token` with `grant_type=authorization_code`, the same `client_id`, `redirect_uri` and `resource`, and your `code_verifier`.
- The answer is the token, `rn_...`, with the `scope` the person allowed, which may be less than you asked for, and `expires_in` unless it never expires. There is no refresh token: keep it as you would a pasted one, and when it expires, sign in again.
- A code works once. Sent again, the token it made ends.
- To sign out, send `DELETE /v1/token`, or post the token and your `client_id` to `/oauth/revoke`.

## Save first, then send

Keep every note on the device the moment it's written, then send it. With no connection, hold it in a queue and send it later, oldest first.

- Make each note's `Idempotency-Key` once, when it's saved, and send that same key on every try. A note that did arrive is answered again, never added twice. A key holds for 7 days, so send what's queued within that. It holds for the account, not the token: after the person signs in again, send the queue through the new token with the same keys.
- Keep the `account` from `GET /v1/me` with each queued note, and send it only through a token whose `account` matches. Someone who signs in to a different account never sends it another account's notes.
- Send `written_at`, the moment the words were typed. A note typed just before midnight and sent just after files to the day it was typed.
- After a timeout, `busy` or `unavailable`, try again later with the same key, waiting longer each time. Take a note out of the queue only when it was filed, or on an answer that trying again can't fix, like `text_required` or `too_large`, and show the person why.

## Files and places

- Keep a photo, recording or PDF on the device with its note, and ask for its form only as you send it: a form is good within 5 minutes. Post the file, then send the note with its `uploads` and the note's own `Idempotency-Key`, as always.
- An upload no note takes is gone after a day. If the note is still queued by then, ask for a new form and post the file again.
- Send photos as JPEG, PNG or WebP. On an iPhone, convert a HEIC before you send it, or it gets no thumbnail and never shows in the email.
- Ask before reading where the device is, and read it only when the person asks to add where they are. Offer the `nearby` businesses from Here as choices, and never pick one for them: the nearest is as often a bus stop.
- Something the person picks on the device, a workout, a song, who they were with, goes in as words they can edit before it's sent, with its photos as `uploads` and where it was as `place`. Release Notes keeps a note's words, files and place, and nothing more about where they came from.

## Which rows are yours

A token's activity rows carry its `token_id`, the `id` under `token` in `GET /v1/me`. Pick out what your app did by that id, never by the token's name: a token made later can have the same name. Rows from before version 1.4.0 of the API have no `token_id`.

## Take the version from the server

Never work out a version on the device. `GET /v1/me` gives today's version and the versions for the next 14 days, each on its date in the account's own time zone, so midnight, a birthday and a trip abroad all come out right. Every answer also says today's version in `Release-Notes-Version`, and each note's answer says the version it was filed in: show that one.

## Reminders on the phone

Don't work out a reminder on the device either. `GET /v1/upcoming/reminders` says which reminders each morning brings, in the email's own words, and when that morning's email is due, as `send_at`, so a reminder on the phone comes with the email and says the same. Schedule them as the device's own notifications, from what it last read:

- Read two weeks ahead, the default, and read again each time the app opens and whenever the platform lets it refresh in the background. An iPhone keeps only so many waiting notifications for an app, and two weeks fits.
- Replace everything you scheduled with each read. A date that was changed, removed or had its email reminders turned off is no longer in the answer.
- Ask before turning reminders on, and keep them off until the person does.

## Errors and limits

- Act on the `code`, never the wording, and show the `message` when the person has to do something.
- On `rate_limited`, wait the seconds `Retry-After` says. The queue holds the rest.
- On `token_missing`, `token_unknown`, `token_revoked` or `token_expired`, stop sending, keep the queue, and sign in again or ask for a new token.
- On `scope_required`, say what the token can't do: the `message` says it in words the person can read.
- On `revision_mismatch`, the note or date was changed somewhere else, on the web say. Read it again before changing it.

## Name your client

Send a `User-Agent` that starts with your app's name and version, like `Jotter/1.2 (Android 16)`. Release Notes keeps the name with each note your app adds.

## Not in a browser

The API sends no CORS headers and refuses a request that carries another site's `Origin`, so a web page can't call it from a visitor's browser, where anyone could read the token in the page. Call it from an app, a script or your own server.

## What can change

The API's `/v1/openapi.json` describes every request and answer, for tools that make clients from it, and its `x-changes` lists what each version added. The API only ever gains things: a new request, a new optional field, a new error code. Anything that would break a client would come at a new address, `/v2`, never under `/v1`.

## Try it without an account

Release Notes' code is public, at [github.com/jthingelstad/yvn-release-notes](https://github.com/jthingelstad/yvn-release-notes). Its development server, `tools/dev-server.ts`, runs the same API against a made-up account and prints a token for it when it starts. An Android emulator reaches it at `10.0.2.2`. There, a form's `url` is a path on the development server itself, so add the server's address in front of it.
