# RENTAHAL V2 — Architecture

This document describes the internal design of RENTAHAL V2 — what its components are, how they relate, and where each architectural pattern comes from. It is intended for engineers who want to *understand* V2 rather than just operate it. For operational reference, see `CONFIG_REFERENCE.md`. For quick-start, see `README.md`. For the methodology that produced V2, see `algebraic-design-paper.md` and the *Applied Algebraic Design for Agentic AI* book.

## 1. The One-Sentence Description

RENTAHAL V2 is a **stateless event-driven multi-tenant orchestrator** that dispatches work from connected clients to autonomous workers over a custom WebSocket bus, accumulates a durable cost ledger of completed work, and exposes the running system to operators through a sysop console — all driven entirely by `.ini` configuration with zero hardcoded behavioral constants in Python.

## 2. Mainframe Ancestry

V2 is not a from-scratch design. It is a deliberate modernization of architectural patterns proven correct in IBM mainframe systems of the 1970s and 1980s. The hardware changed; the abstractions did not. Each major V2 component has a named ancestor:

| V2 Component | Mainframe Ancestor | What's Borrowed |
|---|---|---|
| `work_queue` table + dispatcher | **JES2** (Job Entry Subsystem) | Temporal work spool, class-of-service routing, completion ledger, paid/serviced/stale state model |
| `peers` table + manifest builder | **VTAM SSCP/PU/LU** | Resource definition, dynamic LU registration, capability tables (MODE), session binding |
| Replay-on-reconnect via `events` table | **CICS pseudo-conversational state** | Suspended transaction context, durable user identity through reconnect, opt-in resume |
| `softping` frame + dispatch timeout | **SNA pacing** | Receiver-controlled flow, explicit pacing window, no flooding |
| Numeric `health_score` + dispatch_threshold | **MVS WLM** (Workload Manager) | Continuous capability metric, class-of-service scheduling, idle decay, threshold filtering |
| `dispatch → softping* → deliver` conversation | **APPC/APPN LU 6.2** | Session-scoped half-duplex conversation, end-bracket on completion |
| `peer_id` durable identity | **VTAM LU name** | Logical unit identity that survives physical reconnect |
| Per-licensee orchestrator instances | **VM/370 guests** | Tenant isolation through separate kernels rather than shared multi-tenancy |

These analogies are **load-bearing**, not decorative. When we needed to design the worker selection algorithm, we asked "what would MVS WLM do" and the answer (sort by capability, weight more than load, threshold filter, idle decay) is exactly what `dispatcher._select_worker()` implements. When we needed to design the replay-on-reconnect flow, we asked "what would CICS do" and the answer (persist events, mark delivered=0 until acknowledged, opt-in resume on reconnect) is exactly what the welcome frame and event log implement. The mainframe ancestors solved these problems under harder constraints than V2 faces today, and their solutions are still the right shape.

## 3. The Three-Tier Topology

V2 is intentionally simple at the topology level:

```
   ┌────────────────────────────────────────────────────────────┐
   │                       BROWSER (GUI)                         │
   │  index.html · admin.html · bus.js · ui.js · speech.js     │
   └────────────────┬─────────────────────────┬─────────────────┘
                    │                         │
                    │ WebSocket               │ HTTP
                    │ /bus                    │ /admin, /_sysop/*
                    │                         │ /_debug/*
                    ▼                         ▼
   ┌────────────────────────────────────────────────────────────┐
   │                      ORCHESTRATOR                           │
   │   Bus    Dispatcher    Database    ApiHealth    Config     │
   │   ────   ──────────    ────────    ─────────    ──────     │
   │   :3000  Health-       SQLite      Probe loop   .ini       │
   │   WS     weighted      WAL         Sysop alerts loader     │
   │          scheduling    Ledger                   Hot reload │
   └────────────────────────────┬───────────────────────────────┘
                                │
                                │ WebSocket /bus
                                │
              ┌─────────────────┼──────────────────┐
              │                 │                  │
              ▼                 ▼                  ▼
        ┌──────────┐      ┌──────────┐       ┌──────────┐
        │  WORKER  │      │  WORKER  │       │  WORKER  │
        │  ollama  │      │   sd     │       │   tts    │
        │  (RTX-1) │      │  (RTX-2) │       │  (RTX-3) │
        └──────────┘      └──────────┘       └──────────┘
```

