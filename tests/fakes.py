"""In-memory stand-ins for the table, SES, S3 and Lambda, shared by the web
tests and scripts/dev_server.py."""

import re

from release_notes.notes import written_at
from release_notes.store import NEWEST, SIGNIN



class FakeStore:
    """The Store methods web.py uses, with the same conditions."""

    def __init__(self):
        self.emails, self.profiles, self.items = {}, {}, {}
        self.logins, self.newest, self.sessions, self.counts = {}, {}, {}, {}
        self.tokens = {}
        self.tallied = {}  # (month, name) -> n

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
        return sorted(rows, key=lambda i: (i["sk"].split("#")[1], written_at(i), i["sk"]))

    def all_notes(self, user_id):
        return self.notes_between(user_id, "0000-00-00", "9999-99-99")

    def note_tags(self, user_id):
        return [{"sk": n["sk"], **({"tags": n["tags"]} if "tags" in n else {})} for n in self.all_notes(user_id)]

    def tagged_notes(self, user_id, tag):
        return [n for n in self.all_notes(user_id) if tag in (n.get("tags") or [])]

    def put_note(self, user_id, day, note_id, note):
        if any(i["sk"] == f"NOTE#{day}#{note_id}" for i in self.items.get(user_id, [])):
            return False
        self.add_note(user_id, day, note_id, **note)
        return True

    def update_note(self, user_id, day, note_id, text, at, links=None, tags=None):
        for i in self._rows(user_id, f"NOTE#{day}#{note_id}"):
            if i["sk"] == f"NOTE#{day}#{note_id}":
                i.update(text=text, updated_at=at)
                for name, value in (("links", links), ("tags", tags)):
                    if value:
                        i[name] = value
                    else:
                        i.pop(name, None)
                return dict(i)
        return None

    def add_media(self, user_id, day, note_id, entries, had, at):
        for i in self._rows(user_id, f"NOTE#{day}#{note_id}"):
            if i["sk"] == f"NOTE#{day}#{note_id}":
                if len(i.get("media") or []) != had:
                    return None
                i["media"] = list(i.get("media") or []) + list(entries)
                i["updated_at"] = at
                return dict(i)
        return None

    def note(self, user_id, day, note_id):
        return next((i for i in self.items.get(user_id, []) if i["sk"] == f"NOTE#{day}#{note_id}"), None)

    def set_media_text(self, user_id, day, note_id, n, field, text):
        for m in (self.note(user_id, day, note_id) or {}).get("media") or []:
            if int(m["n"]) == n:
                m[field] = text
                return True
        return False

    def delete_note(self, user_id, day, note_id):
        rows = self.items.get(user_id, [])
        for n, i in enumerate(rows):
            if i["sk"] == f"NOTE#{day}#{note_id}":
                return rows.pop(n)
        return None

    def add_day_token(self, user_id, day, token):
        self.items.setdefault(user_id, []).append({"pk": f"USER#{user_id}", "sk": f"DAY#{day}", "token": token})
        self.tokens[token] = {"user_id": user_id, "date": day}

    def pauses(self, user_id):
        return [(i["sk"][6:], i["through"]) for i in self._rows(user_id, "PAUSE#")]

    def put_pause(self, user_id, start, through, at):
        rows = self.items.setdefault(user_id, [])
        rows[:] = [i for i in rows if i["sk"] != f"PAUSE#{start}"]
        rows.append({"pk": f"USER#{user_id}", "sk": f"PAUSE#{start}", "through": through, "created_at": at})
        self.update_profile(user_id, {"pause_from": start, "pause_through": through})

    def end_pause(self, user_id, start, through):
        rows = self.items.setdefault(user_id, [])
        for i in list(rows):
            if i["sk"] == f"PAUSE#{start}":
                if through:
                    i["through"] = through
                else:
                    rows.remove(i)
        self.update_profile(user_id, {}, ("pause_from", "pause_through"))

    def delete_keys(self, keys):
        for key in keys:
            pk, sk = key["pk"], key["sk"]
            if pk.startswith("TOKEN#"):
                self.tokens.pop(pk[6:], None)
            elif pk.startswith("EMAIL#"):
                self.emails.pop(pk[6:], None)
            elif sk == "PROFILE":
                self.profiles.pop(pk[5:], None)
            elif pk.startswith("SESSION#"):
                self.sessions.pop(pk[8:], None)
            elif pk.startswith("LOGIN#"):
                self.logins.pop(pk[6:], None)
            elif pk.startswith("LOGINFOR#"):
                self.newest.pop(f"{sk}#{pk[9:]}", None)
            else:
                rows = self.items.get(pk[5:], [])
                rows[:] = [i for i in rows if i["sk"] != sk]

    def note_ids(self, user_id):
        return {i["sk"].split("#", 2)[2] for i in self._rows(user_id, "NOTE#")}

    def imported(self, user_id, ledger):
        found = self._rows(user_id, ledger)
        return set(found[0]["ids"]) if found else set()

    def add_imported(self, user_id, ledger, ids, at):
        found = self._rows(user_id, ledger)
        if not found:
            found = [{"pk": f"USER#{user_id}", "sk": ledger, "ids": set()}]
            self.items.setdefault(user_id, []).append(found[0])
        found[0]["ids"] |= set(ids)
        found[0]["updated_at"] = at

    def put_weather(self, user_id, day, fields):
        if self._rows(user_id, f"WEATHER#{day}"):
            return False
        self.items.setdefault(user_id, []).append({"pk": f"USER#{user_id}", "sk": f"WEATHER#{day}", **fields})
        return True

    def weather_between(self, user_id, first, last):
        return {i["sk"][8:]: dict(i) for i in self._rows(user_id, "WEATHER#") if first <= i["sk"][8:] <= last}

    def export(self, user_id):
        found = self._rows(user_id, "EXPORT")
        return dict(found[0]) if found else None

    def start_export(self, user_id, export_id, now, expires):
        rows = self.items.setdefault(user_id, [])
        rows[:] = [i for i in rows if i["sk"] != "EXPORT"]
        rows.append({"pk": f"USER#{user_id}", "sk": "EXPORT", "id": export_id, "status": "building",
                     "started_at": now, "expires_at": expires})

    def finish_export(self, user_id, export_id, fields):
        found = self._rows(user_id, "EXPORT")
        if not found or found[0]["id"] != export_id or found[0]["status"] != "building":
            return False
        found[0].update(fields)
        return True

    def user_items(self, user_id):
        profile = [{"pk": f"USER#{user_id}", "sk": "PROFILE", **self.profiles[user_id]}] if user_id in self.profiles else []
        return profile + self.items.get(user_id, [])

    # newest is keyed "<sort key>#<address hash>", as LOGINFOR#<hash> / LOGIN or DELETE

    def put_login(self, token_hash, email, email_hash, code_hash, now, ttl, purpose=SIGNIN):
        self.logins[token_hash] = dict(email=email, code_hash=code_hash, purpose=purpose, attempts=0,
                                       expires_at=now + ttl)
        self.newest[f"{NEWEST[purpose]}#{email_hash}"] = token_hash

    def newest_login(self, email_hash, purpose=SIGNIN):
        return self.newest.get(f"{NEWEST[purpose]}#{email_hash}")

    def login_keys(self, email_hash):
        keys = []
        for sk in NEWEST.values():
            if f"{sk}#{email_hash}" in self.newest:
                keys += [{"pk": f"LOGINFOR#{email_hash}", "sk": sk},
                         {"pk": f"LOGIN#{self.newest[f'{sk}#{email_hash}']}", "sk": "LOGIN"}]
        return keys

    def spend_attempt(self, token_hash, now, max_attempts, purpose=SIGNIN):
        row = self.logins.get(token_hash)
        if not row or row["expires_at"] <= now or row.get("purpose", SIGNIN) != purpose:
            return "gone"
        if "used_at" in row:
            return "used"
        if row["attempts"] >= max_attempts:
            return "attempts"
        row["attempts"] += 1
        return dict(row)

    def burn_login(self, token_hash, now, purpose=SIGNIN):
        row = self.logins.get(token_hash)
        if not row or "used_at" in row or row["expires_at"] <= now or row.get("purpose", SIGNIN) != purpose:
            return None
        row["used_at"] = now
        return dict(row)

    def count(self, key, hour, span=3600):
        self.counts[(key, hour)] = self.counts.get((key, hour), 0) + 1
        return self.counts[(key, hour)]

    def peek(self, key, period):
        return self.counts.get((key, period), 0)

    def count_upload(self, user_id, day, size, max_files, max_bytes):
        n, used = self.counts.get((f"upload:{user_id}", day), (0, 0))
        if n and (n >= max_files or used > max_bytes - size):
            return False
        self.counts[(f"upload:{user_id}", day)] = (n + 1, used + size)
        return True

    def take_lock(self, name, holder, now, hold_for):
        self.locks = getattr(self, "locks", {})
        held = self.locks.get(name)
        if held and held["expires_at"] > now and held["holder"] != holder:
            return False
        self.locks[name] = {"holder": holder, "expires_at": now + hold_for}
        return True

    def release_lock(self, name, holder, now):
        held = getattr(self, "locks", {}).get(name)
        if held and held["holder"] == holder:
            held["expires_at"] = now

    def tally(self, month, name):
        self.tallied[(month, name)] = self.tallied.get((month, name), 0) + 1

    def put_session(self, session_hash, *, user_id, email, now, expires):
        s = {"created_at": now, "seen_at": now, "expires_at": expires}
        s.update({"user_id": user_id} if user_id else {"email": email})
        self.sessions[session_hash] = s
        if user_id:
            self._list_session(session_hash, user_id, expires)

    def _list_session(self, session_hash, user_id, expires):
        rows = self.items.setdefault(user_id, [])
        rows[:] = [i for i in rows if i["sk"] != f"SESSION#{session_hash}"]
        rows.append({"pk": f"USER#{user_id}", "sk": f"SESSION#{session_hash}", "expires_at": expires})

    def get_session(self, session_hash):
        s = self.sessions.get(session_hash)
        return dict(s) if s else None

    def touch_session(self, session_hash, now, expires, user_id=None):
        self.sessions[session_hash].update(seen_at=now, expires_at=expires)
        if user_id:
            self._list_session(session_hash, user_id, expires)

    def claim_session(self, session_hash, user_id, expires):
        s = self.sessions[session_hash]
        s.pop("email", None)
        s["user_id"] = user_id
        self._list_session(session_hash, user_id, expires)

    def delete_session(self, session_hash):
        self.sessions.pop(session_hash, None)


