# RENTAHAL V2 — Configuration Reference

This document is the authoritative reference for every configuration file in `config/`. RENTAHAL V2 is built on the **algebraic systems design** discipline: zero hardcoded behavioral constants in Python, every operational parameter declared in `.ini` files, code as a homomorphism from configuration to runtime behavior. This reference is therefore the *executable specification* of the system. To understand what V2 does, read this document first; to understand how it does it, read the source code second.

V2 ships with eleven configuration files in `config/`:

| File | Purpose |
|---|---|
| `orchestrator.ini` | Bus, scheduler, debug, db, payloads, api_health |
| `worktypes.ini` | Capability declarations: input/output kind, timeouts, retries, costs |
| `workers.ini` | Generic worker registration policy |
| `worker_endpoints.ini` | Per-worker integration: URLs, models, env vars, parameters |
| `actions.ini` | User-facing action grammar (chat, vision, imagine) |
| `routes.ini` | Frame routing rules |
| `health.ini` | Worker health policy: heartbeat, scoring, blacklist, probation |
| `api_health.ini` | Cloud API probe targets for sysop dashboard |
| `speech.ini` | Wake word, Whisper, audio chunking |
| `logging.ini` | Log levels, ring buffer, output format |
| `theme.ini` | GUI color scheme, fonts, branding |

Every file is read at orchestrator startup by the `Config` class in `orchestrator/config.py` and exposed to the rest of the kernel through typed getters: `get(section, key, default)`, `get_int(section, key, default)`, `get_float(section, key, default)`. Hot reload is supported via the `/_sysop/reload` HTTP endpoint — operators can edit a value and trigger a re-read without restarting the orchestrator.

The default values shown in this document are *defensive fallbacks* in code, not the values shipped in the .ini files. Where a shipped value differs, both are shown. Operators are expected to set values explicitly in production deployments rather than relying on defaults.

---

## 1. `orchestrator.ini` — Kernel Configuration

The orchestrator's own behavioral envelope. This file defines how the bus listens, how the scheduler routes work, how the debug surface behaves, and how the database and payload store are configured.

### `[bus]` — WebSocket bus and HTTP server

| Key | Type | Default | Description |
|---|---|---|---|
| `host` | string | `0.0.0.0` | Interface to bind. Use `0.0.0.0` for all interfaces, `127.0.0.1` to restrict to localhost. |
| `port` | int | `3000` | TCP port. The GUI, the WebSocket bus, the debug endpoints, the sysop endpoints, and the admin console all live on this single port. |
| `ws_path` | string | `/bus` | The WebSocket endpoint path. Workers and clients connect to `ws://<host>:<port>/bus`. |
| `heartbeat_interval_sec` | int | `5` | How often the orchestrator expects a heartbeat frame from each connected peer. |
| `heartbeat_timeout_sec` | int | `20` | After this many seconds without a heartbeat, the peer is considered offline and reaped. |
| `max_frame_bytes` | int | `1048576` | Maximum size of a single WebSocket frame. Larger payloads (images, audio) must be sent via the chunked upload mechanism. |

### `[scheduler]` — Worker selection policy

| Key | Type | Default | Description |
|---|---|---|---|
| `policy` | string | `round_robin` | Worker selection algorithm. One of `round_robin`, `random`, `least_loaded`, `health_weighted`. See section 1.1 below. |
| `dispatch_timeout_sec` | int | `120` | After dispatching work to a worker, the orchestrator waits this many seconds for a deliver before declaring a hard timeout (which triggers retry + health penalty). |
| `softping_grace_sec` | int | `60` | Workers handling long-running work can send a `softping` frame to extend the timeout. This is the grace period added per softping. |

#### 1.1 Scheduler policies

