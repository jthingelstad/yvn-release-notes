---
title: Places through the API
description: Say where a note or a day was, with a city or the spot a device is at, and find either one.
---

## Find a place

- `GET /v1/places`: the cities by a name, like `?q=Zürich`, for a note's place.
- `POST /v1/places/here`: the city, neighbourhood and businesses nearby for the spot a device is at, for a note's place.

## Where a note was

A note's `place` says where it was. Send one of two things, as it came:

- **A city** from `GET /v1/places?q=Zürich`, which answers the cities by that name, each with its `region`, `country`, time zone and spot. Pick the right one: two cities can share a name.
- **The spot a device is at**, from `POST /v1/places/here`. Send `lat` and `lon` in degrees, and the device's `accuracy_m` in metres if it has one. The answer's `place` has the spot's city and its neighbourhood as `district`, and `nearby` lists up to 6 businesses within the accuracy. If the person picks one, send the place with `venue` set to its name; nothing is picked for them. The spot is kept to six decimal places, and nothing is kept until a note takes it. Here takes no `Idempotency-Key`: if its answer is lost, ask again, and that counts again.

A place is kept as you send it. Release Notes checks its shape, its names, time zone and spot, but doesn't look it up again, so send the one the person picked.

On the web, a note with a spot links to your map. A note with no place shows the day's city, or your home's.

Changing a saved note's place, with `PUT /v1/notes/{date}/{id}/place`, takes either of those too, and leaves its words and its `revision` alone. A token changes the place of the notes it added, or of any note if it may read and change all your notes.

A token that may do that can also say where a whole day was: `PUT /v1/days/{date}/place` with `{"place": …}` and a city, and `DELETE /v1/days/{date}/place` to take it away. It's what every note that day with no place of its own shows. A day takes a city, not a device's spot.

An earlier day's weather follows its place, as on the web. A new note with a place on an earlier day brings it along too. If the weather can't be had just then, your write still counts.
