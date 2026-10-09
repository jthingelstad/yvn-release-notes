"""The one DynamoDB table.

    pk               sk                         what
    USER#<id>        PROFILE                    email, birthday, tz, send_time, status, last_sent_date,
                                                city, region, country, lat, lon; stopped_reason when stopped;
                                                pause_from, pause_through for the latest pause
    USER#<id>        PAUSE#<YYYY-MM-DD>         one pause: through (inclusive), kept for the streak and export
    USER#<id>        DAY#<YYYY-MM-DD>           the email sent that day: version, token, message id
    USER#<id>        NOTE#<YYYY-MM-DD>#<msgid>  one reply: text, attachment list, raw S3 key
    USER#<id>        NOTE#<YYYY-MM-DD>#w-<id>   one note written on the web: text, source=web
    USER#<id>        NOTE#<YYYY-MM-DD>#d1-<id>  one imported Day One entry: source=import, origin
                                                (every kind has the same fields, notes.py: tags, written_at,
                                                tz, place; links, named once when written, links.py; media,
                                                its photos and recordings, media.py)
    USER#<id>        WEATHER#<YYYY-MM-DD>       that day's weather where the subscriber was (weather.py): high_c,
                                                low_c, code, city, region, country, lat, lon; kept for good
    USER#<id>        EXPORT                     the latest zip export (export_job.py): id, status
                                                building|ready|failed, started_at; when ready, export_key,
                                                size, files; gone a day after it is built
    TOKEN#<token>    TOKEN                      reply address -> user and day
    EMAIL#<address>  EMAIL                      address -> user (one subscriber per address)
    LOGIN#<hash>     LOGIN                      a sign-in's link and code (auth.py), 15 minutes
    LOGINFOR#<hash>  LOGIN                      an address's newest sign-in, the one a code is checked against
    SESSION#<hash>   SESSION                    a signed-in browser: user, or the address of one signing up
    RATE#<key>#<hr>  RATE                       a counter for one hour of sign-in emails
    RATE#<key>#<day> RATE                       a counter for one day of wrong sign-in codes
    TALLY#<YYYY-MM>  TALLY                      that month's counts: signups, unsubscribes, restarts,
                                                bounces, complaints, deletes. Numbers only, no one named

expires_at (epoch seconds) is the table's TTL. DynamoDB deletes late, up to
a couple of days, so every read checks it as well. Hashes are SHA-256 of
the secret (or, for LOGINFOR and RATE, of the address or network).

A note is filed under the day of the email it answers, not the day it
arrived, so a reply to Tuesday's email sent on Thursday is Tuesday's note.
A day can have any number of notes, one per reply; together, in the order
they were written, they are that day's release notes (notes.py). The message
id in the key is random, so key order is not that order: sort by
notes.written_at.
"""

from dataclasses import dataclass
from datetime import date
from decimal import Decimal

from .notes import written_at
from .weather import place_of


def numbers(v):
    """A value as DynamoDB takes it: floats as Decimal, all the way down
    (an imported note's place and media carry coordinates)."""
    if isinstance(v, float):
        return Decimal(str(v))
    if isinstance(v, dict):
        return {k: numbers(x) for k, x in v.items()}
    if isinstance(v, list):
        return [numbers(x) for x in v]
    return v


def _failed_condition(e: Exception) -> bool:
    # A botocore ClientError, read by shape so the tests need no boto.
    code = (getattr(e, "response", None) or {}).get("Error", {}).get("Code")
    return code == "ConditionalCheckFailedException"


def _number(item: dict, key: str, default: int = 0) -> int:
    # DynamoDB hands numbers back as Decimal.
    return int(item.get(key, default))


@dataclass
class Subscriber:
    user_id: str
    email: str
    birthday: date
    tz: str
    send_time: str
    status: str
    last_sent_date: str | None
    pause_from: str | None = None
    pause_through: str | None = None
    place: dict | None = None  # the city, for weather (weather.place_of)

    def paused_on(self, day: str) -> bool:
        return bool(self.pause_from and self.pause_through and self.pause_from <= day <= self.pause_through)

    @classmethod
    def from_item(cls, item: dict) -> "Subscriber":
        return cls(
            user_id=item["pk"].removeprefix("USER#"),
            email=item["email"],
            birthday=date.fromisoformat(item["birthday"]),
            tz=item["tz"],
            send_time=item.get("send_time", "06:00"),
            status=item.get("status", "active"),
            last_sent_date=item.get("last_sent_date"),
            pause_from=item.get("pause_from"),
            pause_through=item.get("pause_through"),
            place=place_of(item),
        )


