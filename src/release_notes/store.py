"""The one DynamoDB table.

    pk               sk                         what
    USER#<id>        PROFILE                    email, birthday, tz, send_time, status, last_sent_date
    USER#<id>        DAY#<YYYY-MM-DD>           the email sent that day: version, token, message id
    USER#<id>        NOTE#<YYYY-MM-DD>#<msgid>  one reply: text, attachment list, raw S3 key
    TOKEN#<token>    TOKEN                      reply address -> user and day
    EMAIL#<address>  EMAIL                      address -> user (one subscriber per address)

A note is filed under the day of the email it answers, not the day it
arrived, so a reply to Tuesday's email sent on Thursday is Tuesday's note.
A day can have any number of notes, one per reply; together, in the order
they arrived, they are that day's release notes (notes.py). The message id in
the key is random, so key order is not arrival order: sort by received_at.
"""

from dataclasses import dataclass
from datetime import date


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
        from botocore.exceptions import ClientError

        try:
            self.table.update_item(
                Key={"pk": f"USER#{user_id}", "sk": "PROFILE"},
                UpdateExpression="SET last_sent_date = :d",
                ConditionExpression="attribute_exists(pk) AND (attribute_not_exists(last_sent_date) OR last_sent_date < :d)",
                ExpressionAttributeValues={":d": day},
            )
            return True
        except ClientError as e:
            if e.response["Error"]["Code"] == "ConditionalCheckFailedException":
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
        from botocore.exceptions import ClientError

        try:
            self.table.put_item(
                Item={"pk": f"USER#{user_id}", "sk": f"NOTE#{day}#{message_id}", **note},
                ConditionExpression="attribute_not_exists(pk)",
            )
            return True
        except ClientError as e:
            if e.response["Error"]["Code"] == "ConditionalCheckFailedException":
                return False
            raise
