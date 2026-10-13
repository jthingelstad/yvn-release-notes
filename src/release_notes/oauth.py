"""Read-only external connections, approved by the owner's web session.

Public OAuth routes are separate from the cookie API: exact registered
redirects, PKCE S256, resource-bound tokens, rotating refresh tokens and
fresh family checks. Only SHA-256 token hashes are stored. OAuth rows
have revisions for atomic single-use exchanges; OAUTHUSER indexes every
credential for account deletion. MCPMETA holds content-free activity and
quotas. Deletion blocks new transactions before removing these rows.
No OAuth bearer token ever authenticates a web write.
"""
import base64
import hashlib
import json
import re
import secrets
from urllib.parse import urlencode, urlsplit, parse_qsl

from . import auth

SCOPES = {"notes:read", "media:read"}
ACCESS_SECONDS, REFRESH_SECONDS = 3600, 30 * 86400


def opaque():
    return secrets.token_urlsafe(32)


def row(pk, **fields):
    return {"pk": pk, "sk": "STATE", **fields}


def live(item, now):
    return bool(item and int(item.get("expires_at", now + 1)) > now and not item.get("revoked"))


def resource(app):
    return app.origin + "/mcp"


def fail(error="invalid_request", status=400):
    from .web import Reject
    raise Reject(status, error)


def valid_redirect(uri):
    if not isinstance(uri, str) or len(uri) > 2048 or any(ord(c) < 33 for c in uri) or "#" in uri or "\\" in uri:
        return False
    try:
        u = urlsplit(uri)
        _ = u.port  # malformed/out-of-range ports are invalid redirects
        return bool(u.hostname and not u.username and not u.password and not u.fragment and
                    (u.scheme == "https" or (u.scheme == "http" and u.hostname in ("localhost", "127.0.0.1", "::1"))))
    except ValueError:
        return False


