---
title: API recipes
description: Copy and go: a terminal, an Apple Shortcut, a note for each commit, a schedule, Python, a GitHub Actions step and Home Assistant.
---

## From the terminal

A shell function, in your `.zshrc` or `.bashrc`:

```sh
rn() {
  curl --fail-with-body -sS https://notes.yourversionnumber.com/v1/notes \
    -H "Authorization: Bearer $RN_TOKEN" \
    -H "Content-Type: text/plain" \
    -H "Accept: text/plain" \
    --data-binary "$*"
}
```

Then `rn "Fixed the gate latch #house"`. Quote a note with a hashtag in it, since some shells take a `#` as the start of a comment.

## An Apple Shortcut

Build it once in the Shortcuts app:

1. Add **Ask for Input**, with the prompt "What happened?".
2. Add **Get Contents of URL**, with `https://notes.yourversionnumber.com/v1/notes`. Under it, set the method to **POST**; add the headers `Authorization`, with `Bearer` and your token, and `Accept`, with `text/plain`; and set the request body to **JSON** (or **Form**), with one text field named `text` set to **Provided Input**.
3. Add **Show Notification**, with **Contents of URL**, to see the version it was filed in.

On an iPhone with an Action Button, choose the shortcut under Settings, then **Action Button**, for a note at one press. The token lives inside the shortcut, so never share the shortcut itself.

## A note for each commit

A git `post-commit` hook, saved as `.git/hooks/post-commit` and made executable with `chmod +x`:

```sh
#!/bin/sh
# One note for each commit, sent in the background.
repo=$(basename "$(git rev-parse --show-toplevel)")
curl -fsS https://notes.yourversionnumber.com/v1/notes \
  -H "Authorization: Bearer $RN_TOKEN" \
  -H "Content-Type: text/plain" \
  -H "Idempotency-Key: $(git rev-parse HEAD)" \
  --data-binary "Committed to $repo: $(git log -1 --pretty=%s) #code" >/dev/null 2>&1 &
```

The commit's own id is the key, so a commit is never noted twice.

## On a schedule

A job run by cron or launchd doesn't see your shell's variables, so keep the token in a file only you can read (`chmod 600`) and read it there. A script that notes a backup when it finishes:

```sh
#!/bin/sh
RN_TOKEN=$(cat "$HOME/.config/release-notes/token")
if restic backup "$HOME/Documents"; then
  curl -fsS https://notes.yourversionnumber.com/v1/notes \
    -H "Authorization: Bearer $RN_TOKEN" \
    -H "Content-Type: text/plain" \
    --data-binary "The nightly backup ran #backup" >/dev/null
fi
```

In a crontab, `30 23 * * * $HOME/bin/backup-and-note.sh` runs it every night at half past eleven. On a Mac, a launchd agent with a `StartCalendarInterval` runs it the same way.

## Python

With nothing to install:

```python
import json, os, urllib.request, uuid

def note(text, key=None, **fields):
    """Add a note. Pass the same key again to retry without a second note."""
    request = urllib.request.Request(
        "https://notes.yourversionnumber.com/v1/notes",
        data=json.dumps({"text": text, **fields}).encode(),
        headers={
            "Authorization": "Bearer " + os.environ["RN_TOKEN"],
            "Content-Type": "application/json",
            "Idempotency-Key": key or str(uuid.uuid4()),
            "User-Agent": "my-script/1.0",
        },
    )
    with urllib.request.urlopen(request, timeout=30) as answer:
        return json.load(answer)["note"]

print(note("Finished the first draft #writing")["version"])
```

## A GitHub Actions step

Keep the token as a repository secret named `RN_TOKEN`, then add a step:

```yaml
- name: Note the release
  env:
    RN_TOKEN: ${{ secrets.RN_TOKEN }}
  run: |
    curl -fsS https://notes.yourversionnumber.com/v1/notes \
      -H "Authorization: Bearer $RN_TOKEN" \
      -H "Content-Type: text/plain" \
      -H "Idempotency-Key: $GITHUB_RUN_ID" \
      --data-binary "Shipped $GITHUB_REPOSITORY #shipped"
```

The run's id is the key, so running the job again doesn't add the note twice.

## Home Assistant

A REST command in `configuration.yaml`, with the token in `secrets.yaml` as `release_notes_auth: "Bearer rn_..."`:

```yaml
rest_command:
  release_note:
    url: https://notes.yourversionnumber.com/v1/notes
    method: post
    headers:
      Authorization: !secret release_notes_auth
      Accept: text/plain
    content_type: application/json
    payload: '{"text": {{ text | to_json }}}'
```

Then any automation can add a note:

```yaml
action: rest_command.release_note
data:
  text: 'The garage door was left open for an hour #house'
```