Three observations about this topology:

1. **The orchestrator binds a single port (3000 by default).** GUI traffic, WebSocket bus traffic, sysop endpoints, debug endpoints, and the admin console all multiplex through that one port. There is no separate "control plane" — the control plane is part of the same port. This makes deployment radically simpler: one port to expose, one ngrok tunnel, one firewall rule.

2. **Workers connect *to* the orchestrator, not the other way around.** The orchestrator never initiates a connection to a worker. Workers self-register on connect via the `hello` frame, declare their capabilities, and live on the bus until they disconnect. This is the same pattern as VTAM logical units: the SSCP (orchestrator) maintains the resource table, but the LUs (workers) bind themselves to the SSCP through ACTLU. Operationally, this means workers can run behind NAT, on home internet connections, on consumer GPUs, anywhere they can reach the orchestrator's WebSocket endpoint. There is no inbound firewall rule on the worker side.

3. **There is no message broker.** No Redis, no RabbitMQ, no Kafka, no Celery. The bus *is* the message broker, and it lives in the orchestrator process. State persists in SQLite. This eliminates an entire class of infrastructure dependency and an entire class of distributed-systems bug. The trade-off is that the orchestrator is a single point of failure for its tenant — but tenants are *separate* deployments, so a failure of one orchestrator does not affect any other tenant. This is the VM/370 isolation model, not the multi-tenant SaaS model.

## 4. The Frame Protocol

V2 defines a **14-frame protocol** modeled on SNA LU 6.2 conversation semantics. Every interaction over the bus is one of these frame types:

| Frame | Direction | Purpose |
|---|---|---|
| `hello` | client → orch | Peer registration with capabilities |
| `welcome` | orch → client | Manifest + heartbeat interval + replay offer + user totals |
| `heartbeat` | client → orch | Liveness signal |
| `submit` | client → orch | Work submission |
| `dispatch` | orch → worker | Work assignment |
| `softping` | worker → orch | "Still working, extend my timeout" |
| `deliver` | worker → orch → client | Result delivery (with cost, processing_ms, worker_peer) |
| `chunk` | client → orch | Streamed payload upload (for audio/image) |
| `error` | any → any | Error reporting with reason |
| `manifest_update` | orch → all | Manifest changed (worker came/went) |
| `replay_request` | client → orch | "Send me my undelivered results" |
| `replay_dismiss` | client → orch | "Dismiss my undelivered results" |
| `set_nickname` | client → orch | Set display name |
| `sysop_message` | orch → all | Operator broadcast (warn/info/error) |

Every frame is JSON over WebSocket text, with a consistent envelope: `{ type, ngram, body }`. The `ngram` field is the session correlation token (the LU 6.2 conversation id, conceptually). The `body` is a JSON object whose schema depends on the frame type.

The protocol is small enough to fit in your head. There are no nested protocols, no sub-protocols, no optional extensions. Adding a new frame type requires editing `orchestrator/frames.py` and the bus's frame dispatch table — this is the one place in V2 where the homomorphism is incomplete and a code edit is required to add new behavior. This is by design: the protocol is the one part of the system that must be globally consistent.

## 5. Component-by-Component

### 5.1 The Bus (`orchestrator/bus.py`)

The bus is the WebSocket server, the HTTP server, and the peer registry, all in one module. It is the **JES2 spool + VTAM SSCP** rolled together.

