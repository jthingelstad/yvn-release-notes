"""In-memory stand-ins for the table and SES, shared by the web tests and
scripts/dev_server.py."""


class FakeStore:
    """The Store methods web.py uses, with the same conditions."""

    def __init__(self):
        self.emails, self.profiles, self.items = {}, {}, {}
        self.logins, self.newest, self.sessions, self.counts = {}, {}, {}, {}
        self.tokens = {}

    def user_for_email(self, email):
        return self.emails.get(email)

    def profile(self, user_id):
        return self.profiles.get(user_id)

    def create_subscriber(self, user_id, email, profile):
        if email in self.emails or user_id in self.profiles:
            return False
        self.emails[email] = user_id
        self.profiles[user_id] = {"email": email, **profile}
        return True

    def update_profile(self, user_id, fields, remove=()):
        p = self.profiles[user_id]
        p.update(fields)
        for k in remove:
            p.pop(k, None)

    def stop(self, user_id, reason, at):
        self.update_profile(user_id, {"status": "stopped", "stopped_reason": reason, "stopped_at": at})

    def get_token(self, token):
        return self.tokens.get(token)

    # notes and days live in items[user_id], as the table's rows

    def _rows(self, user_id, prefix):
        return [i for i in self.items.get(user_id, []) if i["sk"].startswith(prefix)]

    def add_note(self, user_id, day, note_id, **fields):
        self.items.setdefault(user_id, []).append({"pk": f"USER#{user_id}", "sk": f"NOTE#{day}#{note_id}", **fields})

    def add_day(self, user_id, day, version="0.0.0"):
        self.items.setdefault(user_id, []).append({"pk": f"USER#{user_id}", "sk": f"DAY#{day}", "version": version})

    def note_days(self, user_id):
        from datetime import date

        return {date.fromisoformat(i["sk"].split("#")[1]) for i in self._rows(user_id, "NOTE#")}

    def sent_days(self, user_id):
        return {i["sk"].split("#")[1] for i in self._rows(user_id, "DAY#")}

    def notes_between(self, user_id, first, last):
        rows = [dict(i) for i in self._rows(user_id, "NOTE#") if first <= i["sk"].split("#")[1] <= last]
        return sorted(rows, key=lambda i: (i["sk"].split("#")[1], i.get("received_at", ""), i["sk"]))

    def put_note(self, user_id, day, note_id, note):
        if any(i["sk"] == f"NOTE#{day}#{note_id}" for i in self.items.get(user_id, [])):
            return False
        self.add_note(user_id, day, note_id, **note)
        return True

    def update_note(self, user_id, day, note_id, text, at):
        for i in self._rows(user_id, f"NOTE#{day}#{note_id}"):
            if i["sk"] == f"NOTE#{day}#{note_id}":
                i.update(text=text, updated_at=at)
                return dict(i)
        return None

    def delete_note(self, user_id, day, note_id):
        rows = self.items.get(user_id, [])
        for n, i in enumerate(rows):
            if i["sk"] == f"NOTE#{day}#{note_id}":
                return rows.pop(n)
        return None

    def user_items(self, user_id):
        return [{"pk": f"USER#{user_id}", "sk": "PROFILE", **self.profiles[user_id]}] + self.items.get(user_id, [])

    def put_login(self, token_hash, email, email_hash, code_hash, now, ttl):
        self.logins[token_hash] = dict(email=email, code_hash=code_hash, attempts=0, expires_at=now + ttl)
        self.newest[email_hash] = token_hash

    def newest_login(self, email_hash):
        return self.newest.get(email_hash)

    def spend_attempt(self, token_hash, now, max_attempts):
        row = self.logins.get(token_hash)
        if not row or row["expires_at"] <= now:
            return "gone"
        if "used_at" in row:
            return "used"
        if row["attempts"] >= max_attempts:
            return "attempts"
        row["attempts"] += 1
        return dict(row)

    def burn_login(self, token_hash, now):
        row = self.logins.get(token_hash)
        if not row or "used_at" in row or row["expires_at"] <= now:
            return None
        row["used_at"] = now
        return dict(row)

    def count(self, key, hour):
        self.counts[(key, hour)] = self.counts.get((key, hour), 0) + 1
        return self.counts[(key, hour)]

    def put_session(self, session_hash, *, user_id, email, now, expires):
        s = {"created_at": now, "seen_at": now, "expires_at": expires}
        s.update({"user_id": user_id} if user_id else {"email": email})
        self.sessions[session_hash] = s

    def get_session(self, session_hash):
        s = self.sessions.get(session_hash)
        return dict(s) if s else None

    def touch_session(self, session_hash, now, expires):
        self.sessions[session_hash].update(seen_at=now, expires_at=expires)

    def claim_session(self, session_hash, user_id):
        s = self.sessions[session_hash]
        s.pop("email", None)
        s["user_id"] = user_id

    def delete_session(self, session_hash):
        self.sessions.pop(session_hash, None)


class FakeSES:
    def __init__(self, fail=False):
        self.sent, self.fail = [], fail

    def send_email(self, **kw):
        if self.fail:
            raise ConnectionError("down")
        self.sent.append(kw)
        return {"MessageId": "m1"}


class FakeS3:
    def __init__(self, fail=False):
        self.deleted, self.fail = [], fail

    def delete_object(self, **kw):
        if self.fail:
            raise ConnectionError("down")
        self.deleted.append(kw)
        return {}