class FakeSES:
    def __init__(self, fail=False):
        self.sent, self.fail = [], fail
        self.suppressed, self.unsuppressed = set(), []  # SES's account-level suppression list

    def send_email(self, **kw):
        if self.fail:
            raise ConnectionError("down")
        self.sent.append(kw)
        return {"MessageId": "m1"}

    def delete_suppressed_destination(self, EmailAddress):
        if EmailAddress not in self.suppressed:
            err = Exception("not found")
            err.response = {"Error": {"Code": "NotFoundException"}}
            raise err
        self.suppressed.discard(EmailAddress)
        self.unsuppressed.append(EmailAddress)


class FakeS3:
    """Puts, gets, copies, deletes and signed links. `objects` holds what was
    put, by key; `versions` every version put, by version id, as the bucket
    is versioned. A signed link is /dev-media/<key>, which
    scripts/dev_server.py serves."""

    def __init__(self, fail=False):
        self.deleted, self.fail = [], fail
        self.objects: dict[str, dict] = {}
        self.versions: dict[str, tuple[str, dict]] = {}  # version id -> (key, object)

    def _keep(self, Key, obj):
        obj["VersionId"] = f"v{len(self.versions) + 1}"
        self.versions[obj["VersionId"]] = (Key, obj)
        self.objects[Key] = obj

    def put_object(self, Bucket, Key, Body, **kw):
        if self.fail:
            raise ConnectionError("down")
        self._keep(Key, {"Body": Body, **kw})
        return {}

    def copy_object(self, Bucket, Key, CopySource, MetadataDirective="COPY", TaggingDirective="COPY", Tagging=""):
        """Copy a version (CopySource's VersionId) or the current object."""
        if "VersionId" in CopySource:
            key, source = self.versions.get(CopySource["VersionId"], (None, None))
            if key != CopySource["Key"]:
                e = KeyError(CopySource["Key"])
                e.response = {"Error": {"Code": "NoSuchVersion"}}
                raise e
        else:
            source = self._there(CopySource["Key"])
        copy = {k: v for k, v in source.items() if k not in ("VersionId", "Tagging")}
        copy["Tagging"] = Tagging if TaggingDirective == "REPLACE" else source.get("Tagging", "")
        self._keep(Key, copy)
        return {"VersionId": copy["VersionId"]}

    def _there(self, Key):
        if Key not in self.objects:
            e = KeyError(Key)
            e.response = {"Error": {"Code": "NoSuchKey"}}
            raise e
        return self.objects[Key]

    def get_object(self, Bucket, Key, Range=None):
        from io import BytesIO

        obj = self._there(Key)
        body = bytes(obj["Body"])
        got = {"ContentType": obj.get("ContentType"), "ContentLength": len(body), "VersionId": obj.get("VersionId", "null")}
        if Range:  # bytes=<first>-<last>
            first, last = (int(x) for x in Range[len("bytes="):].split("-"))
            got.update(ContentRange=f"bytes {first}-{min(last, len(body) - 1)}/{len(body)}", ContentLength=None)
            body = body[first:last + 1]
            got["ContentLength"] = len(body)
        return {"Body": BytesIO(body), **got}

    def get_object_tagging(self, Bucket, Key):
        tagging = self._there(Key).get("Tagging") or ""
        return {"TagSet": [{"Key": k, "Value": v} for k, _, v in (t.partition("=") for t in tagging.split("&") if t)]}

    def put_object_tagging(self, Bucket, Key, Tagging):
        self._there(Key)["Tagging"] = "&".join(f"{t['Key']}={t['Value']}" for t in Tagging["TagSet"])
        return {}

    def generate_presigned_post(self, Bucket, Key, Fields, Conditions, ExpiresIn):
        """A form posted to /dev-upload/, which scripts/dev_server.py takes
        (form_upload), checking it as S3 checks the signed policy."""
        self.posts = getattr(self, "posts", {})
        self.posts[Key] = {"Fields": Fields, "Conditions": Conditions, "ExpiresIn": ExpiresIn}
        return {"url": "/dev-upload/", "fields": {"key": Key, **Fields}}

    def form_upload(self, fields: dict, body: bytes) -> bool:
        """What S3 does with a posted form: refuse one that breaks its policy,
        else keep the file with the form's type and tags."""
        signed = getattr(self, "posts", {}).get(fields.get("key"))
        if not signed or any(fields.get(k) != v for k, v in signed["Fields"].items()):
            return False
        low, high = next(c[1:] for c in signed["Conditions"] if isinstance(c, list) and c[0] == "content-length-range")
        if not low <= len(body) <= high:
            return False
        tags = re.findall(r"<Key>(.*?)</Key><Value>(.*?)</Value>", fields.get("tagging", ""))
        self._keep(fields["key"], {"Body": body, "ContentType": fields["Content-Type"],
                                   "Tagging": "&".join(f"{k}={v}" for k, v in tags)})
        return True

    def upload_file(self, Filename, Bucket, Key, ExtraArgs=None):
        with open(Filename, "rb") as f:
            self.put_object(Bucket, Key, f.read(), **(ExtraArgs or {}))

    def generate_presigned_url(self, op, Params, ExpiresIn):
        self.signed = {"op": op, "Params": Params, "ExpiresIn": ExpiresIn}
        return f"/dev-media/{Params['Key']}"

    def delete_object(self, **kw):
        if self.fail:
            raise ConnectionError("down")
        self.deleted.append(kw)
        if "VersionId" in kw:  # that version only, for good; a newer one stays
            key, _ = self.versions.pop(kw["VersionId"], (None, None))
            if key == kw["Key"] and self.objects.get(key, {}).get("VersionId") == kw["VersionId"]:
                del self.objects[key]
        else:
            self.objects.pop(kw["Key"], None)
        return {}

    def delete_objects(self, Bucket, Delete):
        if self.fail:
            return {"Errors": [{"Key": o["Key"], "Code": "InternalError"} for o in Delete["Objects"]]}
        self.deleted.extend({"Bucket": Bucket, "Key": o["Key"]} for o in Delete["Objects"])
        for o in Delete["Objects"]:
            self.objects.pop(o["Key"], None)
        return {}


class FakeLambda:
    """Async invokes, recorded; `then` runs each one (the dev server builds
    the zip export in a thread)."""

    def __init__(self, fail=False, then=None):
        self.invoked, self.fail, self.then = [], fail, then

    def invoke(self, FunctionName, InvocationType, Payload):
        import json

        if self.fail:
            raise ConnectionError("down")
        self.invoked.append({"FunctionName": FunctionName, "InvocationType": InvocationType, "Payload": json.loads(Payload)})
        if self.then:
            self.then(json.loads(Payload))
        return {"StatusCode": 202}