Responsibilities:
- Accept WebSocket connections at `/bus`
- Parse incoming frames, validate envelope, dispatch by type
- Maintain the live peer table (`self.peers` dict) — every connected peer's WebSocket is here
- Build and broadcast the manifest (`build_manifest()`)
- Serve HTTP routes for the GUI, the admin console, the sysop endpoints, and the debug endpoints
- Persist all events to the database for replay
- Run background tasks: `chunk_cleanup_loop`, `idle_recovery_loop` (via dispatcher), `api_health.run_loop`

The bus does **not** make routing decisions. That's the dispatcher. The bus is the I/O layer; the dispatcher is the policy layer.

Key methods:
- `handle_hello` — peer registration, sets state to online, emits manifest update if a worker joined
- `handle_submit` — invoice creation, work_queue insertion, ban check, query_count increment
- `handle_deliver` — delegate to dispatcher (which settles the invoice and forwards to source)
- `handle_softping` — delegate to dispatcher (which extends the timeout)
- `broadcast_sysop` — fan-out a sysop_message frame to all connected clients
- `serve_admin` — serve `gui/admin.html` from `/admin`

### 5.2 The Dispatcher (`orchestrator/dispatcher.py`)

The dispatcher is the **MVS WLM + JES2 initiator** module. It owns the policy decisions about which worker gets which work, when work times out, and how worker health scores evolve over time.

Responsibilities:
- `dispatch_loop` — pick pending work from the queue and assign it to eligible workers
- `_select_worker` — implement the four scheduler policies (round_robin, random, least_loaded, health_weighted) with the dispatch_threshold filter
- `handle_deliver` — settle the invoice on success, apply health score delta (success/soft-failure), forward result to source peer
- `_handle_timeout` — apply hard-failure score delta, retry or fail terminally based on retry_max
- `idle_recovery_loop` — bump idle workers' scores back toward ceiling
- `replay_for(peer_id)` — fetch undelivered events for a reconnecting peer

The dispatcher is **stateless across processes**. All its state (work queue, peer health scores, retry counts) lives in the database. If the orchestrator restarts, the dispatcher resumes from where it left off — undelivered work waits in the queue, peer scores are preserved.

Worker selection algorithm (in `_select_worker`):

```
1. Query workers_by_capability(worktype, only_online=True)
2. Filter to peers actually live on the bus
3. Filter out blacklisted/probation-failing
4. Apply dispatch_threshold filter:
   - eligible = [w for w in live if w.score >= threshold]
   - if no eligible: fall back to highest-scored single worker
5. Apply policy:
   - round_robin: cursor++ mod len
   - random: random.choice
   - least_loaded: sort by in-flight count
   - health_weighted: sort by (-score, in_flight)
6. Return the chosen peer_id
```

Health score updates happen in three places:
- **Success** (handle_deliver, no error): `+success_delta`, `success_count++`
- **Soft failure** (handle_deliver, error body): `soft_failure_delta`, `fail_count++`
- **Hard failure** (timeout_loop): `hard_failure_delta`, `fail_count++`
- **Idle recovery** (idle_recovery_loop): `+idle_recovery_delta` for workers with no in-flight work

All deltas come from `health.ini [scoring]`. Zero hardcoded constants.

### 5.3 The Database (`orchestrator/db.py`)

V2's persistence layer. SQLite WAL by default. The interface is a typed protocol; the SQLite implementation is one driver. Adding a Postgres driver means writing `db_postgres.py` and changing `[db] driver` in `orchestrator.ini`.

Tables (from `orchestrator/schema.sql`):

```
peers             — durable identity for clients and workers
                    columns: peer_id, role, capabilities, first_seen, last_seen,
                             state, failure_count, backoff_until, metadata,
                             nickname, query_count, banned,
                             health_score, success_count, fail_count
                    indexes: idx_peers_role_state, idx_peers_role_health

work_queue        — pending and dispatched work
                    columns: id, worktype, action, source_peer, payload_ref,
                             priority, created_at, state, body_json,
                             worker_peer, dispatched_at, completed_at,
                             retry_count, last_error
                    indexes: idx_work_state, idx_work_worker

invoices          — the cost ledger (paid = serviced = stale)
                    columns: work_id, source_peer, worktype, state,
                             created_at, paid_at, cost_units
                    indexes: idx_invoices_source, idx_invoices_state

events            — frame log for replay-on-reconnect
                    columns: id, ngram, frame_type, originator, target,
                             body, created_at, delivered
                    indexes: idx_events_target_delivered

payloads          — large blobs (image attachments, audio uploads)
                    columns: ref, sha256, size_bytes, mime_type,
                             inline_data, on_disk_path, created_at
```

