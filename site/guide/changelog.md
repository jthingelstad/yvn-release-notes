---
title: Release Notes for Changelog
description: Changelog, the iPhone app for getting notes into Release Notes and reading them there, how to get it, and everything it has learned to do, one version at a time.
---

Changelog is Release Notes on your iPhone. Write a line and Commit, and it's in today's notes: two taps. Add photos, a voice memo or where you are. Siri, a widget, the Action Button and the share sheet start a note too, and your notes, your Upcoming dates and everything that came in are a tab away.

![Log in Changelog: today's version, 4.5.138, large, then "What changed today?" with a line being written, tags to tap and a tangerine Commit.](/guide/changelog/log.png)
![Upcoming in Changelog, in dark mode: a trip to Paris, a book club night, two birthdays and an anniversary, soonest first.](/guide/changelog/upcoming.png)
![Activity in Changelog: notes filed, dates added and badges earned, each with its time.](/guide/changelog/activity.png)

## Get it

Changelog is in testing on TestFlight, Apple's app for trying an app before it's in the App Store. On your iPhone, open [the TestFlight invitation](https://testflight.apple.com/join/YxT4gRQW): it takes you to TestFlight, then installs Changelog. It needs a Release Notes account, which you sign in with when it opens. Tell Jamie what you find from TestFlight, or, signed in here, from [Feedback](/feedback/).

## How it works

Changelog is the fast way in, with your notes along. Search and looking back, your account and your settings stay on the web. You sign it in with Release Notes, which asks you to name the [API token](/guide/tokens/) it keeps and choose what it may do, and it talks to Release Notes through [the API](/guide/api/), as any app you write yourself can. Its code is open, [on GitHub](https://github.com/jthingelstad/changelog-ios).

## Version by version

It numbers itself the way Release Notes numbers you. It started on October 29, 2026, so that day is 0.0.0, and the foot of its Settings names the version and the build. Newest first.

## 0.0.7 · November 5

- **Your notes:** a new Notes tab reads your days, from today back, with every note from any channel. A note opens whole: its photos and files, transcripts and descriptions, the place and the weather. You can change or delete it from there too.
- **Allow reading:** a new sign-in asks to read all your notes, and you can untick that. If you're already signed in, Changelog keeps doing what it did until you tap Allow reading in the Notes tab. Your switches, your draft and anything waiting to send all stay.
- **An optional lock:** turn on Lock reading in Settings, and reading asks for Face ID. Log, Share and Siri still take a note while it's locked. Today shows only the notes this phone sent, and the app switcher shows no note.
- **Activity opens your notes:** with reading open, a row about a note opens that note, and a reply filed by email opens its day. A reminder's row now says it was in the daily email.
- **Upcoming, by month:** dates sit under their months, and each says how far off it is, in days and then weeks.

## 0.0.3 · November 1

- **A new icon:** Versions, three folded v marks stacked on navy, so Changelog stands apart from Release Notes' single v on your Home Screen. It's the mark at the top of every tab and on the widgets too.
- **Four more icons for Supporting Members** of the Weekly Thing: Paper, Copper, Terminal and Afterglow. Choose one in Settings, under App icon. [About membership](https://weekly.thingelstad.com/members/).
- **Your week and day:** Log and the Today widget say which week and day you're on, under the version, as Release Notes does on the web and in the morning email.

## 0.0.1 · October 30

- **On paper:** every screen, sheet and widget now looks like Release Notes on the web, with its paper and inks in light and dark, its type, and a tangerine Commit. It opens on the paper too, with no flash of white.
- After you Commit, Log goes back to the box, ready for the next line.
- Sign in to another account, and notes still waiting from the first one stay put. Each says so, and you choose: send it to this account, or delete it.
- Changelog opens again. The build from the night of October 29 closed itself as it opened, once Today had a note in it.
- **Moments:** start a note from one of your iPhone's suggestions. A workout, a song, a place or photos fill it in, and it files to the day it happened, or to today if you'd rather. Nothing goes until you Commit.
- Deleting a note from **Today** asks first, since its photos and files go with it.
- Siri answers sooner on a slow connection, and Changelog sends the note itself, so Siri never asks you to say it again.
- In **Activity**, a deleted note's row says Note deleted, where it stopped at "Deleted from".
- **Tags in any script:** pin #東京 or #москва in Settings and tap it in the tag row, or give one to an Upcoming date.

## 0.0.0 · October 29

- **Sign in with Release Notes.** Name the token Changelog keeps, choose what it may do and when it ends, and you're in. Pasting a token you made in Settings still works. Signing out works offline too, and says so if the token still needs ending on the web; if a token is revoked or runs out, Changelog says that's why it signed out. **Privacy** is a tap away in Settings and when you sign in.
- **Log** a line, with your tags a tap away, and Commit. Touch and hold a tag to add it to every note. **Today** underneath shows the words of the notes you sent from this phone today.
- Nothing gets lost. A note you're writing keeps, even if iOS closes Changelog while you're away. Every note waits on the phone until it's sent, offline included, and sending one again never makes a second note. Waiting notes go when the connection comes back and finish after you lock the phone, and each says what it's waiting for: a connection, today's limit, Release Notes, or room on the phone.
- When Release Notes turns a note down, **Fix** it: change the words, send it without its files, or copy the words. An edit that can't be saved says why.
- **[Check-ins](/guide/check-ins/):** turn on **Notice where I stop** in Settings, and the places you stop go to Activity, to name, remember and write about. **Check in now** adds one with a tap. Off until you turn it on.
- Photos from your library or the camera, a voice memo recorded in the app, and **Here**: the neighbourhood you're in, with a business nearby to pick. Turn on **Add where I am** in Settings and each new note takes where you are.
- **Share** a photo, a PDF, a voice memo, a link or some text from any app. Changelog is in the share sheet, with a line to go with it.
- **Upcoming:** add, change and remove your dates, each in the line the email gives it.
- Notifications, each off until you turn it on: your Upcoming reminders and a "What changed?" with the day's version, both when each morning's email is due, and news from elsewhere, like a note an agent added or a badge, never with a note's words.
- **Activity:** what came in, changed or went out, from every channel, without the words.
- **Siri and Shortcuts:** "Add a note in Changelog" asks what changed and files it without opening the app, with your sticky tag, even with the phone locked. "New Note" opens Changelog ready to write. Put either on the Action Button.
- **Widgets:** today's version and whether you've written yet, on the Home Screen and the Lock Screen, with what's coming up on the medium one. Changelog checks in the background on days you don't open it, so they keep up. And a New Note control for Control Center, the Lock Screen and the Action Button.
- The largest text sizes fit: the version and times stay whole, and Commit moves under the buttons.
