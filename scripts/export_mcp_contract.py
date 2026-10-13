#!/usr/bin/env python3
"""Regenerate the MCP tool contract; no network or AWS calls."""
import json
from pathlib import Path
from release_notes.mcp import PROTOCOLS, TOOLS, VERSION


def contract():
    return {"server_version": VERSION, "protocol_versions": list(PROTOCOLS), "tools": TOOLS}


if __name__ == "__main__":
    (Path(__file__).resolve().parent.parent / "contracts" / "mcp-surface.json").write_text(
        json.dumps(contract(), indent=2) + "\n")