The `state` column on `work_queue` is the dispatcher's state machine: `pending → dispatched → completed` (success path) or `pending → dispatched → failed_retry → pending` (retry loop) or `pending → dispatched → failed_terminal` (giving up after retry_max).

The `state` column on `invoices` is the ledger state machine: `open → paid` (success path) or `open → void` (failure path). **Paid means serviced means stale.** This is the JES2 SYSOUT purge model.

### 5.4 The Config Loader (`orchestrator/config.py`)

The `Config` class loads all eleven `.ini` files at startup, indexes them by filename and section, and exposes typed getters:

```python
config.get(file, section, key, default)        # string
config.get_int(file, section, key, default)    # int
config.get_float(file, section, key, default)  # float
config.get_bool(file, section, key, default)   # bool
config.all_sections(file)                      # dict[section_name, dict[key, value]]
```

Hot reload is supported via `Config.reload()`, which is called by the `/_sysop/reload` HTTP endpoint. After reload, every subsequent `get_*` call returns the new value. There is no caching that would prevent the reload from being seen.

This single class is the **algebraic-design discipline made concrete**. Every behavioral parameter in the entire system passes through these five getters. There is no other mechanism by which the kernel reads operational values. If you grep the codebase for numeric literals in `.py` files, the only matches are array indices, sentinel values, and the defensive defaults to these getters. No magic numbers.

### 5.5 The API Health Probe (`orchestrator/api_health.py`)

The **VTAM PNG / NetView monitor** module. Reads probe targets from `api_health.ini`, pings each on a configurable interval, broadcasts a sysop_message on state transitions.

Key design choices:
- **Probes inform, they do not decide.** A degraded probe target does not remove workers from the manifest. It only informs operators via sysop broadcast and shows up in the admin console. Worker availability is determined by worker self-registration; probes are pure observation.
- **Transitions, not snapshots.** The probe loop only broadcasts when a target's state *changes* (ok→degraded or degraded→ok). A target that has been degraded for an hour does not flood users with warnings every 60 seconds.
- **Unknown→ok is silent.** On startup, the first successful probe of a healthy target does not broadcast (no startup noise). Unknown→degraded *does* broadcast (operators want to know on restart if something was already broken).

### 5.6 The Workers (`workers/*.py`)

Thirteen worker modules ship in V2:

| File | Worktype | Engine | Notes |
|---|---|---|---|
| `echo.py` | echo | trivial | Bus + dispatcher smoke test |
| `ollama.py` | llama | local Ollama | Default chat backend |
| `llava.py` | llava | local Ollama vision | Default vision backend |
| `stable_diffusion.py` | sd | A1111 webui | Default imagine backend |
| `whisper.py` | stt | faster-whisper | Default speech-to-text |
| `whisper_stub.py` | stt | none | Test fixture, returns canned text |
| `gpt4all.py` | gpt4all | gpt4all native | Alternate local LLM |
| `claude_api.py` | claude_api | Anthropic API | Cloud chat |
| `openai_api.py` | openai_api | OpenAI API | Cloud chat |
| `hf_api.py` | hf_api | HuggingFace Inference | Cloud chat |
| `tts_espeak.py` | tts | espeak-ng binary | Offline robotic TTS |
| `tts_coqui.py` | tts | coqui TTS package | Offline neural TTS |
| `tts_elevenlabs.py` | tts | ElevenLabs API | Cloud premium TTS |

