#!/usr/bin/env python3
"""Prices every Claude Code session saved on this machine.

Reads the transcripts under ~/.claude/projects (each session's
<id>.jsonl and its subagents' files), prices each model reply once at list
prices and prints one JSON object: the sessions, newest first, and the totals.

A reply is counted once even when it sits in several files: a fork or a
resumed session starts with a copy of its parent's lines, which keep the
parent's sessionId, so a copied reply stays the parent's and a fork costs
only what it spent after it split. A copy whose parent is gone counts for the
oldest file that has it.

Transcripts only grow, so each file is read from where the last scan stopped;
what it found is kept in the cache file given as the second argument.

    scan.py <projects dir> <cache file> <prices json> [<since ms>]
"""

import json
import os
import sys
import time
from datetime import datetime

CACHE_VERSION = 2


def ms_of(stamp):
    if not stamp:
        return 0
    try:
        return int(datetime.fromisoformat(stamp.replace("Z", "+00:00")).timestamp() * 1000)
    except ValueError:
        return 0


def month_of(ms):
    if not ms:
        return "unknown"
    return datetime.fromtimestamp(ms / 1000).strftime("%Y-%m")


def price(prices, model, usage):
    model = (model or "").lower()
    row = next((r for r in prices if r[0] in model), None)
    if row is None:
        return 0.0, False
    _, inp, out, cache_read = row
    usd = (
        (usage.get("input_tokens") or 0) * inp
        + (usage.get("output_tokens") or 0) * out
        + (usage.get("cache_read_input_tokens") or 0) * cache_read
        + (usage.get("cache_creation_input_tokens") or 0) * inp * 1.25
    ) / 1_000_000
    return usd, True


def blank(sid):
    return {
        "sid": sid,
        "size": 0,
        "mtime": 0,
        "offset": 0,
        "title": "",
        "aiTitle": "",
        "cwd": "",
        "first": 0,
        "last": 0,
        "others": {},
        "msgs": {},
    }


def read_file(path, entry, prices):
    """Reads the file from entry['offset'] on, updating entry in place."""
    with open(path, "rb") as f:
        f.seek(entry["offset"])
        data = f.read()
    end = data.rfind(b"\n")
    if end < 0:
        return
    entry["offset"] += end + 1
    for raw in data[: end + 1].split(b"\n"):
        if not raw:
            continue
        is_reply = b'"type":"assistant"' in raw
        is_title = b'"custom-title"' in raw or b'"ai-title"' in raw
        if not is_reply and not is_title and entry["cwd"] and entry["first"]:
            continue
        try:
            d = json.loads(raw)
        except ValueError:
            continue
        kind = d.get("type")
        if kind == "custom-title" and d.get("customTitle"):
            entry["title"] = d["customTitle"]
        elif kind == "ai-title" and d.get("aiTitle"):
            entry["aiTitle"] = d["aiTitle"]
        if not entry["cwd"] and d.get("cwd"):
            entry["cwd"] = d["cwd"]
        ts = ms_of(d.get("timestamp"))
        if ts and not entry["first"] and kind in ("user", "assistant"):
            entry["first"] = ts
        if kind != "assistant":
            continue
        message = d.get("message") or {}
        mid = message.get("id") or d.get("requestId")
        usage = message.get("usage")
        if not mid or not usage or mid in entry["msgs"]:
            continue
        owner = d.get("sessionId") or entry["sid"]
        if owner != entry["sid"]:
            entry["others"][owner] = entry["others"].get(owner, 0) + 1
        usd, priced = price(prices, message.get("model"), usage)
        entry["msgs"][mid] = [owner, ts, round(usd, 6), 1 if priced else 0, message.get("model") or ""]
        if ts:
            entry["last"] = max(entry["last"], ts)


