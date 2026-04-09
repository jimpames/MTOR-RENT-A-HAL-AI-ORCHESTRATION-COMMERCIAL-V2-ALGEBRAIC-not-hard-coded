"""
Coqui TTS worker. Bridges the RENTAHAL bus to the coqui-ai TTS Python package.

Why coqui alongside espeak: it's significantly higher quality (neural VITS,
Tacotron, XTTS models) and runs entirely offline, but it's slower (~1-3s on
CPU, ~200ms on a GPU). The right choice for offline deployments where the
robotic espeak voice isn't acceptable.

Configuration: config/worker_endpoints.ini → [tts_coqui]
    model     — coqui model id (default 'tts_models/en/ljspeech/vits')
    device    — 'cpu' | 'cuda' (default 'cpu')
    worktype  — capability name (default 'tts')

Usage:
    pip install TTS
    python -m workers.tts_coqui --name tts_coqui_1

The worker fails fast if the TTS package isn't installed. We don't register
a half-functional worker into the manifest.

Submit body fields:
    text      — text to synthesize (required)
    speaker   — multi-speaker model speaker id (optional)
    language  — multilingual model language code (optional)
"""
from __future__ import annotations
import asyncio
import base64
import os
import sys
import tempfile

from workers.sdk import Worker, run_worker, load_config


# Fail fast if the TTS package isn't installed.
try:
    from TTS.api import TTS  # type: ignore
    COQUI_AVAILABLE = True
    COQUI_IMPORT_ERROR = None
except ImportError as _e:
    TTS = None  # type: ignore
    COQUI_AVAILABLE = False
    COQUI_IMPORT_ERROR = _e


class CoquiTTSWorker(Worker):
    capabilities = ["tts"]
    softping_interval_sec = 1.5

    def __init__(self, orch_url, peer_id, model=None, device=None, **kwargs):
        super().__init__(orch_url, peer_id, **kwargs)

        if not COQUI_AVAILABLE:
            print(f"FATAL: coqui TTS not installed. Run `pip install TTS` "
                  f"on this node, or use workers.tts_espeak for offline TTS "
                  f"without the dependency.\nImport error: {COQUI_IMPORT_ERROR}",
                  file=sys.stderr)
            sys.exit(2)

        cfg = load_config()
        self.model_name = model or cfg.get(
            "worker_endpoints", "tts_coqui", "model",
            "tts_models/en/ljspeech/vits")
        self.device = device or cfg.get(
            "worker_endpoints", "tts_coqui", "device", "cpu")
        self.worktype = cfg.get(
            "worker_endpoints", "tts_coqui", "worktype", "tts")
        self.capabilities = [self.worktype]

        # Load the model at startup
        print(f"[{self.peer_id}] loading {self.model_name} on {self.device}...",
              file=sys.stderr)
        try:
            # The TTS class accepts gpu=True/False; the device string is
            # decoded here for compatibility with both old and new APIs.
            use_gpu = self.device.lower().startswith("cuda")
            self._tts = TTS(model_name=self.model_name, progress_bar=False,
                            gpu=use_gpu)
        except Exception as e:
            print(f"FATAL: coqui model load failed: {e}", file=sys.stderr)
            sys.exit(3)
        print(f"[{self.peer_id}] coqui model loaded", file=sys.stderr)

        self.metadata = {
            "engine": "coqui",
            "model": self.model_name,
            "device": self.device,
        }

    async def handle(self, work_id: int, body: dict) -> dict:
        text = body.get("text") or body.get("payload_ref") or ""
        if not text:
            return {"result": None, "error": "coqui: empty text"}

        speaker = body.get("speaker")
        language = body.get("language")

        with tempfile.NamedTemporaryFile(suffix=".wav", delete=False) as tmp:
            tmp_path = tmp.name

        try:
            def _synthesize():
                kwargs = {"text": text, "file_path": tmp_path}
                if speaker:
                    kwargs["speaker"] = speaker
                if language:
                    kwargs["language"] = language
                self._tts.tts_to_file(**kwargs)

            try:
                await asyncio.to_thread(_synthesize)
            except Exception as e:
                return {"result": None, "error": f"coqui synthesize failed: {e}"}

            try:
                with open(tmp_path, "rb") as f:
                    audio_bytes = f.read()
            except FileNotFoundError:
                return {"result": None, "error": "coqui: no audio file produced"}

            if not audio_bytes:
                return {"result": None, "error": "coqui: empty audio output"}

            audio_b64 = base64.b64encode(audio_bytes).decode("ascii")
            return {
                "result": audio_b64,
                "result_kind": "audio_b64",
                "audio_format": "wav",
                "engine": "coqui",
                "model": self.model_name,
                "device": self.device,
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
        CoquiTTSWorker,
        default_name="tts_coqui1",
        extra_args=[
            {"flags": ["--model"], "kwargs": {
                "type": str, "default": None,
                "help": "Coqui model id (overrides worker_endpoints.ini)"}},
            {"flags": ["--device"], "kwargs": {
                "type": str, "default": None,
                "help": "cpu | cuda"}},
        ],
    ))