Every worker:
1. Subclasses `Worker` from `workers/sdk.py`
2. Reads its configuration from `worker_endpoints.ini` via `load_config()`
3. Declares its capabilities (which worktypes it implements)
4. Implements `async def handle(work_id, body) -> dict` returning `{result, result_kind, ...}` or `{result: None, error: ...}`
5. Connects to the orchestrator via WebSocket and self-registers via `hello`
6. Receives `dispatch` frames, runs `handle()`, returns `deliver` frames

Three TTS workers share one worktype (`tts`). The dispatcher distinguishes them only by `peer_id`. The cost difference (espeak/coqui = free, elevenlabs = $0.030) is handled by the elevenlabs worker stamping `cost_units` in its deliver body, which the dispatcher respects (Phase 5.6 enhancement).

Adding a new worker is the canonical demonstration of the algebraic-design homomorphism: one section in `worker_endpoints.ini`, one Python file under `workers/` (typically 100-200 lines subclassing `Worker`), zero kernel edits.

### 5.7 The GUI (`gui/`)

Vanilla HTML + CSS + JavaScript, no build step, no framework, no transpiler. Five files:

| File | Purpose |
|---|---|
| `index.html` | The user-facing GUI. Status, sysop banners, instructions, nickname, action/worktype dropdowns, drop zone, results history, debug drawer. |
| `style.css` | All styling. Theme variables consumed from `theme.ini` via `/_theme.css`. |
| `bus.js` | WebSocket client. Connects, sends/receives frames, exposes events, handles reconnect-with-replay. |
| `ui.js` | DOM rendering. Subscribes to bus events, renders result cards, manages drop zone, handles speech output auto-route. |
| `speech.js` | Browser speech recognition + wake word + chunked audio upload to whisper worker. |
| `admin.html` | The operator console. API health, worker fleet, broadcast composer, user cost report. Standalone HTTP-polling page. |

The GUI is intentionally simple. There is no React, no Svelte, no Vue. The entire user GUI is roughly 1500 lines of code total. A licensee who wants to rebrand the GUI edits `theme.ini` for colors/fonts and (optionally) `index.html` for layout. No build pipeline to learn, no framework to upgrade, no node_modules to maintain.

## 6. The Speech-First Loop

V2's most distinctive end-to-end behavior is the voice loop. Here is the full path of a single voice query:

```
1. User says "HAL chat tell me about Apollo 11"
2. Browser SR (Chrome's speechRecognition API) detects wake word "HAL"
3. speech.js starts MediaRecorder, captures microphone audio
4. On silence, MediaRecorder stops, audio bytes captured
5. speech.js base64-encodes the audio in chunks
6. bus.js sends chunk frames over WebSocket → orchestrator
7. Orchestrator buffers chunks, assembles into payload, creates work_queue entry
8. Dispatcher routes to a whisper worker
9. Whisper worker transcribes → "tell me about Apollo 11"
10. Whisper worker returns deliver with transcribed text
11. ui.js receives transcription, runs inferAction → action=chat, instruction="tell me about Apollo 11"
12. ui.js submits a new work item via bus.submit('chat', 'llama', ...)
13. Dispatcher routes to ollama worker
14. Ollama generates text response
15. Deliver arrives at GUI as text result card
16. *** Phase 5.6 magic ***
17. ui.js detects: speech output enabled + text result + worktype != tts
18. ui.js fires bus.submit('chat', 'tts', text)
19. ui.js queues current result card as awaiting audio
20. Dispatcher routes to a tts worker (espeak/coqui/elevenlabs)
21. TTS worker synthesizes audio → audio_b64
22. Deliver arrives at GUI with result_kind = audio_b64
23. ui.js pops front of pendingAudioCards queue
24. ui.js attaches <audio autoplay> with data:audio/wav;base64,... to the original card
25. User hears the answer spoken back
```

Every step is real, every step is tested. The full loop is the **MTOR (Multi-Tronic Operating Realm)** experience that V1 pioneered and V2 reconstructed cleanly.

