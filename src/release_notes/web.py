"""The web app's API at notes.yourversionnumber.com/api/*.

CloudFront sends /api/* to an HTTP API, which proxies every request here
(payload format 2.0). The static pages come from the web bucket, never from
this function.

So far there is one route, a health check. Sign-in, notes, pause, settings
and export arrive in later pull requests (docs/WEB-APP.md).
"""

import json


def log(**fields):
    # Ids and outcomes only. Addresses and note text never go to logs.
    print(json.dumps(fields, separators=(",", ":")))


def respond(status: int, body: dict) -> dict:
    return {
        "statusCode": status,
        "headers": {"content-type": "application/json", "cache-control": "no-store"},
        "body": json.dumps(body, separators=(",", ":")),
    }


def health(event) -> dict:
    return respond(200, {"ok": True})


ROUTES = {
    ("GET", "/api/health"): health,
}


def handler(event, context):
    method = event.get("requestContext", {}).get("http", {}).get("method", "")
    path = event.get("rawPath", "")
    route = ROUTES.get((method, path))
    response = route(event) if route else respond(404, {"error": "not-found"})
    log(event="web", method=method, path=path if route else "unmatched", status=response["statusCode"])
    return response
