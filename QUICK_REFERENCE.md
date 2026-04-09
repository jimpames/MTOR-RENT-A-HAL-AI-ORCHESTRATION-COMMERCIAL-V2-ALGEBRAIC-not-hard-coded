# RENTAHAL V2 — Quick Reference

A one-page operator cheat sheet. For the full reference, see `CONFIG_REFERENCE.md`, `ARCHITECTURE.md`, and `DEPLOYMENT.md`.

---

## Run It

### Start the orchestrator
```bash
python -m orchestrator
```

### Start workers (each in its own shell or systemd unit)
```bash
python -m workers.echo                  --name echo1
python -m workers.ollama                --name ollama_rtx1
python -m workers.llava                 --name llava_rtx1
python -m workers.stable_diffusion      --name sd_rtx2
python -m workers.whisper               --name whisper1
python -m workers.gpt4all               --name g4a1
python -m workers.tts_espeak            --name tts1   # apt install espeak-ng
python -m workers.tts_coqui             --name tts2   # pip install TTS
ANTHROPIC_API_KEY=sk-ant-...   python -m workers.claude_api      --name claude1
OPENAI_API_KEY=sk-...          python -m workers.openai_api      --name openai1
HF_API_TOKEN=hf_...            python -m workers.hf_api          --name hf1
ELEVENLABS_API_KEY=...         python -m workers.tts_elevenlabs  --name tts3
```

### Open the GUIs
```
http://localhost:3000/        — User GUI
http://localhost:3000/admin   — Operator console
```

---

## Inspect

```bash
curl http://localhost:3000/_debug/peers       # connected peers
curl http://localhost:3000/_debug/manifest    # capability manifest
curl http://localhost:3000/_debug/queue       # work queue
curl http://localhost:3000/_debug/events      # event log
curl http://localhost:3000/_sysop/workers     # worker fleet + health scores
curl http://localhost:3000/_sysop/users       # user cost report
curl http://localhost:3000/_sysop/api_health  # cloud API probe state
```

Live log stream:
```bash
wscat -c ws://localhost:3000/_debug/log/stream
```

---

## Operate

### Sysop broadcast
```bash
curl -X POST http://localhost:3000/_sysop/broadcast \
  -H 'Content-Type: application/json' \
  -d '{"message": "hello users", "level": "info"}'
```
Levels: `info`, `warn`, `error`.

### Ban a peer
```bash
curl -X POST http://localhost:3000/_sysop/ban \
  -H 'Content-Type: application/json' \
  -d '{"peer_id": "client_abc123"}'
```

### Unban a peer
```bash
curl -X POST http://localhost:3000/_sysop/unban \
  -H 'Content-Type: application/json' \
  -d '{"peer_id": "client_abc123"}'
```

### Per-user totals
```bash
curl http://localhost:3000/_sysop/user/client_abc123
```

### Hot reload configuration
```bash
curl -X POST http://localhost:3000/_sysop/reload
```

---

## Configure

| File | What it controls |
|---|---|
| `config/orchestrator.ini` | Bus port, scheduler policy, debug flags, db path, api_health |
| `config/worktypes.ini` | Capability declarations, costs, timeouts |
| `config/workers.ini` | Generic worker policy |
| `config/worker_endpoints.ini` | Per-worker URLs, models, env vars |
| `config/actions.ini` | User-facing actions: chat, vision, imagine |
| `config/routes.ini` | Frame routing rules |
| `config/health.ini` | Worker health policy + numeric scoring |
| `config/api_health.ini` | Cloud API probe targets |
| `config/speech.ini` | Wake word, Whisper, audio chunking |
| `config/logging.ini` | Log levels, ring buffer |
| `config/theme.ini` | GUI colors, fonts, branding |

### Common knobs

```ini
# orchestrator.ini
[bus]                                       [scheduler]
port = 3000                                 policy = round_robin    # or health_weighted
heartbeat_interval_sec = 5                  dispatch_timeout_sec = 120

# health.ini
[scoring]
initial_score = 100.0      success_delta = 2.0       hard_failure_delta = -15.0
soft_failure_delta = -5.0  idle_recovery_delta = 0.5 dispatch_threshold = 10.0

# worktypes.ini
[claude_api]
cost_per_call = 0.015      timeout_sec = 60          retry_max = 2

# speech.ini
[wake_word]
word = HAL                 enabled = true            timeout_sec = 8
```

---

## Frame Protocol (14 types)

