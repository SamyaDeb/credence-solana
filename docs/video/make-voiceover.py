"""Speak the demo video's voice-over (docs/video/voiceover.json) and put it on the video.

Each line is spoken with macOS `say`, sped up (at most 1.15x, pitch kept) when it would overrun its slot, placed at its
start time and mixed into one track loudness-normalised for speech (-16 LUFS). If the last line runs past the end of
the video, the last frame is held so nothing is cut off (the video must stay at or under 3:00).

Usage: python3 -I docs/video/make-voiceover.py <video in> <video out>
Writes the voice track next to the output as <out>.voice.m4a and prints each line's slot, length and speed-up.
"""
import json
import subprocess
import sys
import tempfile
from pathlib import Path

src, dst = Path(sys.argv[1]), Path(sys.argv[2])
cfg = json.loads((Path(__file__).parent / "voiceover.json").read_text())
probe = lambda p: float(subprocess.check_output(["ffprobe", "-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", str(p)]))  # noqa: E731
vdur = probe(src)
tmp = Path(tempfile.mkdtemp(prefix="credence-vo-"))

# The voice's first call after a while can come out slow and padded: speak a throwaway line first.
subprocess.run(["say", "-v", cfg["voice"], "-o", str(tmp / "warmup.aiff"), "Warming up."], check=True)

parts, end = [], 0.0
for i, line in enumerate(cfg["lines"]):
    raw = tmp / f"l{i}.aiff"
    subprocess.run(["say", "-v", cfg["voice"], "-o", str(raw), line["text"]], check=True)
    d = probe(raw)
    slot = line["end"] - line["start"]
    tempo = min(1.15, max(1.0, d / slot))
    fitted = tmp / f"l{i}.wav"
    subprocess.run(["ffmpeg", "-v", "error", "-y", "-i", str(raw), "-af", f"atempo={tempo:.4f},aresample=48000", "-ac", "1", str(fitted)], check=True)
    fd = probe(fitted)
    parts.append((fitted, line["start"]))
    end = max(end, line["start"] + fd)
    print(f"{line['start']:6.1f}-{line['end']:6.1f}  slot {slot:5.1f}s  spoken {d:5.1f}s  x{tempo:.2f} -> {fd:5.1f}s{'  OVERRUNS' if line['start'] + fd > line['end'] + 0.3 else ''}")

total = max(vdur, end + 0.6)
if total > 180.0:
    sys.exit(f"the video would run {total:.1f}s, over 3:00: shorten a line in voiceover.json")

voice = dst.with_suffix(".voice.m4a")
inputs = sum((["-i", str(p)] for p, _ in parts), [])
delays = ";".join(f"[{i}:a]adelay={int(s * 1000)}|{int(s * 1000)}[a{i}]" for i, (_, s) in enumerate(parts))
mix = "".join(f"[a{i}]" for i in range(len(parts)))
subprocess.run(["ffmpeg", "-v", "error", "-y", *inputs, "-filter_complex",
                f"{delays};{mix}amix=inputs={len(parts)}:normalize=0,apad,atrim=0:{total:.3f},loudnorm=I=-16:TP=-1.5:LRA=11[out]",
                "-map", "[out]", "-ar", "48000", "-c:a", "aac", "-b:a", "192k", str(voice)], check=True)

hold = max(0.0, total - vdur)
vf = f"scale=1920:1080:flags=lanczos,format=yuv420p{f',tpad=stop_mode=clone:stop_duration={hold:.3f}' if hold > 0 else ''}"
subprocess.run(["ffmpeg", "-v", "error", "-y", "-i", str(src), "-i", str(voice), "-vf", vf, "-map", "0:v", "-map", "1:a",
                "-c:v", "libx264", "-preset", "slow", "-crf", "18", "-r", "60", "-c:a", "copy", "-shortest", "-movflags", "+faststart", str(dst)], check=True)
print(f"wrote {dst} ({int(total // 60)}:{int(total % 60):02d}, last frame held {hold:.1f}s) and {voice}")