## 7. Multi-Tenancy and Isolation

V2 is **single-tenant per orchestrator instance**. There is no cross-tenant routing, no shared resource pool across tenants, no quota system. Multi-tenancy is achieved by running **one orchestrator per licensee**, each with its own `data/`, `payload_store/`, `config/`, and worker fleet.

This is the **VM/370 model**: tenants are isolated through separate kernels rather than through shared multi-tenancy in a single kernel. The trade-offs:

**Advantages:**
- Zero possibility of cross-tenant data leakage. There is no shared storage to leak through.
- Tenant-specific configuration is just a different `config/` directory. Tenants can run different scheduler policies, different worker fleets, different cost models.
- A bug or compromise in one tenant cannot affect another tenant.
- Licensees own their data fully. The orchestrator runs on hardware they control.
- Upgrade is per-tenant. A licensee can stay on V2.x while another moves to V2.y.

**Trade-offs:**
- Resource pooling across tenants is impossible (each tenant runs its own GPU fleet).
- Cross-tenant analytics require external aggregation.
- Operator overhead scales linearly with tenant count.

For V2's target market (commercial licensees who need isolation, audit, and predictable cost), these trade-offs are correct. For SaaS-style high-density multi-tenancy, V2 is the wrong shape and a different system would be needed.

## 8. Concurrency Model

V2 is **async Python (asyncio) in a single process per orchestrator instance**. The bus, dispatcher, db, and api_health all run as cooperatively-scheduled coroutines on one event loop. Background tasks (`dispatch_loop`, `timeout_loop`, `idle_recovery_loop`, `chunk_cleanup_loop`, `api_health.run_loop`) are launched at startup via `asyncio.create_task`.

The database (SQLite) uses a thread lock to serialize writes from the async event loop. Read-heavy operations are non-blocking thanks to WAL mode.

Workers run in **separate processes**, one per worker. They communicate with the orchestrator only over WebSocket. This means workers can run on different machines, different OSes, with different Python versions, different dependencies — the only shared contract is the frame protocol.

There is no thread pool, no fork pool, no process pool inside the orchestrator. The orchestrator does not run user code in-process; it dispatches all heavy computation to separate worker processes. This keeps the orchestrator's footprint small (typically <100 MB RAM) and its tail latency predictable.

## 9. Failure Modes and Recovery

### Worker crashes mid-job

The orchestrator notices via the dispatch timeout (`scheduler.dispatch_timeout_sec`, default 120s). The work item is marked failed_for_retry, retry_count is incremented, and on the next dispatch_loop tick the work is re-claimed and routed to a different eligible worker. If retry_count reaches `worktypes.<wt>.retry_max`, the work fails terminally and a failure deliver is sent to the source client.

The worker's health score takes a `hard_failure_delta` (-15 by default) on the timeout, which may push the worker below the dispatch_threshold and exclude it from future dispatch until it recovers via idle recovery.

### Client disconnects mid-job

The work continues running on the worker. When the worker delivers, the result lands in the events table marked `delivered=0` because the source client is not on the bus. When the client reconnects (with the same `peer_id`, persisted in browser localStorage), the welcome frame includes `undelivered_count`, and the client can opt to replay via `replay_request`. This is the **CICS pseudo-conversational** behavior.

### Orchestrator restarts

All state lives in SQLite. On restart, the dispatcher resumes from where it left off — pending work waits in the queue, peer scores are preserved, undelivered events wait for clients to reconnect. Workers and clients reconnect on their own (via reconnect logic in the SDK and bus.js). The whole system self-heals within seconds.

### Cloud API outage

The API health probe loop detects the outage on the next probe cycle (within `api_health.interval_sec`, default 60s) and broadcasts a sysop_message warning to all connected clients. Workers using the affected API still attempt their dispatched work and return error bodies, which take soft-failure score penalties. Operators can ban the cloud worker via `/_sysop/ban` if they want to take it offline manually until the API recovers.