| Frame | Direction | Body keys |
|---|---|---|
| `hello` | client→orch | peer_id, role, capabilities, metadata |
| `welcome` | orch→client | manifest, heartbeat_interval_sec, undelivered_count, user_totals |
| `heartbeat` | client→orch | ts |
| `submit` | client→orch | action, worktype, text, image_b64?, image_media_type? |
| `dispatch` | orch→worker | work_id, worktype, action, source_peer, body |
| `softping` | worker→orch | work_id |
| `deliver` | worker→orch→client | work_id, worktype, worker_peer, processing_ms, cost_units, result, result_kind, error? |
| `chunk` | client→orch | stream_id, chunk_index, is_last, data_b64, mime_type |
| `error` | any→any | reason, work_id? |
| `manifest_update` | orch→all | worktypes, actions |
| `replay_request` | client→orch | (none) |
| `replay_dismiss` | client→orch | (none) |
| `set_nickname` | client→orch | nickname |
| `sysop_message` | orch→all | message, level, ts |

---

## Worktypes Shipped

| Worktype | Workers | Cost | Notes |
|---|---|---|---|
| `echo` | echo | $0.000 | Smoke test |
| `llama` | ollama | $0.000 | Local chat |
| `gpt4all` | gpt4all | $0.000 | Alt local chat |
| `llava` | llava | $0.000 | Local vision |
| `sd` | stable_diffusion | $0.000 | Local image gen |
| `stt` | whisper | $0.000 | Speech-to-text |
| `tts` | tts_espeak / tts_coqui / tts_elevenlabs | varies | Text-to-speech |
| `claude_api` | claude_api | $0.015 | Anthropic |
| `claude_vision_api` | claude_api | $0.020 | Anthropic vision |
| `openai_api` | openai_api | $0.010 | OpenAI |
| `openai_vision_api` | openai_api | $0.015 | OpenAI vision |
| `hf_api` | hf_api | $0.002 | HuggingFace |
| `dalle_api` | (uses openai_api) | $0.040 | OpenAI image gen |

---

## Speech Loop

1. User says "**HAL** chat tell me about Apollo 11"
2. Browser SR detects wake word → MediaRecorder captures audio
3. `chunk` frames upload audio to whisper worker
4. Whisper transcribes → "tell me about Apollo 11"
5. ui.js infers action (chat) + worktype (llama)
6. Submit → ollama → text result
7. **If speech output enabled**: ui.js auto-fires `submit('chat', 'tts', text)`
8. TTS worker synthesizes → audio_b64 deliver
9. ui.js attaches `<audio autoplay>` to the original result card
10. User hears the answer spoken back

---

## Test Suite

```bash
# Run a single test
python tests/test_phase55_health.py

# Run all Python tests
for t in tests/test_*.py; do python "$t"; done

# Run all JS tests
for t in tests/test_*.js; do node "$t"; done
```

207 tests across 21 files. All should pass.

---

## File Layout

```
rentahal/
├── orchestrator/         Bus, dispatcher, db, config, api_health, frames, schema
├── workers/              13 worker modules + sdk.py
├── gui/                  index.html, admin.html, bus.js, ui.js, speech.js, style.css
├── config/               11 .ini files
├── tests/                21 test files + fakes/
├── data/                 SQLite database (created on first run)
├── payload_store/        Large blob storage (created on first run)
├── README.md
├── ARCHITECTURE.md       System design
├── CONFIG_REFERENCE.md   Authoritative config reference
├── DEPLOYMENT.md         Deployment guide (speculative — refine after real deploy)
├── QUICK_REFERENCE.md    This file
├── CHANGELOG.md          Phase-by-phase build history
├── EXECUTIVE_SUMMARY.md  Elevator pitch
└── algebraic-design-paper.md  Methodology paper
```

---

## Troubleshooting Triage

| Symptom | First check |
|---|---|
| Orch won't start | Logs; `[bus] port` collision; data/ permissions |
| Worker registers but no work | `/_debug/manifest`; verify `worktype` matches |
| "no eligible workers" | `/_sysop/workers`; check health_score vs dispatch_threshold |
| Voice loop not transcribing | `/_debug/manifest` for `stt` capability; check whisper logs |
| TTS audio not playing | speech-output checkbox; browser autoplay policy; `tts` worker registered |
| Cloud API probe flapping | `/_sysop/api_health` last_error; API key env var; raise `fail_threshold` |
| Health scores collapsed | `/_sysop/workers` fail_count; check worker logs for repeated failures |
| Cost ledger seems wrong | `/_sysop/users` vs `/_sysop/user/{peer_id}`; check `cost_per_call` in worktypes.ini |
| Tests fail on fresh box | Python 3.12+; `pip install -r requirements.txt`; espeak-ng for tts test |

---

*See `DEPLOYMENT.md` for full deployment workflow. See `CONFIG_REFERENCE.md` for every key. See `ARCHITECTURE.md` for design rationale. See `algebraic-design-paper.md` for the methodology behind it all.*
