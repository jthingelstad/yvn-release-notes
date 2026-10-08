# The web app: notes.yourversionnumber.com

Agreed with Jamie on 2026-10-08. This is the plan the pull requests follow.
Change it here when the plan changes.

Release Notes gets a standalone web app at `notes.yourversionnumber.com`. The
birthday and work sites at `yourversionnumber.com` stay as they are, and nothing
there links here until this is up and done.

## What it does

1. **Sign up or sign in: one screen, one email field.** We send a link and a
   six-digit code. The code covers the case where you asked on the laptop and
   read the mail on the phone. A new address then picks:
   - **Birthday.**
   - **Location, to the city.** It is chosen from a search, and gives the
     time zone and coordinates rounded to the city (for weather later; the
     email does not use it yet). No street address, no device location.
   - **Send time**, on a quarter hour. The default is 06:00.

   The first email comes the next morning. An address that already subscribes
   goes straight to its notes.
2. **Today**: the version number, today's notes from email and the web
   together, a box to write one, and the streak.
3. **Timeline**: days by version, newest first, with their notes.
4. **Any past day**: pick a date and add notes to it (backfill). Any day from
   the birthday to yesterday.
5. **Pause**: no emails for N days (1-60) or until a date. Resume any time;
   otherwise the emails start again on their own.
6. **Export your data**: every note, its day and version, plus the profile,
   as Markdown and JSON. It arrives with sign-in, before anything else, so
   deleting an account never means losing what was in it.
7. **Settings**: send time and location, sign out, delete account (after an
   export is offered, and with a fresh code).
8. **The daily email** gains a "Pause or manage" link and one-click
   `List-Unsubscribe`. A bounce or complaint pauses the subscriber.

## Defaults (Jamie can change any)

- A backfilled day counts toward the streak, the same as a late reply.
- Paused days neither break the streak nor add to it.
- Any of your own notes can be edited or deleted, emailed ones included.
  Deleting an emailed note deletes its raw message from S3 as well.
- The birthday is locked after sign-up, because changing it renumbers every
  day you have kept.
- No analytics on the app.

## Shape

The same as Drop and Thingy, inside this stack:

```
notes.yourversionnumber.com
  CloudFront (PriceClass_100, ACM certificate issued outside the stack)
    default  -> S3 web bucket (private, OAC)     web/: HTML, CSS, vanilla JS, no build step
    /api/*   -> HTTP API -> Lambda yvn-release-notes-web    Python, standard library
                              -> the same DynamoDB table
```

- **Language: Python, standard library.** The sender and inbound handlers are
  Python, `version.py` is checked against fixtures generated from the site's
  own code, and the tests need nothing installed. TypeScript would bring a
  `package.json`, a bundler and a second language to keep in step with
  `version.py`, and buy nothing a JSON API over one table needs.
- **Security headers** on every response: a CSP of `'self'` only (no inline
  script or style, nothing remote), HSTS, `DENY` framing. The city search
  goes through `/api`, which asks Open-Meteo's geocoder (no key, CC BY 4.0),
  so the page never talks to another host.
- **New items in the table.** `expires_at` (epoch seconds) is the table's TTL.

  | Item | Key | Lifetime |
  |---|---|---|
  | Sign-in link and code | `LOGIN#<hash>` | 15 minutes |
  | Session | `SESSION#<hash>` | 30 days idle, 90 days at most |
  | Rate-limit counter | `RATE#<bucket>#<hour>` | about an hour |
  | Pause | `USER#<id>` / `PAUSE#<start>` | kept |
  | Note written on the web | `USER#<id>` / `NOTE#<day>#w-<id>`, `source=web` | kept |

  The profile gains `city`, `region`, `country`, `lat` and `lon` (rounded to
  two places), with `tz` from the same lookup.