### Database corruption

SQLite WAL is fairly robust, but if the database is unrecoverable, the orchestrator fails fast at startup. The `data/` directory can be backed up with standard filesystem tools; restoring is a `cp`. There is no migration framework yet (Phase 5.8 — pending). When that lands, schema upgrades will be versioned and reversible.

## 10. The Tested Surface

V2 ships with **207 test cases across 21 test files**, all passing. The breakdown:

| Component | Test Files | Tests |
|---|---|---|
| Worker integration (10 workers + chunk upload) | 10 | 105 |
| Phase 5.1 GUI parity (backend + GUI DOM-stub) | 2 | 35 |
| Phase 5.2-5.4 admin console + API health probe | 2 | 18 |
| Phase 5.5 numeric worker health scoring | 1 | 13 |
| Phase 5.6 TTS workers + speech output GUI | 4 | 47 |
| Speech parser, whisper glue, wake-word combo | 3 | 20 |
| **Total** | **21** | **207** |

The tests are not unit tests against mocked-out dependencies. They are **integration tests** that spawn real orchestrator subprocesses, real worker subprocesses, real WebSocket clients, and assert on actual deliver bodies. Mock cloud APIs are stood up as local HTTP servers when needed (for claude_api, openai_api, hf_api, elevenlabs). Mock binaries and Python packages are injected via PATH/PYTHONPATH for espeak and coqui (which aren't installed in the test container). The result is high-fidelity testing without external service dependencies.

Tests are **parameterized over the configuration** the same way the code is. A health-scoring test asserts that the score went down by `hard_failure_delta`, not by 15. If an operator changes the constant in `health.ini`, the tests still pass. This is the algebraic-design property reflected in test code: tests verify the relationship between configuration and behavior, not arbitrary values.

## 11. What V2 Is Not

To set expectations correctly:

- **V2 is not a chain composer.** It does not implement ReAct loops, tool-use reasoning, or arbitrary chain topologies. If you need a multi-step agent, build it inside a worker that exposes a single capability.
- **V2 is not a research framework.** It is targeted at production multi-tenant deployment of voice-first AI workloads. For greenfield experimentation with novel agent architectures, use LangChain or AutoGen.
- **V2 is not multi-tenant in one process.** One orchestrator = one tenant. Run multiple orchestrators for multiple tenants.
- **V2 does not include user authentication** beyond the peer_id durable identity model. If you need OAuth/SSO/SAML, you wrap the orchestrator behind a reverse proxy that handles auth.
- **V2 does not include billing integration.** It includes the cost ledger (the `invoices` table), which gives you the data needed to bill, but the billing system itself is the licensee's responsibility.
- **V2 is not yet schema-migration-aware.** Phase 5.8 (pending) will add versioned migrations. Until then, schema changes require manual SQL.

## 12. The Methodology

Everything above is a *consequence* of the methodology, not the cause. RENTAHAL V2 looks the way it does because it was built under the **algebraic systems design** discipline:

1. **Zero hardcoded behavioral constants** in implementation code.
2. **Configuration as the executable specification** — `.ini` files are the contract, the source code is the homomorphism.
3. **Code structure mirrors configuration structure** — adding a new capability is one config section + one localized file, never a kernel edit.

Every other architectural property of V2 — the maintainability, the testability, the licensee onboarding cost, the operator transparency, the 24-hour build sprint speed — is downstream of these three rules. The methodology is documented in Ames (2026), *Applied Algebraic Design for Agentic AI: Game Engine Methods*, available as free PDF in the V1 GitHub repository. The companion paper `algebraic-design-paper.md` (in this directory) explains how the methodology applies specifically to V2 and contrasts it with contemporary AI orchestration frameworks.

---

*See also: `CONFIG_REFERENCE.md` for the authoritative configuration reference. `README.md` for quick-start. `DEPLOYMENT.md` for deployment guide. `algebraic-design-paper.md` for the methodology rationale.*
