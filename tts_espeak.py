"""
espeak-ng TTS worker. Bridges the RENTAHAL bus to the espeak-ng system binary.

Why espeak: it's the right offline TTS for accessibility, screen readers,
and air-gapped deployments. Fast (millisecond latency), small (a few MB),
ships in every Linux distro and macOS via brew. Sounds robotic — that's
the trade-off; the modern alternative is coqui or elevenlabs (other workers).

Configuration: config/worker_endpoints.ini → [tts_espeak]
    binary    — name or path of the espeak binary (default 'espeak-ng',
                falls back to 'espeak' if espeak-ng not found)
    voice     — voice/language code (default 'en')
    speed     — words per minute (default 175)
    pitch     — pitch 0..99 (default 50)
    worktype  — capability name (default 'tts')

Usage:
    apt install espeak-ng     # or: brew install espeak
    python -m workers.tts_espeak --name tts_espeak_1

The worker shells out to espeak-ng with -w to write a WAV file, reads the
bytes back, base64-encodes, and returns it in the deliver body as result
with result_kind='audio_b64'.

Submit body fields:
    text     — text to synthesize (required)
    voice    — per-call voice override
    speed    — per-call speed override
    pitch    — per-call pitch override
"""
from __future__ import annotations
import asyncio
import base64
import os
import shutil
import sys
import tempfile

from workers.sdk import Worker, run_worker, load_config


def _find_espeak(name_hint: str = "espeak-ng") -> str | None:
    """Locate the espeak binary. Try the configured name first, then fallbacks."""
    candidates = [name_hint]
    if name_hint != "espeak-ng":
        candidates.append("espeak-ng")
    if name_hint != "espeak":
        candidates.append("espeak")
    for c in candidates:
        path = shutil.which(c)
        if path:
            return path
    return None


class EspeakWorker(Worker):
    capabilities = ["tts"]
    softping_interval_sec = 1.0  # espeak is fast but we ping anyway

    def __init__(self, orch_url, peer_id, voice=None, speed=None, **kwargs):
        super().__init__(orch_url, peer_id, **kwargs)
        cfg = load_config()
        binary_hint = cfg.get("worker_endpoints", "tts_espeak", "binary", "espeak-ng")
        self.binary = _find_espeak(binary_hint)
        if not self.binary:
            print(f"FATAL: espeak-ng binary not found on PATH "
                  f"(tried {binary_hint!r}, espeak-ng, espeak). "
                  f"Install with `apt install espeak-ng` or `brew install espeak`.",
                  file=sys.stderr)
            sys.exit(2)

        self.voice = voice or cfg.get("worker_endpoints", "tts_espeak", "voice", "en")
        self.speed = cfg.get_int("worker_endpoints", "tts_espeak", "speed", 175)
        self.pitch = cfg.get_int("worker_endpoints", "tts_espeak", "pitch", 50)
        self.worktype = cfg.get("worker_endpoints", "tts_espeak", "worktype", "tts")
        self.capabilities = [self.worktype]
        self.metadata = {
            "engine": "espeak",
            "binary": self.binary,
            "voice": self.voice,
            "speed": self.speed,
            "pitch": self.pitch,
        }

    async def handle(self, work_id: int, body: dict) -> dict:
        text = body.get("text") or body.get("payload_ref") or ""
        if not text:
            return {"result": None, "error": "espeak: empty text"}

        voice = body.get("voice") or self.voice
        speed = int(body.get("speed") or self.speed)
        pitch = int(body.get("pitch") or self.pitch)

        # Write audio to a temp file then read it back. espeak supports
        # streaming to stdout via -, but the WAV header it emits doesn't
        # include the size field for stdout streams, which trips ffmpeg
        # decoders downstream. Tempfile is more reliable.
        with tempfile.NamedTemporaryFile(suffix=".wav", delete=False) as tmp:
            tmp_path = tmp.name

        try:
            cmd = [
                self.binary,
                "-v", voice,
                "-s", str(speed),
                "-p", str(pitch),
                "-w", tmp_path,
                text,
            ]
            proc = await asyncio.create_subprocess_exec(
                *cmd,
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE,
            )
            try:
                _, stderr = await asyncio.wait_for(proc.communicate(), timeout=30)
            except asyncio.TimeoutError:
                proc.kill()
                return {"result": None, "error": "espeak: timeout"}

            if proc.returncode != 0:
                err = (stderr.decode("utf-8", errors="replace")[:300]
                       if stderr else f"exit {proc.returncode}")
                return {"result": None, "error": f"espeak failed: {err}"}

            try:
                with open(tmp_path, "rb") as f:
                    audio_bytes = f.read()
            except FileNotFoundError:
                return {"result": None, "error": "espeak: no audio file produced"}

            if not audio_bytes:
                return {"result": None, "error": "espeak: empty audio output"}

            audio_b64 = base64.b64encode(audio_bytes).decode("ascii")
            return {
                "result": audio_b64,
                "result_kind": "audio_b64",
                "audio_format": "wav",
                "engine": "espeak",
                "voice": voice,
                "speed": speed,
                "pitch": pitch,
                "byte_size": len(audio_bytes),
                "by": self.peer_id,
            }
        finally:
            try:
                os.unlink(tmp_path)
            except Exception:
                pass


if __name__ == "__main__":
    sys.exit(run_worker(
        EspeakWorker,
        default_name="tts_espeak1",
        extra_args=[
            {"flags": ["--voice"], "kwargs": {
                "type": str, "default": None,
                "help": "Voice/language code (overrides worker_endpoints.ini)"}},
            {"flags": ["--speed"], "kwargs": {
                "type": int, "default": None,
                "help": "Words per minute"}},
        ],
    ))