- **Sign-in** follows Elixir's design (`packages/auth/src/magic.mjs`):
  - The link and the code burn one shared single-use row. Code attempts are
    counted before comparing, capped at 5, compared in constant time.
  - At most 5 sign-in emails per address per hour, plus a per-IP limit.
  - Only hashes are stored.
  - The answer is the same whether or not the address has an account.
  - The link lands on a "Sign in" button, because mail scanners open links.

  SES production access is account-wide and shared with Elixir's sign-in
  mail, so these limits protect both.
  The limits are 5 sign-in emails per address, 20 per network (an IPv4
  address or an IPv6 /64) and 200 in all, each per hour; past one, the
  answer is 429. The network comes from CloudFront's `CloudFront-Viewer-Address`,
  which the API's own origin request policy passes on. Someone calling the
  API's execute-api URL directly can forge that header, so the total is the
  limit that holds; a shared origin secret would close the gap, and is not
  worth a secret yet.
- **Session**: an `__Host-` cookie, Secure, HttpOnly, SameSite=Lax. Every
  write must carry `Origin: https://notes.yourversionnumber.com`. The API
  receives only the headers it reads (Origin, Content-Type, Accept, the
  viewer address) and only that cookie.
- **Pages**: `/` (sign in, with a live example number from `/api/sample`),
  `/signin/` (the link lands here, token in the fragment), `/settings/`.
  PR 4 adds `/today/`, `/timeline/` and `/day/`, and moves where sign-in
  lands from settings to today.
- **The sender** skips a paused subscriber, and a stopped one: `status` is
  `active` or `stopped`, with `stopped_reason` `unsubscribed`, `bounce` or
  `complaint`. Hard bounces and complaints arrive through the alarms topic
  (which the configuration set already publishes to) at
  `yvn-release-notes-events`.
- **Sign-up's first email** is the next send time to come in the chosen
  city: today's if it is still ahead, otherwise tomorrow's.
- **Logs**: ids, routes and outcomes. Never note text, addresses or cities.

## API

| | |
|---|---|
| `GET /api/health` | |
| `GET /api/sample?birthday=&tz=` | a version number today: the front page's example (1981-06-14), or the birthday being typed at sign-up |
| `POST /api/auth/start` `{email}` | always 202; mails a link and code when the limits allow |
| `POST /api/auth/verify` `{email, code}` or `{token}` | sets the cookie; says whether the account is new |
| `POST /api/auth/signout` | |
| `GET /api/places?q=` | city search, through Open-Meteo; needs a session |
| `GET /api/me` | the profile, or `{new: true}` for an address signing up |
| `PUT /api/me` | sign-up (`birthday`, `place`, `send_time`), or settings (`send_time`, `place`, `status: "active"` to start again); the birthday cannot change |
| `GET /api/export?format=md\|json` | everything, as a download (JSON by default) |
| `GET /api/days?before=&limit=` | the timeline |
| `GET /api/days/{date}` | one day: version and notes |
| `POST /api/days/{date}/notes` | write for today or a past day |
| `PUT/DELETE /api/days/{date}/notes/{id}` | edit, delete |
| `PUT/DELETE /api/pause` | |
| `DELETE /api/me` | needs a fresh code |
| `POST /api/unsubscribe?t=` | the email's one-click unsubscribe (RFC 8058); the token is the day's reply token, and this is the one write without an Origin |
| `GET /api/unsubscribe?t=` | redirects to `/unsubscribe/`, a page with a button, for mail apps that open the link |

## Order

| PR | What ships | How it is checked |
|---|---|---|
| 0 | A design canvas for the screens | Jamie reviews it alongside PR 1 |
| 1 | CloudFront, web bucket, HTTP API, stub function, table TTL, a placeholder page | `/api/health` and the page answer on the cloudfront.net name, then on `notes.` once DNS is in |
| 2 | Sign-in, sessions, the sign-in email, **export** | Jamie signs in and exports |
| 3 | Sign-up with city search, settings, "Pause or manage" and `List-Unsubscribe` in the email, bounces pause | a new account works |
| 4 | Today, timeline, day view, write, backfill, edit, delete | daily use |
| 5 | Pause, delete account | feature-complete |
| 6 | Jamie uses it, invites a few people, then decides on a link from yourversionnumber.com | |

Testing on live: the first end-to-end sign-up uses a plus-address Jamie owns,
once Jamie says so. Everything else is unit tests and dry runs.

## DNS (Namecheap, by Jamie)

1. The ACM validation CNAME for `notes.yourversionnumber.com` (requested
   2026-10-08; read it from ACM, not from here).
2. `notes` CNAME to the distribution's `cloudfront.net` name (stack output
   `WebDistributionDomain`).
