---
title: API changelog
description: What each version of the API added, newest first, with a feed to follow it.
---

Follow [the feed](/guide/api/changelog.xml) in any reader to hear of a new version. Every answer says the version it comes from in `API-Version`, and [the API's description](https://notes.yourversionnumber.com/v1/openapi.json) says it as `info.version`, with this same list as `x-changes`.

`/v1` only ever gains things: new requests, new optional fields, new error codes. A deprecation is announced here with its date, and a breaking change would be `/v2`. The one exception so far is 1.8.0, which withdrew something no released app had sent.

{changes}