def limited(app, req, kind, ceiling):
    # Count only; never the request or registration metadata.
    key = "oauth:" + kind + ":" + auth.digest(auth.network(req.viewer()))
    if app.store.count(key, app.now // 3600, 3600) > ceiling:
        fail("rate_limited", 429)


def tracked(item, uid):
    return row(f"OAUTHUSER#{uid}", **{"sk": "ROW#" + item["pk"], "target": item["pk"],
                                    "expires_at": item["expires_at"]})


def issue_rows(app, family):
    access, refresh = opaque(), opaque()
    common = {"user_id": family["user_id"], "family": family["id"], "scope": family["scope"],
              "resource": family["resource"], "version": family["version"], "client_id": family["client_id"]}
    a = row("OAUTHACCESS#" + auth.digest(access), **common, expires_at=app.now + ACCESS_SECONDS)
    r = row("OAUTHREFRESH#" + auth.digest(refresh), **common, expires_at=app.now + REFRESH_SECONDS)
    changes = [(i, None) for item in (a, r) for i in (item, tracked(item, family["user_id"]))]
    return {"access_token": access, "token_type": "Bearer", "expires_in": ACCESS_SECONDS,
            "refresh_token": refresh, "scope": family["scope"]}, changes


def family_for(app, item):
    family = app.store.mcp_get("OAUTHFAMILY#" + item.get("family", ""))
    profile = app.store.mcp_profile(item.get("user_id", ""))
    if not live(family, app.now) or not profile or profile.get("mcp_deleting"):
        return None
    if family.get("user_id") != item.get("user_id") or family.get("resource") != resource(app):
        return None
    return family


def bearer(app, token):
    item = app.store.mcp_get("OAUTHACCESS#" + auth.digest(token))
    if not live(item, app.now) or item.get("resource") != resource(app):
        return None
    family = family_for(app, item)
    # Refresh rotation also invalidates the old access token.
    return family if family and family["version"] == item["version"] else None


def revoke(app, fid, uid):
    for _ in range(5):
        item = app.store.mcp_get("OAUTHFAMILY#" + fid)
        if not item or item.get("user_id") != uid:
            return
        if item.get("revoked"):
            return
        if app.store.mcp_commit([({**item, "revoked": True}, item["revision"])], uid):
            return
    fail("temporarily_unavailable", 503)


def public(app, req):
    """No session cookies here. Browser approval is /api/mcp/authorize."""
    from .web import respond
    if req.method == "GET" and req.path in ("/.well-known/oauth-protected-resource", "/.well-known/oauth-protected-resource/mcp"):
        return respond(200, {"resource": resource(app), "authorization_servers": [app.origin],
                             "scopes_supported": sorted(SCOPES), "bearer_methods_supported": ["header"]})
    if req.method == "GET" and req.path == "/.well-known/oauth-authorization-server":
        return respond(200, {"issuer": app.origin, "authorization_endpoint": app.origin + "/oauth/authorize",
            "token_endpoint": app.origin + "/oauth/token", "registration_endpoint": app.origin + "/oauth/register",
            "revocation_endpoint": app.origin + "/oauth/revoke", "scopes_supported": sorted(SCOPES),
            "response_types_supported": ["code"], "grant_types_supported": ["authorization_code", "refresh_token"],
            "code_challenge_methods_supported": ["S256"], "token_endpoint_auth_methods_supported": ["none"]})
    if req.method == "POST" and req.path == "/oauth/register":
        limited(app, req, "register", 20)
        if app.store.count("oauth:register:total", app.now // 3600, 3600) > 200:
            fail("rate_limited", 429)
        b = req.json()
        uris = b.get("redirect_uris")
        if not isinstance(uris, list) or not 1 <= len(uris) <= 5 or not all(valid_redirect(u) for u in uris):
            fail("invalid_redirect_uri")
        grants = b.get("grant_types", ["authorization_code", "refresh_token"])
        responses = b.get("response_types", ["code"])
        if (b.get("token_endpoint_auth_method", "none") != "none" or not isinstance(grants, list) or
                not grants or not all(isinstance(g, str) and g in ("authorization_code", "refresh_token") for g in grants) or
                "authorization_code" not in grants or responses != ["code"]):
            fail("invalid_client_metadata")
        name = b.get("client_name", "Agent")
        if not isinstance(name, str) or len(name) > 100 or any(ord(c) < 32 for c in name):
            fail("invalid_client_metadata")
        cid = opaque()
        client = row("OAUTHCLIENT#" + cid, client_id=cid, client_name=name, redirect_uris=uris,
                     expires_at=app.now + 365 * 86400)
        if not app.store.mcp_commit([(client, None)]):
            fail("temporarily_unavailable", 503)
        return respond(201, {"client_id": cid, "client_name": name, "redirect_uris": uris,
            "token_endpoint_auth_method": "none", "grant_types": ["authorization_code", "refresh_token"],
            "response_types": ["code"]})
    if req.method == "GET" and req.path == "/oauth/authorize":
        limited(app, req, "authorize", 60)
        b = req.query
        cid, redirect = b.get("client_id", ""), b.get("redirect_uri", "")
        if not re.fullmatch(r"[A-Za-z0-9_-]{43}", cid):
            fail("invalid_client")
        client = app.store.mcp_get("OAUTHCLIENT#" + cid)
        if not live(client, app.now) or redirect not in client["redirect_uris"]:
            fail("invalid_client")  # Never redirect an invalid request.
        scopes = set(b.get("scope", "notes:read media:read").split())
        challenge, state = b.get("code_challenge", ""), b.get("state", "")
        if (b.get("response_type") != "code" or b.get("resource") != resource(app) or
                b.get("code_challenge_method") != "S256" or not re.fullmatch(r"[A-Za-z0-9_-]{43}", challenge) or
                not scopes <= SCOPES or "notes:read" not in scopes or len(state) > 1024):
            fail()
        pending = opaque()
        item = row("OAUTHPENDING#" + pending, client_id=cid, client_name=client["client_name"], redirect_uri=redirect,
            scope=" ".join(sorted(scopes)), challenge=challenge, state=state, resource=resource(app), expires_at=app.now + 600)
        if not app.store.mcp_commit([(item, None)]):
            fail("temporarily_unavailable", 503)
        return respond(303, "", headers={"location": app.origin + "/connect/#request=" + pending})
    if req.method == "POST" and req.path in ("/oauth/token", "/oauth/revoke"):
        limited(app, req, "token", 120)
        raw = base64.b64decode(req._body) if req._b64 else req._body.encode()
        if len(raw) > 8192 or req.headers.get("content-type", "").split(";")[0] != "application/x-www-form-urlencoded":
            fail()
        pairs = parse_qsl(raw.decode("utf-8"), keep_blank_values=True)
        if len(dict(pairs)) != len(pairs):
            fail()
        b = dict(pairs)
        if req.path == "/oauth/revoke":
            for prefix in ("OAUTHACCESS#", "OAUTHREFRESH#"):
                item = app.store.mcp_get(prefix + auth.digest(b.get("token", "")))
                if item and item.get("client_id") == b.get("client_id"):
                    revoke(app, item["family"], item["user_id"])
            return respond(200, {})
        return respond(200, exchange(app, b))
    fail("not_found", 404)


def exchange(app, b):
    if b.get("resource") != resource(app):
        fail("invalid_target")
    kind = b.get("grant_type")
    prefix = "OAUTHCODE#" if kind == "authorization_code" else "OAUTHREFRESH#" if kind == "refresh_token" else ""
    if not prefix:
        fail("unsupported_grant_type")
    secret = b.get("code" if kind == "authorization_code" else "refresh_token", "")
    item = app.store.mcp_get(prefix + auth.digest(secret))
    if not item or item.get("client_id") != b.get("client_id"):
        fail("invalid_grant")
    if item.get("used"):
        if kind == "refresh_token":
            revoke(app, item["family"], item["user_id"])
        fail("invalid_grant")
    family = family_for(app, item)
    if not live(item, app.now) or not family:
        fail("invalid_grant")
    if kind == "authorization_code":
        verifier = b.get("code_verifier", "")
        challenge = base64.urlsafe_b64encode(hashlib.sha256(verifier.encode()).digest()).decode().rstrip("=")
        if (not re.fullmatch(r"[A-Za-z0-9._~-]{43,128}", verifier) or not auth.same(challenge, item["challenge"]) or
                b.get("redirect_uri") != item["redirect_uri"]):
            fail("invalid_grant")
    elif item["version"] != family["version"]:
        revoke(app, item["family"], item["user_id"])
        fail("invalid_grant")
    if b.get("scope") and b["scope"] != family["scope"]:
        fail("invalid_scope")
    updated = {**family, "version": int(family["version"]) + 1, "expires_at": app.now + REFRESH_SECONDS}
    answer, changes = issue_rows(app, updated)
    index = tracked(updated, item["user_id"])
    previous = app.store.mcp_get(index["pk"], index["sk"])
    changes += [({**item, "used": True}, item["revision"]), (updated, family["revision"]),
                (index, previous["revision"] if previous else None)]
    if not app.store.mcp_commit(changes, item["user_id"]):
        # A simultaneous refresh is replay too; do not leave a second winner.
        if kind == "refresh_token":
            revoke(app, item["family"], item["user_id"])
        fail("invalid_grant")
    return answer


def authorize(app, req):
    from .web import respond
    uid, _ = app.account(req)
    b = req.json()
    pending = b.get("request", "")
    item = app.store.mcp_get("OAUTHPENDING#" + pending) if isinstance(pending, str) and re.fullmatch(r"[A-Za-z0-9_-]{43}", pending) else None
    if not live(item, app.now) or item.get("used"):
        fail("request_expired")
    if req.method == "POST":
        if "approve" not in b:
            return respond(200, {"client_name": item["client_name"], "scope": item["scope"]})
        if type(b["approve"]) is not bool or type(b.get("media", False)) is not bool:
            fail()
        scope = "notes:read" + (" media:read" if b.get("media") and "media:read" in item["scope"].split() else "")
        code, fid = opaque(), opaque()
        family = row("OAUTHFAMILY#" + fid, id=fid, user_id=uid, client_id=item["client_id"],
            client_name=item["client_name"], scope=scope, resource=item["resource"], version=0,
            created_at=app.now, expires_at=app.now + REFRESH_SECONDS)
        code_row = row("OAUTHCODE#" + auth.digest(code), user_id=uid, family=fid, client_id=item["client_id"],
            redirect_uri=item["redirect_uri"], challenge=item["challenge"], expires_at=app.now + 300)
        changes = [({**item, "used": True}, item["revision"])]
        if b["approve"]:
            changes += [(i, None) for i in (family, tracked(family, uid), code_row, tracked(code_row, uid))]
        if not app.store.mcp_commit(changes, uid):
            fail("request_expired")
        params = {"code": code} if b["approve"] else {"error": "access_denied"}
        if item["state"]:
            params["state"] = item["state"]
        redirect = item["redirect_uri"] + ("&" if "?" in item["redirect_uri"] else "?") + urlencode(params)
        return respond(200, {"redirect": redirect})
    fail()


def connections(app, req, fid=None):
    from .web import respond
    uid, _ = app.account(req)
    if req.method == "DELETE":
        revoke(app, fid, uid)
        return respond(200, {"ok": True})
    refs = app.store.mcp_rows(f"OAUTHUSER#{uid}")
    families = [app.store.mcp_get(i["target"]) for i in refs if i["target"].startswith("OAUTHFAMILY#")]
    usage = {i["sk"].removeprefix("USE#"): i for i in app.store.mcp_rows(f"MCPMETA#{uid}") if i["sk"].startswith("USE#")}
    return respond(200, {"connections": [{"id": f["id"], "client_name": f["client_name"], "scope": f["scope"],
        "created_at": int(f["created_at"]), "last_used": int(usage[f["id"]]["at"]) if f["id"] in usage else None} for f in families if live(f, app.now)]})


def activity(app, req):
    from .web import respond
    uid, _ = app.account(req)
    rows = app.store.mcp_rows(f"MCPMETA#{uid}")
    return respond(200, {"activity": [{"at": int(i["at"]), **{k: i[k] for k in ("tool", "outcome", "connection")}}
        for i in sorted(rows, key=lambda i: i["sk"], reverse=True) if i["sk"].startswith("LOG#") and live(i, app.now)][:50]})


def delete_user(app, uid):
    app.store.mcp_block(uid)
    refs = app.store.mcp_rows(f"OAUTHUSER#{uid}")
    keys = [{"pk": i["target"], "sk": "STATE"} for i in refs]
    keys += [{"pk": i["pk"], "sk": i["sk"]} for i in refs + app.store.mcp_rows(f"MCPMETA#{uid}")]
    app.store.delete_keys(keys)
