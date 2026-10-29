---
title: Building a client
description: How an app that adds notes should behave, so every client acts alike, offline and on.
---

## Who this is for

Anyone building an app on [the API](/guide/api/), for a phone, a desktop or anything else. Write your client to these and it behaves like every other, and a note is never lost or sent twice.

## Ask for a token, never a password

Your app asks for a token the person makes in Settings, named for the app and the device, like "Changelog on my iPhone" (see [API tokens](/guide/tokens/)). Keep it in the platform's secure storage, like the Keychain on an iPhone or the Keystore on Android, and never in a log line, a crash report or anything you send elsewhere. When the person signs out of your app, send `DELETE /v1/token` so the token ends there too.

## Save first, then send

Keep every note on the device the moment it's written, then send it. With no connection, hold it in a queue and send it later, oldest first.

- Make each note's `Idempotency-Key` once, when it's saved, and send that same key on every try. A note that did arrive is answered again, never added twice. A key holds for 7 days, so send what's queued within that.
- Send `written_at`, the moment the words were typed. A note typed just before midnight and sent just after files to the day it was typed.
- After a timeout, `busy` or `unavailable`, try again later with the same key, waiting longer each time. Take a note out of the queue only when it was filed, or on an answer that trying again can't fix, like `text_required` or `too_large`, and show the person why.

## Take the version from the server

Never work out a version on the device. `GET /v1/me` gives today's version and the versions for the next 14 days, each on its date in the account's own time zone, so midnight, a birthday and a trip abroad all come out right. Every answer also says today's version in `Release-Notes-Version`, and each note's answer says the version it was filed in: show that one.

## Errors and limits

- Act on the `code`, never the wording, and show the `message` when the person has to do something.
- On `rate_limited`, wait the seconds `Retry-After` says. The queue holds the rest.
- On `token_missing`, `token_unknown`, `token_revoked` or `token_expired`, stop sending, keep the queue, and ask for a new token.
- On `scope_required`, say what the token can't do: the `message` says it in words the person can read.
- On `revision_mismatch`, the note was changed somewhere else, on the web say. Read it again before changing it.

## Name your client

Send a `User-Agent` that starts with your app's name and version, like `Jotter/1.2 (Android 16)`. Release Notes keeps the name with each note your app adds.

## Not in a browser

The API sends no CORS headers and refuses a request that carries another site's `Origin`, so a web page can't call it from a visitor's browser, where anyone could read the token in the page. Call it from an app, a script or your own server.

## What can change

The API's `/v1/openapi.json` describes every request and answer, for tools that make clients from it, and its `x-changes` lists what each version added. The API only ever gains things: a new request, a new optional field, a new error code. Anything that would break a client would come at a new address, `/v2`, never under `/v1`.

## Try it without an account

Release Notes' code is public, at [github.com/jthingelstad/yvn-release-notes](https://github.com/jthingelstad/yvn-release-notes). Its development server, `tools/dev-server.ts`, runs the same API against a made-up account and prints a token for it when it starts. An Android emulator reaches it at `10.0.2.2`.
