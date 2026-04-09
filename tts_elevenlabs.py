"""
ElevenLabs TTS worker. Bridges the RENTAHAL bus to the ElevenLabs cloud API.

Why ElevenLabs alongside espeak/coqui: it's the highest quality TTS available
right now, with voice cloning, multilingual support, and emotional expression.
Paid, requires an API key. The right choice for premium deployments and
demos where audio quality is the differentiator.

Configuration: config/worker_endpoints.ini → [tts_elevenlabs]
    base_url      — API base (default https://api.elevenlabs.io/v1)
    api_key_env   — env var name (default ELEVENLABS_API_KEY)
    voice_id      — default voice id (one of ElevenLabs' voice library)
    model_id      — model id (default eleven_monolingual_v1)
    worktype      — capability name (default 'tts')
    cost_per_call — informational cost stamped on deliver

Usage:
    export ELEVENLABS_API_KEY=...
    python -m workers.tts_elevenlabs --name tts_eleven_1

Refuses to start without the API key.

Submit body fields:
    text          — text to synthesize (required)
    voice_id      — per-call voice override
    model_id      — per-call model override
    stability     — voice settings: stability 0..1
    similarity_boost — voice settings: similarity 0..1
"""
from __future__ import annotations
import asyncio
import base64
import os
import sys

import aiohttp

from workers.sdk import Worker, run_worker, load_config


class ElevenLabsTTSWorker(Worker):
    capabilities = ["tts"]

    def __init__(self, orch_url, peer_id, voice_id=None, model_id=None,
                 base_url=None, api_key=None, **kwargs):
        super().__init__(orch_url, peer_id, **kwargs)
        cfg = load_config()
        self.base_url = (base_url
                         or cfg.get("worker_endpoints", "tts_elevenlabs", "base_url",
                                    "https://api.elevenlabs.io/v1")).rstrip("/")
        self.voice_id = voice_id or cfg.get(
            "worker_endpoints", "tts_elevenlabs", "voice_id",
            "21m00Tcm4TlvDq8ikWAM")  # Rachel — ElevenLabs default
        self.model_id = model_id or cfg.get(
            "worker_endpoints", "tts_elevenlabs", "model_id",
            "eleven_monolingual_v1")
        self.worktype = cfg.get(
            "worker_endpoints", "tts_elevenlabs", "worktype", "tts")
        self.cost_per_call = cfg.get_float(
            "worker_endpoints", "tts_elevenlabs", "cost_per_call", 0.030)

        key_env = cfg.get(
            "worker_endpoints", "tts_elevenlabs", "api_key_env", "ELEVENLABS_API_KEY")
        self.api_key = api_key or os.environ.get(key_env)
        if not self.api_key:
            print(f"FATAL: {key_env} not set. Refusing to start an "
                  f"elevenlabs tts worker without credentials.",
                  file=sys.stderr)
            sys.exit(2)

        self.capabilities = [self.worktype]
        self.metadata = {
            "engine": "elevenlabs",
            "voice_id": self.voice_id,
            "model_id": self.model_id,
            "base_url": self.base_url,
        }
        self._session: aiohttp.ClientSession | None = None

    async def _get_session(self) -> aiohttp.ClientSession:
        if self._session is None or self._session.closed:
            self._session = aiohttp.ClientSession(
                timeout=aiohttp.ClientTimeout(total=60))
        return self._session

    async def on_disconnect(self) -> None:
        if self._session and not self._session.closed:
            await self._session.close()
        self._session = None

    async def handle(self, work_id: int, body: dict) -> dict:
        text = body.get("text") or body.get("payload_ref") or ""
        if not text:
            return {"result": None, "error": "elevenlabs: empty text"}

        voice_id = body.get("voice_id") or self.voice_id
        model_id = body.get("model_id") or self.model_id

        url = f"{self.base_url}/text-to-speech/{voice_id}"
        payload: dict = {
            "text": text,
            "model_id": model_id,
        }
        # Optional voice settings
        voice_settings = {}
        if body.get("stability") is not None:
            voice_settings["stability"] = float(body["stability"])
        if body.get("similarity_boost") is not None:
            voice_settings["similarity_boost"] = float(body["similarity_boost"])
        if voice_settings:
            payload["voice_settings"] = voice_settings

        headers = {
            "xi-api-key": self.api_key,
            "Content-Type": "application/json",
            "Accept": "audio/mpeg",
        }

        try:
            session = await self._get_session()
            async with session.post(url, json=payload, headers=headers) as resp:
                if resp.status != 200:
                    err_text = await resp.text()
                    return {
                        "result": None,
                        "error": f"elevenlabs HTTP {resp.status}: {err_text[:300]}",
                    }
                audio_bytes = await resp.read()
        except aiohttp.ClientError as e:
            return {"result": None, "error": f"elevenlabs connection: {e}"}
        except asyncio.TimeoutError:
            return {"result": None, "error": "elevenlabs timeout"}

        if not audio_bytes:
            return {"result": None, "error": "elevenlabs: empty audio response"}

        audio_b64 = base64.b64encode(audio_bytes).decode("ascii")
        return {
            "result": audio_b64,
            "result_kind": "audio_b64",
            "audio_format": "mp3",  # ElevenLabs returns mpeg/mp3
            "engine": "elevenlabs",
            "voice_id": voice_id,
            "model_id": model_id,
            "byte_size": len(audio_bytes),
            "char_count": len(text),
            "cost_units": self.cost_per_call,
            "by": self.peer_id,
        }


if __name__ == "__main__":
    sys.exit(run_worker(
        ElevenLabsTTSWorker,
        default_name="tts_eleven1",
        extra_args=[
            {"flags": ["--voice-id"], "kwargs": {
                "type": str, "default": None, "dest": "voice_id",
                "help": "ElevenLabs voice id"}},
            {"flags": ["--model-id"], "kwargs": {
                "type": str, "default": None, "dest": "model_id",
                "help": "ElevenLabs model id"}},
            {"flags": ["--base-url"], "kwargs": {
                "type": str, "default": None, "dest": "base_url",
                "help": "API base URL (override for testing)"}},
            {"flags": ["--api-key"], "kwargs": {
                "type": str, "default": None, "dest": "api_key",
                "help": "Override API key (default: read from env var)"}},
        ],
    ))
