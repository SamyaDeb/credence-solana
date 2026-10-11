"""Cut the waits out of the Cap shoot (docs/video/cap-shoot.json) and keep every zoom on its moment.

The shoot logs marks: `cut` ... `end-cut` (removed), `fast:N` ... `end-fast` (sped up to at most N seconds) and `beat:*`
(section starts, printed with their times on the cut). This rewrites the project's edit list (`timeline.segments`) and
re-times the zoom segments that browser_shoot wrote on the recording clock onto the edited clock. It uses the
cap-director skill's own config helpers, so the write is backed up, validated by Cap and read back.

Usage: python3 -I docs/video/cap-cut.py docs/video/raw/credence-demo.cap [--drop markets,protect] [--speed 1.1]
  --drop   beats to remove whole (from their `beat:` mark to the next one)
  --speed  play everything that is kept this much faster (1.0 = real time)
"""
import argparse
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path.home() / ".claude/skills/cap-director/scripts"))
import capx  # noqa: E402

ap = argparse.ArgumentParser()
ap.add_argument("project")
ap.add_argument("--drop", default="")
ap.add_argument("--speed", type=float, default=1.0)
args = ap.parse_args()
pp = capx.proj_path(args.project)
meta = capx.load_meta(pp)
track = json.loads(Path(str(pp).removesuffix(".cap") + ".track.json").read_text())
seg0 = capx.meta_segments(meta)[0]
vdur = capx.video_info(capx.seg_display_path(pp, seg0))["duration"]
offset = max(0.0, track["end"] - vdur)  # the same tail-anchored alignment as `capx track apply`
rec = lambda t: min(vdur, max(0.0, t - offset))  # noqa: E731

# Recording-clock ranges to drop or speed up.
ranges, open_ = [], None
for m in track["marks"]:
    n = m["name"]
    if n == "cut" or n.startswith("fast:"):
        open_ = (n, rec(m["t"]))
    elif n in ("end-cut", "end-fast") and open_:
        kind, s = open_
        ranges.append({"start": s, "end": rec(m["t"]), "cut": kind == "cut", "max": None if kind == "cut" else float(kind.split(":")[1])})
        open_ = None
# Whole beats to drop: from their mark to the next beat (or the end).
beats = [m for m in track["marks"] if m["name"].startswith("beat:") or m["name"] == "end"]
for i, m in enumerate(beats[:-1]):
    if m["name"][5:] in [d for d in args.drop.split(",") if d]:
        ranges.append({"start": rec(m["t"]), "end": rec(beats[i + 1]["t"]), "cut": True, "max": None})
ranges.sort(key=lambda r: r["start"])

segments, t = [], 0.0
for r in ranges:
    if r["start"] > t + 0.05:
        segments.append({"recordingSegment": 0, "timescale": args.speed, "start": round(t, 4), "end": round(r["start"], 4), "name": None})
    if not r["cut"]:
        length = r["end"] - r["start"]
        scale = max(args.speed, length / r["max"]) if r["max"] else args.speed
        segments.append({"recordingSegment": 0, "timescale": round(scale, 4), "start": round(r["start"], 4), "end": round(r["end"], 4), "name": None})
    t = r["end"]
if vdur > t + 0.05:
    segments.append({"recordingSegment": 0, "timescale": args.speed, "start": round(t, 4), "end": round(vdur, 4), "name": None})

cfg = capx.get_cfg(pp)
tl = capx.ensure_timeline(cfg, pp, meta)
# The zooms browser_shoot wrote on the recording clock. The first cut saves them beside the project, so a later re-cut
# (other --drop / --speed) starts from them rather than from zooms already moved onto an edited clock.
saved = pp / ".capx" / "recording-zooms.json"
if saved.exists():
    old_zooms = json.loads(saved.read_text())
else:
    old_zooms = list(tl.get("zoomSegments", []))
    saved.parent.mkdir(parents=True, exist_ok=True)
    saved.write_text(json.dumps(old_zooms))
tl["segments"] = segments


def to_tl(x, prefer_next):
    """Recording seconds -> edited seconds; a time inside a cut snaps to the cut's edge."""
    v = capx.source_to_timeline(tl, x)
    if v is not None:
        return v
    edges = [s["start"] for s in segments] if prefer_next else [s["end"] for s in segments]
    near = min(edges, key=lambda e: abs(e - x))
    return capx.source_to_timeline(tl, near)


zooms = []
for z in old_zooms:
    s, e = to_tl(z["start"], True), to_tl(z["end"], False)
    if s is not None and e is not None and e - s > 0.4:
        zooms.append({**z, "start": round(s, 4), "end": round(e, 4)})
dur = capx.timeline_duration(tl)
tl["zoomSegments"] = capx.normalize_zooms(zooms, dur)
capx.save_cfg(pp, cfg, note="cut")

fmt = lambda x: f"{int(x // 60)}:{int(x % 60):02d}"  # noqa: E731
print(json.dumps({"recording": round(vdur, 1), "cut": round(dur, 1), "segments": len(segments), "zooms": f"{len(old_zooms)} -> {len(tl['zoomSegments'])}"}))
for m in track["marks"]:
    if m["name"].startswith("beat:"):
        v = capx.source_to_timeline(tl, rec(m["t"]))
        print(f"{fmt(v) if v is not None else '--'}  {m['name'][5:]}")
print(f"{fmt(dur)}  end")