class Store:
    def __init__(self, table):
        self.table = table

    # subscribers ---------------------------------------------------------

    def active_subscribers(self) -> list[Subscriber]:
        # A scan is fine at this size. Add an index when there are thousands.
        items, kwargs = [], {
            "FilterExpression": "sk = :p AND #s = :a",
            "ExpressionAttributeNames": {"#s": "status"},
            "ExpressionAttributeValues": {":p": "PROFILE", ":a": "active"},
        }
        while True:
            page = self.table.scan(**kwargs)
            items.extend(page.get("Items", []))
            if "LastEvaluatedKey" not in page:
                break
            kwargs["ExclusiveStartKey"] = page["LastEvaluatedKey"]
        return [Subscriber.from_item(i) for i in items]

    def census_items(self) -> list[dict]:
        """Every subscriber's profile, sent days and notes, for the
        dashboard's counts (census.py): keys and a few fields, never a note's
        text, an address or a reply token."""
        items, kwargs = [], {
            "FilterExpression": "begins_with(pk, :u) AND (sk = :p OR begins_with(sk, :d) OR begins_with(sk, :n))",
            "ProjectionExpression": "pk, sk, #st, tz, send_time, last_sent_date, pause_from, pause_through, #src, #m[0].#k",
            "ExpressionAttributeNames": {"#st": "status", "#src": "source", "#m": "media", "#k": "kind"},
            "ExpressionAttributeValues": {":u": "USER#", ":p": "PROFILE", ":d": "DAY#", ":n": "NOTE#"},
        }
        while True:
            page = self.table.scan(**kwargs)
            items.extend(page.get("Items", []))
            if "LastEvaluatedKey" not in page:
                break
            kwargs["ExclusiveStartKey"] = page["LastEvaluatedKey"]
        return items

    def get_subscriber(self, user_id: str) -> Subscriber | None:
        item = self.table.get_item(Key={"pk": f"USER#{user_id}", "sk": "PROFILE"}).get("Item")
        return Subscriber.from_item(item) if item else None

    # the daily claim -------------------------------------------------------

    def claim_day(self, user_id: str, day: str) -> bool:
        """Mark today's email as sent before sending it, so a retry or an
        overlapping run cannot send twice. Returns False if already claimed."""
        try:
            self.table.update_item(
                Key={"pk": f"USER#{user_id}", "sk": "PROFILE"},
                UpdateExpression="SET last_sent_date = :d",
                ConditionExpression="attribute_exists(pk) AND (attribute_not_exists(last_sent_date) OR last_sent_date < :d)",
                ExpressionAttributeValues={":d": day},
            )
            return True
        except Exception as e:
            if _failed_condition(e):
                return False
            raise

    def release_day(self, user_id: str, day: str, previous: str | None) -> None:
        """Undo a claim after a failed send so the next run tries again."""
        if previous:
            expr, values = "SET last_sent_date = :p", {":p": previous, ":d": day}
        else:
            expr, values = "REMOVE last_sent_date", {":d": day}
        self.table.update_item(
            Key={"pk": f"USER#{user_id}", "sk": "PROFILE"},
            UpdateExpression=expr,
            ConditionExpression="last_sent_date = :d",
            ExpressionAttributeValues=values,
        )

    def put_day(self, user_id: str, day: str, version: str, token: str, sent_at: str) -> None:
        self.table.put_item(Item={"pk": f"TOKEN#{token}", "sk": "TOKEN", "user_id": user_id, "date": day, "version": version})
        self.table.put_item(
            Item={"pk": f"USER#{user_id}", "sk": f"DAY#{day}", "version": version, "token": token, "sent_at": sent_at}
        )

    def drop_day(self, user_id: str, day: str, token: str) -> None:
        """Undo put_day after a failed send: its reply address and the DAY
        item, if it is still this attempt's."""
        self.table.delete_item(Key={"pk": f"TOKEN#{token}", "sk": "TOKEN"})
        try:
            self.table.delete_item(
                Key={"pk": f"USER#{user_id}", "sk": f"DAY#{day}"},
                ConditionExpression="#t = :t",
                ExpressionAttributeNames={"#t": "token"},
                ExpressionAttributeValues={":t": token},
            )
        except Exception as e:
            if not _failed_condition(e):
                raise

    def set_day_message_id(self, user_id: str, day: str, message_id: str) -> None:
        self.table.update_item(
            Key={"pk": f"USER#{user_id}", "sk": f"DAY#{day}"},
            UpdateExpression="SET ses_message_id = :m",
            ExpressionAttributeValues={":m": message_id},
        )

    # replies -------------------------------------------------------------

    def get_token(self, token: str) -> dict | None:
        return self.table.get_item(Key={"pk": f"TOKEN#{token}", "sk": "TOKEN"}).get("Item")

    def _dates(self, user_id: str, prefix: str) -> set[str]:
        return {sk.split("#")[1] for sk in self._keys(user_id, prefix)}

    def note_ids(self, user_id: str) -> set[str]:
        """Every note's id, whatever its day."""
        return {sk.split("#", 2)[2] for sk in self._keys(user_id, "NOTE#")}

    def _keys(self, user_id: str, prefix: str) -> set[str]:
        # Keys only: no note text.
        keys, kwargs = set(), {
            "KeyConditionExpression": "pk = :u AND begins_with(sk, :n)",
            "ExpressionAttributeValues": {":u": f"USER#{user_id}", ":n": prefix},
            "ProjectionExpression": "sk",
        }
        while True:
            page = self.table.query(**kwargs)
            keys.update(i["sk"] for i in page.get("Items", []))
            if "LastEvaluatedKey" not in page:
                break
            kwargs["ExclusiveStartKey"] = page["LastEvaluatedKey"]
        return keys

    def note_days(self, user_id: str) -> set[date]:
        """The days this subscriber has a note for."""
        return {date.fromisoformat(d) for d in self._dates(user_id, "NOTE#")}

    def sent_days(self, user_id: str) -> set[str]:
        """The days an email went out, as ISO dates."""
        return self._dates(user_id, "DAY#")

    def notes_between(self, user_id: str, first: str, last: str) -> list[dict]:
        """Every note from one day through another, oldest first. '$'
        sorts just after '#', so the range ends after the last day's notes."""
        items, kwargs = [], {
            "KeyConditionExpression": "pk = :u AND sk BETWEEN :a AND :b",
            "ExpressionAttributeValues": {":u": f"USER#{user_id}", ":a": f"NOTE#{first}#", ":b": f"NOTE#{last}$"},
        }
        while True:
            page = self.table.query(**kwargs)
            items.extend(page.get("Items", []))
            if "LastEvaluatedKey" not in page:
                break
            kwargs["ExclusiveStartKey"] = page["LastEvaluatedKey"]
        return sorted(items, key=lambda i: (i["sk"].split("#")[1], written_at(i), i["sk"]))

    def day_notes(self, user_id: str, day: str) -> list[dict]:
        """Every note filed for one day, oldest first."""
        items, kwargs = [], {
            "KeyConditionExpression": "pk = :u AND begins_with(sk, :n)",
            "ExpressionAttributeValues": {":u": f"USER#{user_id}", ":n": f"NOTE#{day}#"},
        }
        while True:
            page = self.table.query(**kwargs)
            items.extend(page.get("Items", []))
            if "LastEvaluatedKey" not in page:
                break
            kwargs["ExclusiveStartKey"] = page["LastEvaluatedKey"]
        return sorted(items, key=lambda i: (written_at(i), i["sk"]))

    def all_notes(self, user_id: str) -> list[dict]:
        """Every note, oldest day first."""
        return self.notes_between(user_id, "0000-00-00", "9999-99-99")

    def put_note(self, user_id: str, day: str, message_id: str, note: dict) -> bool:
        """Store one reply. SES retries a failed Lambda, so the message id
        makes this idempotent. Returns False if the note already exists."""
        try:
            self.table.put_item(
                Item={"pk": f"USER#{user_id}", "sk": f"NOTE#{day}#{message_id}", **numbers(note)},
                ConditionExpression="attribute_not_exists(pk)",
            )
            return True
        except Exception as e:
            if _failed_condition(e):
                return False
            raise

    def update_note(self, user_id: str, day: str, note_id: str, text: str, at: str, links: list[dict] | None = None,
                    tags: list[str] | None = None) -> dict | None:
        """Change a note's text, its links and its tags. Returns the note, or
        None if there is none."""
        sets, removes, values = ["#t = :t", "updated_at = :at"], [], {":t": text, ":at": at}
        for name, ref, value in (("links", ":l", links), ("tags", ":g", tags)):
            if value:
                sets.append(f"{name} = {ref}")
                values[ref] = value
            else:
                removes.append(name)
        expr = "SET " + ", ".join(sets) + (" REMOVE " + ", ".join(removes) if removes else "")
        try:
            return self.table.update_item(
                Key={"pk": f"USER#{user_id}", "sk": f"NOTE#{day}#{note_id}"},
                UpdateExpression=expr,
                ConditionExpression="attribute_exists(pk)",
                ExpressionAttributeNames={"#t": "text"},
                ExpressionAttributeValues=values,
                ReturnValues="ALL_NEW",
            )["Attributes"]
        except Exception as e:
            if _failed_condition(e):
                return None
            raise

    def add_media(self, user_id: str, day: str, note_id: str, entries: list[dict], had: int, at: str) -> dict | None:
        """Add files to the end of a note's media, if it still has the `had`
        it was read with (two pages adding at once must not both take the
        same numbers). Returns the note, or None if it is gone or changed."""
        condition = "attribute_exists(pk) AND " + ("size(media) = :had" if had else "attribute_not_exists(media)")
        values = {":m": numbers(entries), ":none": [], ":at": at, **({":had": had} if had else {})}
        try:
            return self.table.update_item(
                Key={"pk": f"USER#{user_id}", "sk": f"NOTE#{day}#{note_id}"},
                UpdateExpression="SET media = list_append(if_not_exists(media, :none), :m), updated_at = :at",
                ConditionExpression=condition,
                ExpressionAttributeValues=values,
                ReturnValues="ALL_NEW",
            )["Attributes"]
        except Exception as e:
            if _failed_condition(e):
                return None
            raise

    def note(self, user_id: str, day: str, note_id: str) -> dict | None:
        return self.table.get_item(Key={"pk": f"USER#{user_id}", "sk": f"NOTE#{day}#{note_id}"}).get("Item")

    def set_media_text(self, user_id: str, day: str, note_id: str, n: int, field: str, text: str) -> bool:
        """Put words about one file (a recording's `transcript`, a photo's
        `description`) on its entry in the note's media, found by its
        number. False if the note or the file is gone."""
        note = self.note(user_id, day, note_id)
        at = next((i for i, m in enumerate((note or {}).get("media") or []) if int(m["n"]) == n), None)
        if at is None:
            return False
        try:
            self.table.update_item(
                Key={"pk": f"USER#{user_id}", "sk": f"NOTE#{day}#{note_id}"},
                UpdateExpression=f"SET media[{at}].#f = :t",
                ConditionExpression=f"attribute_exists(pk) AND media[{at}].n = :n",
                ExpressionAttributeNames={"#f": field},
                ExpressionAttributeValues={":t": text, ":n": n},
            )
            return True
        except Exception as e:
            if _failed_condition(e):
                return False
            raise

    def delete_note(self, user_id: str, day: str, note_id: str) -> dict | None:
        """Delete a note. Returns what it was (the caller deletes its raw
        email), or None if there was none."""
        return self.table.delete_item(
            Key={"pk": f"USER#{user_id}", "sk": f"NOTE#{day}#{note_id}"}, ReturnValues="ALL_OLD"
        ).get("Attributes")

    def user_for_email(self, email: str) -> str | None:
        item = self.table.get_item(Key={"pk": f"EMAIL#{email}", "sk": "EMAIL"}).get("Item")
        return item["user_id"] if item else None

    def profile(self, user_id: str) -> dict | None:
        return self.table.get_item(Key={"pk": f"USER#{user_id}", "sk": "PROFILE"}).get("Item")

    def create_subscriber(self, user_id: str, email: str, profile: dict) -> bool:
        """The EMAIL and PROFILE items in one transaction, so an address
        signs up once. Returns False if the address already has an account.

        The table's client takes plain Python values, as the table does: the
        resource serializes them. Typed values would be typed twice."""

        def put(item):
            return {"Put": {"TableName": self.table.name, "Item": item, "ConditionExpression": "attribute_not_exists(pk)"}}

        try:
            self.table.meta.client.transact_write_items(
                TransactItems=[
                    put({"pk": f"EMAIL#{email}", "sk": "EMAIL", "user_id": user_id}),
                    put({"pk": f"USER#{user_id}", "sk": "PROFILE", "email": email, **profile}),
                ]
            )
            return True
        except Exception as e:
            reasons = (getattr(e, "response", None) or {}).get("CancellationReasons") or []
            if any(r.get("Code") == "ConditionalCheckFailed" for r in reasons):
                return False
            raise

    def update_profile(self, user_id: str, fields: dict, remove: tuple = ()) -> None:
        names = {f"#f{i}": k for i, k in enumerate(fields)}
        names.update({f"#r{i}": k for i, k in enumerate(remove)})
        values = {f":v{i}": v for i, v in enumerate(fields.values())}
        expr = "SET " + ", ".join(f"#f{i} = :v{i}" for i in range(len(fields)))
        if remove:
            expr += " REMOVE " + ", ".join(f"#r{i}" for i in range(len(remove)))
        self.table.update_item(
            Key={"pk": f"USER#{user_id}", "sk": "PROFILE"},
            UpdateExpression=expr,
            ConditionExpression="attribute_exists(pk)",
            ExpressionAttributeNames=names,
            ExpressionAttributeValues=values,
        )

    def stop(self, user_id: str, reason: str, at: str) -> None:
        """No more emails until the subscriber starts them again."""
        self.update_profile(user_id, {"status": "stopped", "stopped_reason": reason, "stopped_at": at})

    # pauses ----------------------------------------------------------------

    def pauses(self, user_id: str) -> list[tuple[str, str]]:
        """Every pause, as (from, through) ISO dates."""
        items, kwargs = [], {
            "KeyConditionExpression": "pk = :u AND begins_with(sk, :n)",
            "ExpressionAttributeValues": {":u": f"USER#{user_id}", ":n": "PAUSE#"},
        }
        while True:
            page = self.table.query(**kwargs)
            items.extend(page.get("Items", []))
            if "LastEvaluatedKey" not in page:
                break
            kwargs["ExclusiveStartKey"] = page["LastEvaluatedKey"]
        return [(i["sk"][6:], i["through"]) for i in items]

    def put_pause(self, user_id: str, start: str, through: str, at: str) -> None:
        """A pause from start through a day. The profile carries the latest
        one, so the sender reads it with everything else."""
        self.table.put_item(Item={"pk": f"USER#{user_id}", "sk": f"PAUSE#{start}", "through": through, "created_at": at})
        self.update_profile(user_id, {"pause_from": start, "pause_through": through})

    def end_pause(self, user_id: str, start: str, through: str | None) -> None:
        """Resume: the pause now ended on through, or (None) never happened."""
        key = {"pk": f"USER#{user_id}", "sk": f"PAUSE#{start}"}
        if through:
            self.table.update_item(
                Key=key, UpdateExpression="SET through = :t", ExpressionAttributeValues={":t": through}
            )
        else:
            self.table.delete_item(Key=key)
        self.table.update_item(
            Key={"pk": f"USER#{user_id}", "sk": "PROFILE"},
            UpdateExpression="REMOVE pause_from, pause_through",
            ConditionExpression="attribute_exists(pk)",
        )

    def delete_keys(self, keys: list[dict]) -> None:
        """Delete items by key, 25 to a request; the batch writer resends
        anything DynamoDB leaves unprocessed."""
        with self.table.batch_writer() as batch:
            for key in keys:
                batch.delete_item(Key=key)

    # weather ------------------------------------------------------------------

    # imports: IMPORT#<app>#<journal> holds the ids of every entry imported,
    # so a repeat skips them, kept or deleted since (importer.py)

    def imported(self, user_id: str, ledger: str) -> set[str]:
        got = self.table.get_item(Key={"pk": f"USER#{user_id}", "sk": ledger}, ProjectionExpression="ids")
        return set(got.get("Item", {}).get("ids") or ())

    def add_imported(self, user_id: str, ledger: str, ids: list[str], at: str) -> None:
        self.table.update_item(
            Key={"pk": f"USER#{user_id}", "sk": ledger},
            UpdateExpression="ADD ids :i SET updated_at = :t",
            ExpressionAttributeValues={":i": set(ids), ":t": at},
        )

    def put_weather(self, user_id: str, day: str, fields: dict) -> bool:
        """Keep a day's weather, once: the first reading stands. False if the
        day already had one."""
        item = {k: Decimal(str(v)) if isinstance(v, float) else v for k, v in fields.items()}
        try:
            self.table.put_item(Item={"pk": f"USER#{user_id}", "sk": f"WEATHER#{day}", **item},
                                ConditionExpression="attribute_not_exists(sk)")
            return True
        except Exception as e:
            if _failed_condition(e):
                return False
            raise

    def weather_between(self, user_id: str, first: str, last: str) -> dict[str, dict]:
        """Day -> its weather, for days first through last."""
        items, kwargs = [], {
            "KeyConditionExpression": "pk = :u AND sk BETWEEN :a AND :b",
            "ExpressionAttributeValues": {":u": f"USER#{user_id}", ":a": f"WEATHER#{first}", ":b": f"WEATHER#{last}"},
        }
        while True:
            page = self.table.query(**kwargs)
            items.extend(page.get("Items", []))
            if "LastEvaluatedKey" not in page:
                break
            kwargs["ExclusiveStartKey"] = page["LastEvaluatedKey"]
        return {i["sk"][8:]: i for i in items}

    # the zip export ---------------------------------------------------------

    def export(self, user_id: str) -> dict | None:
        return self.table.get_item(Key={"pk": f"USER#{user_id}", "sk": "EXPORT"}).get("Item")

    def start_export(self, user_id: str, export_id: str, now: int, expires: int) -> None:
        """A new build, in place of any earlier one."""
        self.table.put_item(Item={"pk": f"USER#{user_id}", "sk": "EXPORT", "id": export_id, "status": "building",
                                  "started_at": now, "expires_at": expires})

    def finish_export(self, user_id: str, export_id: str, fields: dict) -> bool:
        """Record how build export_id ended. False if a newer build, or
        deleting the account, has replaced it."""
        names = {"#id": "id", "#s": "status", **{f"#f{i}": k for i, k in enumerate(fields)}}
        values = {":id": export_id, ":b": "building", **{f":v{i}": v for i, v in enumerate(fields.values())}}
        try:
            self.table.update_item(
                Key={"pk": f"USER#{user_id}", "sk": "EXPORT"},
                UpdateExpression="SET " + ", ".join(f"#f{i} = :v{i}" for i in range(len(fields))),
                ConditionExpression="#id = :id AND #s = :b",
                ExpressionAttributeNames=names,
                ExpressionAttributeValues=values,
            )
            return True
        except Exception as e:
            if _failed_condition(e):
                return False
            raise

    def user_items(self, user_id: str) -> list[dict]:
        """Everything filed under one subscriber: the export reads this."""
        items, kwargs = [], {
            "KeyConditionExpression": "pk = :u",
            "ExpressionAttributeValues": {":u": f"USER#{user_id}"},
        }
        while True:
            page = self.table.query(**kwargs)
            items.extend(page.get("Items", []))
            if "LastEvaluatedKey" not in page:
                break
            kwargs["ExclusiveStartKey"] = page["LastEvaluatedKey"]
        return items

    # sign-in ---------------------------------------------------------------

    def put_login(self, token_hash: str, email: str, email_hash: str, code_hash: str, now: int, ttl: int) -> None:
        expires = now + ttl
        self.table.put_item(
            Item={
                "pk": f"LOGIN#{token_hash}",
                "sk": "LOGIN",
                "email": email,
                "email_hash": email_hash,
                "code_hash": code_hash,
                "attempts": 0,
                "created_at": now,
                "expires_at": expires,
            }
        )
        self.table.put_item(
            Item={"pk": f"LOGINFOR#{email_hash}", "sk": "LOGIN", "token_hash": token_hash, "expires_at": expires}
        )

    def newest_login(self, email_hash: str) -> str | None:
        item = self.table.get_item(Key={"pk": f"LOGINFOR#{email_hash}", "sk": "LOGIN"}).get("Item")
        return item["token_hash"] if item else None

    def spend_attempt(self, token_hash: str, now: int, max_attempts: int) -> dict | str:
        """Count a code attempt before the code is compared. Returns the
        sign-in, or why it cannot take a code: gone, used or attempts."""
        try:
            return self.table.update_item(
                Key={"pk": f"LOGIN#{token_hash}", "sk": "LOGIN"},
                UpdateExpression="SET attempts = attempts + :one",
                ConditionExpression=(
                    "attribute_exists(pk) AND attribute_not_exists(used_at) AND expires_at > :now AND attempts < :max"
                ),
                ExpressionAttributeValues={":one": 1, ":now": now, ":max": max_attempts},
                ReturnValues="ALL_NEW",
            )["Attributes"]
        except Exception as e:
            if not _failed_condition(e):
                raise
        item = self.table.get_item(Key={"pk": f"LOGIN#{token_hash}", "sk": "LOGIN"}).get("Item")
        if not item or _number(item, "expires_at") <= now:
            return "gone"
        if "used_at" in item:
            return "used"
        return "attempts"

    def burn_login(self, token_hash: str, now: int) -> dict | None:
        """Use a sign-in, once. The link and the code both end here, so
        whichever comes first wins and the other finds it used."""
        try:
            return self.table.update_item(
                Key={"pk": f"LOGIN#{token_hash}", "sk": "LOGIN"},
                UpdateExpression="SET used_at = :now",
                ConditionExpression="attribute_exists(pk) AND attribute_not_exists(used_at) AND expires_at > :now",
                ExpressionAttributeValues={":now": now},
                ReturnValues="ALL_NEW",
            )["Attributes"]
        except Exception as e:
            if _failed_condition(e):
                return None
            raise

    def count(self, key: str, hour: int, span: int = 3600) -> int:
        """Add one to a counter for one period (`hour` counts `span`
        seconds: an hour, or a day for wrong codes) and return the new total."""
        item = self.table.update_item(
            Key={"pk": f"RATE#{key}#{hour}", "sk": "RATE"},
            UpdateExpression="ADD n :one SET expires_at = :exp",
            ExpressionAttributeValues={":one": 1, ":exp": (hour + 2) * span},
            ReturnValues="UPDATED_NEW",
        )["Attributes"]
        return _number(item, "n")

    def peek(self, key: str, period: int) -> int:
        item = self.table.get_item(Key={"pk": f"RATE#{key}#{period}", "sk": "RATE"}).get("Item")
        return _number(item, "n") if item else 0

    def tally(self, month: str, name: str) -> None:
        """Add one to a month's count of something that happened."""
        self.table.update_item(
            Key={"pk": f"TALLY#{month}", "sk": "TALLY"},
            UpdateExpression="ADD #n :one",
            ExpressionAttributeNames={"#n": name},
            ExpressionAttributeValues={":one": 1},
        )

    def tallies(self) -> dict[str, dict[str, int]]:
        items, kwargs = [], {"FilterExpression": "begins_with(pk, :t)", "ExpressionAttributeValues": {":t": "TALLY#"}}
        while True:
            page = self.table.scan(**kwargs)
            items.extend(page.get("Items", []))
            if "LastEvaluatedKey" not in page:
                break
            kwargs["ExclusiveStartKey"] = page["LastEvaluatedKey"]
        return {i["pk"].split("#", 1)[1]: {k: int(v) for k, v in i.items() if k not in ("pk", "sk")} for i in items}

    # sessions --------------------------------------------------------------

    def put_session(self, session_hash: str, *, user_id: str | None, email: str | None, now: int, expires: int) -> None:
        item = {"pk": f"SESSION#{session_hash}", "sk": "SESSION", "created_at": now, "seen_at": now, "expires_at": expires}
        if user_id:
            item["user_id"] = user_id
        else:
            item["email"] = email  # signing up: no account yet
        self.table.put_item(Item=item)

    def get_session(self, session_hash: str) -> dict | None:
        return self.table.get_item(Key={"pk": f"SESSION#{session_hash}", "sk": "SESSION"}).get("Item")

    def touch_session(self, session_hash: str, now: int, expires: int) -> None:
        self.table.update_item(
            Key={"pk": f"SESSION#{session_hash}", "sk": "SESSION"},
            UpdateExpression="SET seen_at = :now, expires_at = :exp",
            ConditionExpression="attribute_exists(pk)",
            ExpressionAttributeValues={":now": now, ":exp": expires},
        )

    def claim_session(self, session_hash: str, user_id: str) -> None:
        """A signing-up session becomes the new subscriber's."""
        self.table.update_item(
            Key={"pk": f"SESSION#{session_hash}", "sk": "SESSION"},
            UpdateExpression="SET user_id = :u REMOVE email",
            ConditionExpression="attribute_exists(pk)",
            ExpressionAttributeValues={":u": user_id},
        )

    def delete_session(self, session_hash: str) -> None:
        self.table.delete_item(Key={"pk": f"SESSION#{session_hash}", "sk": "SESSION"})
