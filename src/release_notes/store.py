"""The one DynamoDB table.

    pk               sk                         what
    USER#<id>        PROFILE                    email, birthday, tz, send_time, status, last_sent_date,
                                                city, region, country, lat, lon; stopped_reason when stopped
    USER#<id>        DAY#<YYYY-MM-DD>           the email sent that day: version, token, message id
    USER#<id>        NOTE#<YYYY-MM-DD>#<msgid>  one reply: text, attachment list, raw S3 key
    TOKEN#<token>    TOKEN                      reply address -> user and day
    EMAIL#<address>  EMAIL                      address -> user (one subscriber per address)
    LOGIN#<hash>     LOGIN                      a sign-in's link and code (auth.py), 15 minutes
    LOGINFOR#<hash>  LOGIN                      an address's newest sign-in, the one a code is checked against
    SESSION#<hash>   SESSION                    a signed-in browser: user, or the address of one signing up
    RATE#<key>#<hr>  RATE                       a counter for one hour of sign-in emails

expires_at (epoch seconds) is the table's TTL. DynamoDB deletes late, up to
a couple of days, so every read checks it as well. Hashes are SHA-256 of
the secret (or, for LOGINFOR and RATE, of the address or network).

A note is filed under the day of the email it answers, not the day it
arrived, so a reply to Tuesday's email sent on Thursday is Tuesday's note.
A day can have any number of notes, one per reply; together, in the order
they arrived, they are that day's release notes (notes.py). The message id in
the key is random, so key order is not arrival order: sort by received_at.
"""

from dataclasses import dataclass
from datetime import date


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

    def set_day_message_id(self, user_id: str, day: str, message_id: str) -> None:
        self.table.update_item(
            Key={"pk": f"USER#{user_id}", "sk": f"DAY#{day}"},
            UpdateExpression="SET ses_message_id = :m",
            ExpressionAttributeValues={":m": message_id},
        )

    # replies -------------------------------------------------------------

    def get_token(self, token: str) -> dict | None:
        return self.table.get_item(Key={"pk": f"TOKEN#{token}", "sk": "TOKEN"}).get("Item")

    def note_days(self, user_id: str) -> set[date]:
        """The days this subscriber has a note for. Keys only: no note text."""
        days, kwargs = set(), {
            "KeyConditionExpression": "pk = :u AND begins_with(sk, :n)",
            "ExpressionAttributeValues": {":u": f"USER#{user_id}", ":n": "NOTE#"},
            "ProjectionExpression": "sk",
        }
        while True:
            page = self.table.query(**kwargs)
            days.update(date.fromisoformat(i["sk"].split("#")[1]) for i in page.get("Items", []))
            if "LastEvaluatedKey" not in page:
                break
            kwargs["ExclusiveStartKey"] = page["LastEvaluatedKey"]
        return days

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
        return sorted(items, key=lambda i: (i.get("received_at", ""), i["sk"]))

    def put_note(self, user_id: str, day: str, message_id: str, note: dict) -> bool:
        """Store one reply. SES retries a failed Lambda, so the message id
        makes this idempotent. Returns False if the note already exists."""
        try:
            self.table.put_item(
                Item={"pk": f"USER#{user_id}", "sk": f"NOTE#{day}#{message_id}", **note},
                ConditionExpression="attribute_not_exists(pk)",
            )
            return True
        except Exception as e:
            if _failed_condition(e):
                return False
            raise

    def user_for_email(self, email: str) -> str | None:
        item = self.table.get_item(Key={"pk": f"EMAIL#{email}", "sk": "EMAIL"}).get("Item")
        return item["user_id"] if item else None

    def profile(self, user_id: str) -> dict | None:
        return self.table.get_item(Key={"pk": f"USER#{user_id}", "sk": "PROFILE"}).get("Item")

    def create_subscriber(self, user_id: str, email: str, profile: dict) -> bool:
        """The EMAIL and PROFILE items in one transaction, so an address
        signs up once. Returns False if the address already has an account."""
        from boto3.dynamodb.types import TypeSerializer

        ser = TypeSerializer()

        def put(item):
            return {
                "Put": {
                    "TableName": self.table.name,
                    "Item": {k: ser.serialize(v) for k, v in item.items()},
                    "ConditionExpression": "attribute_not_exists(pk)",
                }
            }

        try:
            self.table.meta.client.transact_write_items(
                TransactItems=[
                    put({"pk": f"EMAIL#{email}", "sk": "EMAIL", "user_id": user_id}),
                    put({"pk": f"USER#{user_id}", "sk": "PROFILE", "email": email, **profile}),
                ]
            )
            return True
        except Exception as e:
            code = (getattr(e, "response", None) or {}).get("Error", {}).get("Code")
            if code == "TransactionCanceledException":
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

    def count(self, key: str, hour: int) -> int:
        """Add one to an hour's counter and return the new total."""
        item = self.table.update_item(
            Key={"pk": f"RATE#{key}#{hour}", "sk": "RATE"},
            UpdateExpression="ADD n :one SET expires_at = :exp",
            ExpressionAttributeValues={":one": 1, ":exp": (hour + 2) * 3600},
            ReturnValues="UPDATED_NEW",
        )["Attributes"]
        return _number(item, "n")

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
