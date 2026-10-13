"""Private text capture for owner-approved MCP connections.

Invoked only by the MCP Lambda, never routed from API Gateway. The writer
checks the bearer afresh and proves the current family and profile in the
same transaction as the note, 24-hour idempotency receipt, quota and audit.
Only create and append exist. An append requires the same connection's
assistant-authored note and conditionally updates text fields, preserving
anything its owner added. No delete, replacement, files, email or model call.
Client names are self-reported labels, not authenticated product identities.
Hashtags live in text; titles use the same guarded fetch as every writer.
"""
import json
import time
import uuid

from . import auth, links, oauth, tags
from .mcp import Reader, ToolError, TOOLS, WRITE_TOOLS, failure, validate
from .notes import MAX_NOTE
from .version import compute_version
from datetime import date
from .web import App, iso

FIELDS = ("pk", "sk", "text", "source", "author", "client", "client_id", "connection",
          "on_behalf_of", "written_at", "tz", "version", "tags", "links", "updated_at", "revision")


def write(app, family, name, args, fetch=None):
    if "notes:write" not in family["scope"].split():
        raise ToolError("scope_required", "Reconnect and explicitly approve adding agent notes.")
    uid, fid = family["user_id"], family["id"]
    key = "CAPTURE#" + fid + "#" + auth.digest(args["idempotency_key"])
    fingerprint = auth.digest(json.dumps({"tool": name, "arguments": args}, sort_keys=True, separators=(",", ":")))
    reader = Reader(app, family)
    titles = {}
    fetch_title = fetch or links.fetch_title
    def title_once(url):
        if url not in titles:
            if len(titles) >= links.MAX_FETCHES:
                return None
            try:
                titles[url] = fetch_title(url)
            except Exception:
                titles[url] = None
        return titles[url]
    for _ in range(5):
        receipt = app.store.mcp_get("USER#" + uid, key)
        if receipt and oauth.live(receipt, app.now):
            if receipt["request_hash"] != fingerprint:
                raise ToolError("duplicate_idempotency_key", "Use a new key for a different operation; reuse the original key only for an exact retry.")
            return {"note": json.loads(receipt["result"]), "replayed": True}
        day = reader.day(args.get("date", reader.today))
        text = args["text"].replace("\r\n", "\n").strip()
        if not text:
            raise ToolError("invalid_arguments", "Write some note text.")
        old = None
        if name == "notes_append":
            old = dict(reader.note(args))
            if old.get("author") != "assistant" or old.get("connection") != fid or old.get("client_id") != family["client_id"]:
                raise ToolError("forbidden_not_author", "Append only to a note created by this same connection; create a new note for anything else.")
            text = (old.get("text") or "") + "\n\n" + text
        if len(text) > MAX_NOTE:
            raise ToolError("too_long", "A note can have at most 20,000 characters; create another note.")
        note = ({k: old[k] for k in FIELDS if k in old} if old else {
            "pk": "USER#" + uid, "sk": "NOTE#" + day + "#a-" + uuid.uuid4().hex,
            "source": "agent", "author": "assistant", "client": family["client_name"],
            "client_id": family["client_id"], "connection": fid, "on_behalf_of": uid,
            "written_at": iso(app.now), "tz": reader.profile["tz"],
            "version": str(compute_version(date.fromisoformat(reader.birthday), date.fromisoformat(day)))})
        note.update(text=text, tags=tags.found(text), links=links.collect(text, keep=(old or {}).get("links"), fetch=title_once),
                    revision=int((old or {}).get("revision", 0)) + 1)
        if old:
            note["updated_at"] = iso(app.now)
        rate_key = "WRITERATE#" + name + "#" + str(app.now // 86400)
        previous = app.store.mcp_get("MCPMETA#" + uid, rate_key)
        count, cap = int((previous or {}).get("n", 0)), 20 if name == "notes_create" else 50
        if count >= cap:
            raise ToolError("rate_limited", "Try again after this UTC day ends; exact retries of completed writes are still safe.")
        rate = {"pk": "MCPMETA#" + uid, "sk": rate_key, "n": count + 1,
                "revision": int((previous or {}).get("revision", 0)) + 1, "expires_at": (app.now // 86400 + 2) * 86400}
        receipt = {"pk": "USER#" + uid, "sk": key, "request_hash": fingerprint,
                   "result": json.dumps(note, ensure_ascii=False, separators=(",", ":")), "expires_at": app.now + 86400}
        audit = {"pk": "MCPMETA#" + uid, "sk": "LOG#" + f"{app.now:012d}#" + uuid.uuid4().hex,
                 "at": app.now, "tool": name, "outcome": "ok", "connection": fid,
                 "client": family["client_name"], "date": day, "note_id": note["sk"].split("#", 2)[2],
                 "request_hash": fingerprint, "expires_at": app.now + 14 * 86400}
        if app.store.capture_commit(note, old, receipt, audit, rate, previous, family, app.now):
            return {"note": note, "replayed": False}
        # A conflict can also mean disconnection, scope removal or deletion.
        current = app.store.mcp_get("OAUTHFAMILY#" + fid)
        profile = app.store.mcp_profile(uid)
        if (not oauth.live(current, app.now) or not profile or profile.get("mcp_deleting") or
                current.get("revision") != family["revision"] or "notes:write" not in current["scope"].split()):
            raise ToolError("scope_required", "This connection changed or was disconnected; reconnect before writing.")
    raise ToolError("busy", "Try again shortly with exactly the same idempotency_key and arguments.")


def handler(event, context, *, store=None, clock=time.time, fetch=None):
    app = App(store, None, int(clock()))
    uid = "unknown"
    try:
        token, name, args = event.get("token", ""), event.get("tool"), event.get("arguments", {})
        if not isinstance(token, str) or len(token) > 256:
            raise ToolError("scope_required", "Reconnect before writing.")
        family = oauth.bearer(app, token)
        if not family:
            raise ToolError("scope_required", "Reconnect before writing.")
        uid = family["user_id"]
        if name not in WRITE_TOOLS:
            raise ToolError("unknown_tool", "Only create and append are supported.")
        validate(args, next(t["inputSchema"] for t in TOOLS if t["name"] == name))
        return write(app, family, name, args, fetch)
    except ToolError as e:
        return {"error": e.code, "next_step": e.next_step}
    except Exception as e:
        failure(app, uid, type(e).__name__)
        return {"error": "temporarily_unavailable", "next_step": "Try again shortly with exactly the same idempotency_key and arguments."}