- **`round_robin`** — The default. Cycles through eligible workers in order. Simple, predictable, fair.
- **`random`** — Picks a random eligible worker. Useful for load distribution when workers have heterogeneous performance.
- **`least_loaded`** — Counts in-flight dispatched work per worker and picks the one with the fewest active jobs. Equivalent to MVS WLM's load-based dispatch.
- **`health_weighted`** — *Phase 5.5 introduction.* Sorts eligible workers by `(health_score desc, in_flight asc)`. A worker at score 100 with 2 jobs in flight is preferred over a worker at score 40 with 0 jobs. This is the MVS WLM analogue: capability weighs more than load. Requires `[scoring]` to be configured in `health.ini`.

All policies respect the `dispatch_threshold` filter from `health.ini` `[scoring]`: workers below the threshold are skipped, with a fallback to the highest-scored worker if every candidate is below threshold (so work doesn't stall during cluster-wide flaps).

### `[db]` — Database driver

| Key | Type | Default | Description |
|---|---|---|---|
| `driver` | string | `sqlite` | The only currently-implemented driver. The interface is swappable: adding a postgres driver means writing `orchestrator/db_postgres.py` and changing this line. |
| `path` | string | `data/rentahal.db` | Filesystem path to the SQLite database. Created on first run if absent. |
| `wal` | bool | `true` | Enable SQLite WAL (write-ahead logging) for better concurrent reader performance. |

### `[payloads]` — Payload storage strategy

| Key | Type | Default | Description |
|---|---|---|---|
| `inline_max_bytes` | int | `1048576` | Payloads at or below this size live inline in the database (fast, audit-friendly). Above this they go to disk. |
| `store_dir` | string | `payload_store` | Directory for above-threshold payloads, addressed by SHA256. |

### `[api_health]` — Cloud API probe loop

| Key | Type | Default | Description |
|---|---|---|---|
| `enabled` | bool | `true` | Whether to run the API health probe loop at all. |
| `interval_sec` | int | `60` | Time between full probe cycles. |
| `probe_timeout_sec` | int | `8` | HTTP timeout for individual probe requests. |
| `fail_threshold` | int | `2` | Consecutive failures before declaring a target degraded and broadcasting a sysop_message. |
| `recovery_threshold` | int | `2` | Consecutive successes before clearing degraded state. |
| `degraded_level` | string | `warn` | Sysop broadcast level for degradation events. One of `info`, `warn`, `error`. |
| `recovery_level` | string | `info` | Sysop broadcast level for recovery events. |

Probe targets themselves live in `api_health.ini`, not here.

### `[debug]` — Debug surface

| Key | Type | Default | Description |
|---|---|---|---|
| `enabled` | bool | `true` | Master switch for `/_debug/*` HTTP endpoints. Set `false` for production deployments where you don't want operators reading internal state via HTTP. |
| `log_ring_size` | int | `5000` | Number of log entries kept in the in-memory ring buffer (served by `/_debug/log` and `/_debug/log/stream`). |
| `expose_peers` | bool | `true` | Whether `/_debug/peers` returns the live peer table. |
| `expose_queue` | bool | `true` | Whether `/_debug/queue` returns the work queue. |
| `expose_events` | bool | `true` | Whether `/_debug/events` returns the event log. |

---

## 2. `worktypes.ini` — Capability Declarations

A *worktype* is a capability that workers register against and that clients submit work for. Each section is one worktype. Worktypes are declared once here and consumed by every worker that implements them.

### Common keys (every worktype)

| Key | Type | Description |
|---|---|---|
| `description` | string | Human-readable description shown in operator tools and the GUI dropdown. |
| `input_kind` | string | What kind of input the worktype accepts. One of `text`, `text+image`, `audio`. |
| `output_kind` | string | What kind of output the worktype produces. One of `text`, `image`, `audio`. |
| `chunking` | bool | Whether large inputs may arrive via chunked upload (used for audio capture and image attachments). |
| `timeout_sec` | int | Per-call dispatch timeout for this worktype. Overrides `[scheduler] dispatch_timeout_sec`. |
| `retry_max` | int | Maximum retries on dispatch timeout before failing terminally. |
| `always_available` | bool | If true, the worktype shows as available in the manifest even when no live workers are registered (used for cloud API workers that don't pre-register). |
| `cost_per_call` | float | Default cost in dollars per call. Workers may override this by stamping `cost_units` in their deliver body (Phase 5.6 enhancement, used by elevenlabs). |

### Worktypes shipped in V2

| Section | Description | Default cost |
|---|---|---|
| `[echo]` | Trivial echo worker for testing the bus and dispatcher. | $0.000 |
| `[llama]` | Local LLM via Ollama. | $0.000 |
| `[llava]` | Vision LLM via Ollama. | $0.000 |
| `[sd]` | Stable Diffusion image generation via A1111 webui. | $0.000 |
| `[stt]` | Speech-to-text via faster-whisper. | $0.000 |
| `[gpt4all]` | Local LLM via gpt4all native bindings. | $0.000 |
| `[claude_api]` | Anthropic Claude API. | $0.015 |
| `[claude_vision_api]` | Anthropic Claude vision API. | $0.020 |
| `[openai_api]` | OpenAI text completion API. | $0.010 |
| `[openai_vision_api]` | OpenAI vision API. | $0.015 |
| `[hf_api]` | HuggingFace inference API. | $0.002 |
| `[dalle_api]` | OpenAI DALL-E image generation. | $0.040 |
| `[tts]` | Text-to-speech (espeak/coqui/elevenlabs). Worker-stamped cost. | $0.000 |

---

## 3. `workers.ini` — Worker Registration Policy

Generic policies that apply to all workers. Currently small; lives in its own file for future expansion.

### `[all]` — Defaults applied to every worker

| Key | Type | Default | Description |
|---|---|---|---|
| `auto_register` | bool | `true` | Whether workers self-register on `hello` connect. |
| `softping_default_sec` | float | `2.0` | Default softping interval when worker SDK doesn't override. |
| `metadata_required` | bool | `false` | Whether workers must provide metadata at registration time. |

---

## 4. `worker_endpoints.ini` — Per-Worker Integration

This is the file a worker operator edits when deploying a new worker on a new node. Each section corresponds to one worker module under `workers/`. The worker class reads its own section at startup via `load_config()`.

This is the file that demonstrates Rule 2 of algebraic design most clearly: **adding a new worker integration is one section here plus one Python file that reads the section.** The kernel never learns about the new worker.

### `[ollama]` — Local Ollama LLM

| Key | Type | Default | Description |
|---|---|---|---|
| `base_url` | string | `http://localhost:11434` | Ollama server URL. |
| `model` | string | `llama3` | Model name as registered in Ollama (`ollama list`). |
| `temperature` | float | `0.7` | Generation temperature. |
| `num_predict` | int | `512` | Maximum tokens to generate. |
| `worktype` | string | `llama` | Worktype name this worker registers under. |

### `[llava]` — Local Llava vision LLM

| Key | Type | Default | Description |
|---|---|---|---|
| `base_url` | string | `http://localhost:11434` | Ollama server URL. |
| `model` | string | `llava` | Vision model name. |
| `temperature` | float | `0.7` | Generation temperature. |
| `num_predict` | int | `512` | Maximum tokens. |
| `worktype` | string | `llava` | Worktype registration name. |

### `[stable_diffusion]` — A1111 Stable Diffusion

| Key | Type | Default | Description |
|---|---|---|---|
| `base_url` | string | `http://localhost:7860` | A1111 webui URL. |
| `model` | string | (whatever A1111 has loaded) | Optional model override. |
| `steps` | int | `20` | Diffusion steps. |
| `cfg_scale` | float | `7.0` | CFG scale. |
| `width` | int | `512` | Output width. |
| `height` | int | `512` | Output height. |
| `worktype` | string | `sd` | Worktype registration name. |

### `[whisper]` — faster-whisper STT

| Key | Type | Default | Description |
|---|---|---|---|
| `model` | string | `base` | Whisper model size: `tiny`, `base`, `small`, `medium`, `large`. |
| `device` | string | `cpu` | `cpu` or `cuda`. |
| `compute_type` | string | `int8` | Compute precision. |
| `language` | string | `en` | Default language code. |
| `worktype` | string | `stt` | Worktype registration name. |

### `[gpt4all]` — Local gpt4all native LLM

| Key | Type | Default | Description |
|---|---|---|---|
| `model` | string | `Llama-3.2-3B-Instruct.gguf` | Model file or absolute GGUF path. |
| `device` | string | `cpu` | `cpu` or `cuda`. |
| `n_threads` | int | `4` | CPU threads for inference. |
| `max_tokens` | int | `512` | Maximum tokens. |
| `temperature` | float | `0.7` | Generation temperature. |
| `worktype` | string | `gpt4all` | Worktype registration name. |

### `[claude_api]` — Anthropic Claude API

| Key | Type | Default | Description |
|---|---|---|---|
| `base_url` | string | `https://api.anthropic.com/v1` | API base. |
| `api_key_env` | string | `ANTHROPIC_API_KEY` | Env var name for the API key. |
| `model` | string | `claude-opus-4-6` | Model identifier. |
| `max_tokens` | int | `2048` | Per-request token cap. |
| `worktype` | string | `claude_api` | Worktype registration name. |

### `[openai_api]` — OpenAI completion API

| Key | Type | Default | Description |
|---|---|---|---|
| `base_url` | string | `https://api.openai.com/v1` | API base. |
| `api_key_env` | string | `OPENAI_API_KEY` | Env var name. |
| `model` | string | `gpt-4o` | Model identifier. |
| `max_tokens` | int | `2048` | Token cap. |
| `worktype` | string | `openai_api` | Registration name. |

### `[hf_api]` — HuggingFace Inference API

| Key | Type | Default | Description |
|---|---|---|---|
| `base_url` | string | `https://api-inference.huggingface.co` | API base. |
| `api_key_env` | string | `HF_API_TOKEN` | Env var name. |
| `model` | string | `meta-llama/Meta-Llama-3-8B-Instruct` | Model identifier. |
| `worktype` | string | `hf_api` | Registration name. |

### `[tts_espeak]` — Offline TTS via espeak-ng binary

| Key | Type | Default | Description |
|---|---|---|---|
| `binary` | string | `espeak-ng` | Binary name; falls back to `espeak` if `espeak-ng` not found. |
| `voice` | string | `en` | Voice/language code. |
| `speed` | int | `175` | Words per minute. |
| `pitch` | int | `50` | Pitch 0-99. |
| `worktype` | string | `tts` | Registration name. |

### `[tts_coqui]` — Offline neural TTS via coqui-ai TTS

| Key | Type | Default | Description |
|---|---|---|---|
| `model` | string | `tts_models/en/ljspeech/vits` | Coqui model id. |
| `device` | string | `cpu` | `cpu` or `cuda`. |
| `worktype` | string | `tts` | Registration name. |

### `[tts_elevenlabs]` — Cloud TTS via ElevenLabs

| Key | Type | Default | Description |
|---|---|---|---|
| `base_url` | string | `https://api.elevenlabs.io/v1` | API base. |
| `api_key_env` | string | `ELEVENLABS_API_KEY` | Env var name. |
| `voice_id` | string | `21m00Tcm4TlvDq8ikWAM` | Default voice (Rachel). |
| `model_id` | string | `eleven_monolingual_v1` | Model id. |
| `worktype` | string | `tts` | Registration name. |
| `cost_per_call` | float | `0.030` | Stamped on deliver body, overrides worktype default. |

---

## 5. `actions.ini` — User Action Grammar

Actions are the user-facing verbs that the GUI exposes. Each action maps to one or more allowed worktypes; the user picks an action and the GUI shows the available worktypes for it.

### Shipped actions

| Section | Default worktype | Allowed worktypes | Purpose |
|---|---|---|---|
| `[chat]` | `llama` | `echo, llama, gpt4all, claude_api, openai_api, hf_api, tts` | Text-in / text-out conversation |
| `[vision]` | `llava` | `llava, claude_vision_api, openai_vision_api` | Image-in / text-out reasoning |
| `[imagine]` | `sd` | `sd, dalle_api` | Text-in / image-out generation |

### Common keys per action section

| Key | Type | Description |
|---|---|---|
| `description` | string | Operator/UI description. |
| `default_worktype` | string | Pre-selected worktype when the user picks this action. |
| `allowed_worktypes` | string | Comma-separated list of worktypes the user may pick from. |

---

## 6. `routes.ini` — Frame Routing

Frame-level routing rules. Currently small; the bus dispatches frames by type and the dispatcher handles the work-flow rules. Future expansion will move more routing logic here.

### `[chat]`, `[vision]`, `[imagine]`

Per-action routing hints. Currently used to override worktype selection or apply per-action filters. See the `[modules]` section for kernel module wiring.

### `[modules]`

Lists the kernel modules loaded at startup. Reserved for future hot-load capability.

---

## 7. `health.ini` — Worker Health Policy

The numeric health scoring system (Phase 5.5) and the legacy categorical state machine.

### `[scoring]` — *Phase 5.5* numeric health scoring (MVS WLM analogue)

| Key | Type | Default | Description |
|---|---|---|---|
| `initial_score` | float | `100.0` | Score assigned to a fresh worker on first registration. |
| `success_delta` | float | `2.0` | Bump applied on successful deliver. |
| `hard_failure_delta` | float | `-15.0` | Penalty for dispatch timeout (silent failure). |
| `soft_failure_delta` | float | `-5.0` | Penalty for deliver with error body (worker responded but failed). |
| `idle_recovery_delta` | float | `0.5` | Bump applied per idle recovery tick to workers sitting idle. |
| `idle_recovery_interval_sec` | int | `30` | How often the idle recovery loop runs. |
| `floor` | float | `0.0` | Minimum possible score. |
| `ceiling` | float | `100.0` | Maximum possible score. |
| `dispatch_threshold` | float | `10.0` | Minimum score required to be eligible for dispatch. Workers below this are skipped, with a fallback to the highest-scored worker if every candidate is below threshold. |

### `[heartbeat]` — Heartbeat expectations

| Key | Type | Default | Description |
|---|---|---|---|
| `expected_interval` | int | `5` | Seconds between expected heartbeats from each worker. |
| `miss_threshold` | int | `3` | Consecutive misses before the worker is considered degraded. |

### `[blacklist]` — Categorical blacklist policy

| Key | Type | Default | Description |
|---|---|---|---|
| `failure_threshold` | int | `3` | Failed dispatches in `failure_window` before blacklist. |
| `failure_window` | int | `300` | Seconds in which failures are counted. |
| `backoff_initial` | int | `30` | Initial backoff before re-probe. |
| `backoff_multiplier` | int | `2` | Exponential backoff multiplier. |
| `backoff_max` | int | `1800` | Maximum backoff cap. |

### `[probation]` — Re-admission policy

| Key | Type | Default | Description |
|---|---|---|---|
| `probation_jobs` | int | `3` | Successful jobs in a row required to leave probation. |

### `[readmit]` — Re-admit healthcheck

| Key | Type | Default | Description |
|---|---|---|---|
| `healthcheck_frame` | string | `ping` | Frame type used for the readmit healthcheck. |
| `healthcheck_timeout` | int | `5` | Healthcheck timeout in seconds. |

---

## 8. `api_health.ini` — Cloud API Probe Targets

Each section declares one cloud API endpoint that the orchestrator's `api_health` loop will ping periodically. State transitions (ok → degraded or degraded → ok) fire a `sysop_message` broadcast to all connected clients.

### Common keys (every probe target)

| Key | Type | Description |
|---|---|---|
| `url` | string | URL to GET (or POST per `method`). |
| `method` | string | HTTP method. Default `GET`. |
| `expect_status` | string | Comma-separated list of HTTP status codes that mean "healthy" (e.g., `200,401` for endpoints that return 401 unauthenticated but mean "API is up"). |
| `display_name` | string | Human-readable name for sysop dashboard and broadcast messages. |
| `api_key_env` | string | (Optional) env var with bearer token to send. |

### Shipped probe targets

| Section | Probes | Notes |
|---|---|---|
| `[anthropic]` | `https://api.anthropic.com/v1/models` | Returns 401 unauthenticated; we treat that as "alive". |
| `[openai]` | `https://api.openai.com/v1/models` | Same pattern. |
| `[huggingface]` | `https://api-inference.huggingface.co/` | Edge probe of the inference API hostname. |
| `[ollama_local]` | `http://localhost:11434/api/tags` | Local Ollama; remove for split-host deployments. |

---

## 9. `speech.ini` — Voice Loop Configuration

Browser speech recognition, wake word detection, and chunked audio upload.

### `[wake_word]`

| Key | Type | Default | Description |
|---|---|---|---|
| `enabled` | bool | `true` | Whether wake-word mode is on. |
| `word` | string | `HAL` | The wake word the user must say to start a query. |
| `timeout_sec` | int | `8` | Listening window after wake word detection. |

### `[whisper]`

| Key | Type | Default | Description |
|---|---|---|---|
| `mode` | string | `auto` | `auto`, `manual`, `disabled`. |
| `trigger` | string | `wake_word` | What triggers transcription: `wake_word`, `button`, `vad`. |
| `upload_mode` | string | `chunked` | `chunked` or `single`. Chunked is preferred for reliability. |
| `chunk_size_bytes` | int | `16384` | Per-chunk size for streaming upload. |

### `[chat]`, `[vision]`, `[imagine]`

Per-action speech routing rules. Reserved for future per-action voice tuning.

---

## 10. `logging.ini` — Logging Configuration

| Section | Key | Default | Description |
|---|---|---|---|
| `[console]` | `level` | `INFO` | Console log level. |
| `[console]` | `format` | `[%(asctime)s] %(name)s %(levelname)s: %(message)s` | Log format string. |
| `[file]` | `enabled` | `false` | Whether to also write logs to a file. |
| `[file]` | `path` | `data/rentahal.log` | Log file path if enabled. |
| `[ring]` | `size` | `5000` | In-memory ring buffer size for `/_debug/log`. |
| `[errors]` | `level` | `ERROR` | Error log level. |
| `[inference]` | `level` | `INFO` | Per-module level for inference workers. |
| `[client_chatter]` | `level` | `INFO` | Per-module level for client connections. |

---

## 11. `theme.ini` — GUI Theme

CSS variable values consumed by `gui/style.css`. Operators can rebrand the GUI by editing this file.

| Section | Keys |
|---|---|
| `[colors]` | `bg`, `bg_panel`, `fg`, `fg_dim`, `border`, `accent` |
| `[fonts]` | `ui`, `mono` |
| `[layout]` | `max_width`, `padding` |
| `[indicators]` | Color values for status indicators (online, offline, error, degraded) |

---

## Adding a New Configuration Value

The algebraic-design discipline requires that *every* new behavioral parameter be added to a configuration file before it is consumed by code. The pattern is always:

1. Add the key to the appropriate `.ini` file with an inline comment explaining what it does.
2. Read it in the code via `self.config.get_int(file, section, key, default)` (or `get_float`, `get`).
3. Provide a sensible defensive default in the `get_*` call so the code doesn't crash if an operator deletes the key.
4. Document the new key in this reference file.

If you find yourself writing a numeric literal in Python code, stop and add it to a `.ini` file instead. The discipline is what makes V2 maintainable; every shortcut around it is a small piece of design leaking into implementation that future you will have to clean up.

---

*See also: `ARCHITECTURE.md` for the system design that consumes this configuration. `README.md` for quick-start. `algebraic-design-paper.md` for the methodology rationale.*