def main():
    root = os.path.expanduser(sys.argv[1])
    cache_path = os.path.expanduser(sys.argv[2])
    prices_json = sys.argv[3]
    since = int(sys.argv[4]) if len(sys.argv) > 4 and sys.argv[4] else 0
    prices = json.loads(prices_json)
    started = time.time()

    cache = {"version": CACHE_VERSION, "files": {}}
    try:
        with open(cache_path) as f:
            loaded = json.load(f)
        if loaded.get("version") == CACHE_VERSION:
            cache = loaded
    except (OSError, ValueError):
        pass

    # <project>/<sid>.jsonl, and <project>/<sid>/subagents/*.jsonl for its subagents.
    found = {}
    for project in os.listdir(root) if os.path.isdir(root) else []:
        pdir = os.path.join(root, project)
        if not os.path.isdir(pdir):
            continue
        for name in os.listdir(pdir):
            path = os.path.join(pdir, name)
            if name.endswith(".jsonl"):
                found[path] = name[:-6]
            elif os.path.isdir(path):
                sub = os.path.join(path, "subagents")
                if os.path.isdir(sub):
                    for agent in os.listdir(sub):
                        if agent.endswith(".jsonl"):
                            found[os.path.join(sub, agent)] = name

    files = {}
    read_bytes = 0
    for path, sid in found.items():
        try:
            st = os.stat(path)
        except OSError:
            continue
        entry = cache["files"].get(path)
        if entry is None or st.st_size < entry["size"] or entry["sid"] != sid:
            entry = blank(sid)
        if st.st_size != entry["size"] or int(st.st_mtime * 1000) != entry["mtime"]:
            read_bytes += st.st_size - entry["offset"]
            try:
                read_file(path, entry, prices)
            except OSError:
                continue
            entry["size"] = st.st_size
            entry["mtime"] = int(st.st_mtime * 1000)
        files[path] = entry

    cache["files"] = files
    tmp = cache_path + ".tmp"
    os.makedirs(os.path.dirname(cache_path), exist_ok=True)
    with open(tmp, "w") as f:
        json.dump(cache, f, separators=(",", ":"))
    os.replace(tmp, cache_path)

    # Sessions are the main files; a subagent's file adds to its session.
    mains = {e["sid"]: (p, e) for p, e in files.items() if not os.path.dirname(p).endswith("subagents")}
    sessions = {}
    for sid, (path, e) in mains.items():
        sessions[sid] = {
            "id": sid,
            "title": e["title"] or e["aiTitle"],
            "cwd": e["cwd"],
            "first": e["first"],
            "last": e["last"],
            "mtime": e["mtime"],
            "usd": 0.0,
            "sinceUsd": 0.0,
            "replies": 0,
            "unpriced": 0,
            "models": {},
            "months": {},
            "forkOf": None,
        }
        if e["others"]:
            parent = max(e["others"].items(), key=lambda kv: kv[1])[0]
            sessions[sid]["forkOf"] = parent

    # Each reply once: its own sessionId when that session is on disk, else the
    # oldest file holding it.
    order = sorted(files.values(), key=lambda e: (e["first"] or 1 << 60))
    owners = {}
    for e in order:
        for mid, (owner, ts, usd, priced, model) in e["msgs"].items():
            if mid in owners:
                continue
            who = owner if owner in sessions else e["sid"]
            if who not in sessions:
                continue
            owners[mid] = who
            s = sessions[who]
            s["usd"] += usd
            if ts >= since:
                s["sinceUsd"] += usd
            s["replies"] += 1
            # Months in local time, as the person reads their calendar.
            month = month_of(ts or e["first"])
            s["months"][month] = s["months"].get(month, 0.0) + usd
            if not priced:
                s["unpriced"] += 1
            if model:
                s["models"][model] = s["models"].get(model, 0) + 1

    out = sorted(sessions.values(), key=lambda s: max(s["last"], s["mtime"]), reverse=True)
    for s in out:
        s["usd"] = round(s["usd"], 4)
        s["sinceUsd"] = round(s["sinceUsd"], 4)
        s["model"] = max(s["models"].items(), key=lambda kv: kv[1])[0] if s["models"] else ""
        del s["models"]
        s["months"] = {m: round(v, 4) for m, v in s["months"].items() if v > 0}
    months = {}
    for s in out:
        for m, v in s["months"].items():
            months[m] = months.get(m, 0.0) + v
    print(
        json.dumps(
            {
                "sessions": out,
                "totalUsd": round(sum(s["usd"] for s in out), 4),
                "sinceUsd": round(sum(s["sinceUsd"] for s in out), 4),
                "since": since,
                "months": {m: round(v, 4) for m, v in sorted(months.items(), reverse=True)},
                "files": len(files),
                "readBytes": read_bytes,
                "ms": int((time.time() - started) * 1000),
            },
            separators=(",", ":"),
        )
    )


if __name__ == "__main__":
    main()
