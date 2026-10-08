"""In-memory stand-ins for the table and SES, shared by the web tests and
scripts/dev_server.py."""


class FakeStore:
    """The Store methods web.py uses, with the same conditions."""

    def __init__(self):
        self.emails, self.profiles, self.items = {}, {}, {}
        self.logins, self.newest, self.sessions, self.counts = {}, {}, {}, {}

    def user_for_email(self, email):
        return self.emails.get(email)

    def profile(self, user_id):
        return self.profiles.get(user_id)

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
