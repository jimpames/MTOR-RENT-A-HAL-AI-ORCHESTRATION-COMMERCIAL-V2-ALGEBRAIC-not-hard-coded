# RENTAHAL V2 — Deployment Guide

> **⚠️ STATUS: SPECULATIVE DRAFT — pending real-hardware validation**
>
> This document was drafted during the V2 build sprint *before* V2 had been deployed on production hardware. It reflects what we *expect* deployment to look like based on the architecture, the V1 deployment experience, and reasonable defaults. The author (Claude, in collaboration with Jim Ames) explicitly marked this as speculative because deployment guides are best written *after* a real deployment, when the actual friction points and recovery procedures are known.
>
> **Sections marked `TODO: vacation` are gaps where real deployment experience is needed before the section can be considered authoritative.** These should be filled in by Jim after the first real deployment on the three-RTX vacation array.
>
> The non-TODO sections are believed correct but are not yet battle-tested. Treat them as a starting point, not as gospel.

---

## 1. Audience and Scope

This guide is for an **operator** deploying RENTAHAL V2 on hardware they control. The expected deployment shape is:

- **One orchestrator** running on a head node with public network access (typically via ngrok tunnel or a standard reverse proxy)
- **One or more workers** running on compute nodes (RTX GPU boxes for local LLM/vision/SD/STT/TTS work, or smaller machines for cloud-API workers)
- **Workers connect outbound** to the orchestrator over WebSocket — no inbound firewall rules required on worker nodes
- **One database file** on the orchestrator's local filesystem (SQLite WAL)
- **Single tenant per orchestrator instance** — for multi-tenant deployments, run multiple orchestrator processes on different ports

This guide does **not** cover:
- Kubernetes deployment (V2 is intentionally simple enough that k8s is overkill — but see Section 9 for notes)
- Multi-region deployment (V2 is designed for single-region; cross-region is the licensee's problem)
- Database replication (SQLite is file-based; use filesystem snapshots for backup)
- Load balancing (one orchestrator per tenant; if you need to load-balance one tenant across multiple orchestrators, V2 is the wrong shape)

---

## 2. Prerequisites

### 2.1 Operating System

V2 has been built and tested on **Linux (Ubuntu 24.04)**. It should also work on:
- macOS (any recent version)
- Windows via WSL2

It will **not** work on bare Windows without WSL because some workers shell out to Unix binaries (espeak-ng, ffmpeg).

### 2.2 Python

V2 requires **Python 3.12 or newer**. Earlier versions will not work due to type-hint syntax.

```bash
python3 --version    # should show 3.12 or higher
```

### 2.3 Per-node dependencies

Each node — orchestrator and workers — needs:

```bash
pip install aiohttp aiofiles
```

Worker-specific dependencies are installed only on the nodes that run those workers:

| Worker | Dependency | Install command |
|---|---|---|
| `ollama.py` | Ollama daemon + a model | `curl https://ollama.ai/install.sh \| sh` then `ollama pull llama3` |
| `llava.py` | Ollama + llava model | `ollama pull llava` |
| `stable_diffusion.py` | A1111 webui running on `:7860` | See AUTOMATIC1111/stable-diffusion-webui README |
| `whisper.py` | `faster-whisper` package + a model | `pip install faster-whisper` |
| `gpt4all.py` | `gpt4all` package + a GGUF model | `pip install gpt4all` |
| `claude_api.py` | none beyond aiohttp | (none) |
| `openai_api.py` | none beyond aiohttp | (none) |
| `hf_api.py` | none beyond aiohttp | (none) |
| `tts_espeak.py` | `espeak-ng` system binary | `apt install espeak-ng` |
| `tts_coqui.py` | `TTS` package | `pip install TTS` |
| `tts_elevenlabs.py` | none beyond aiohttp | (none) |

### 2.4 Network

The orchestrator needs:
- One inbound TCP port (default 3000) reachable by browsers and workers
- Outbound HTTPS to whatever cloud APIs are configured in `api_health.ini` and `worker_endpoints.ini` (anthropic.com, openai.com, huggingface.co, elevenlabs.io)

Workers need:
- Outbound TCP to the orchestrator's port (default 3000)
- Outbound to whatever local services they wrap (Ollama on :11434, A1111 on :7860, etc.)
- Outbound HTTPS to cloud APIs they integrate with

There are no inbound network requirements on worker nodes. This is intentional and important: workers can run on home internet behind NAT, on consumer GPUs, on machines that aren't on the public internet.

---

## 3. Initial Deployment

### 3.1 Clone and unpack

```bash
git clone https://github.com/jimpames/rentahal-v2.git    # or unzip the release artifact
cd rentahal-v2
pip install -r requirements.txt
```

### 3.2 First-run sanity check

Run the test suite to verify nothing is broken on this machine:

```bash
python -m pytest tests/   # or run individual test files: python tests/test_phase51_backend.py
```

You should see all 207 tests pass. If they don't, do not proceed with deployment until you understand why. The test failures will tell you what's wrong (missing dependency, Python version, filesystem permissions).

> **TODO: vacation** — Validate this command on a fresh box. The actual test runner invocation may differ from `pytest` since the project uses standalone `python tests/test_*.py` scripts. Document the correct command after the first real test run.

### 3.3 Edit configuration

Read `CONFIG_REFERENCE.md` to understand what each `.ini` file controls. The minimum-viable changes for a new deployment:

**`config/orchestrator.ini`:**
- `[bus] host` — set to `0.0.0.0` for public access, `127.0.0.1` for local-only
- `[bus] port` — default 3000; change if you have a port conflict

**`config/worker_endpoints.ini`:**
- For each worker you plan to run, set `base_url`, `model`, and `api_key_env` as appropriate
- If your Ollama is on a different machine, point `[ollama] base_url` at it
- If your A1111 is on a different machine, point `[stable_diffusion] base_url` at it

**`config/api_health.ini`:**
- Comment out `[ollama_local]` if your orchestrator host doesn't run Ollama (otherwise the probe will spam degraded broadcasts)

**Environment variables:**
- `ANTHROPIC_API_KEY` — required if running `claude_api.py` worker
- `OPENAI_API_KEY` — required if running `openai_api.py` worker
- `HF_API_TOKEN` — required if running `hf_api.py` worker
- `ELEVENLABS_API_KEY` — required if running `tts_elevenlabs.py` worker

### 3.4 Start the orchestrator

```bash
python -m orchestrator
```

You should see startup logs ending with something like:

```
[INFO] bus listening on 0.0.0.0:3000
[INFO] dispatch_loop started
[INFO] timeout_loop started
[INFO] idle_recovery_loop started
[INFO] api_health probe loop started
```

Verify the bus is up:

```bash
curl http://localhost:3000/_debug/peers
# Expected: {"peers": []}
```

And the admin console:

```bash
curl http://localhost:3000/admin | head -20
# Expected: HTML output starting with <!doctype html>
```

### 3.5 Start a worker

In a separate shell on the same or a different machine:

```bash
python -m workers.echo --name echo_test_1
```

You should see the worker connect, register, and start its softping loop:

```
[INFO] connecting to ws://localhost:3000/bus
[INFO] hello sent
[INFO] welcomed by orchestrator
```

Now check the manifest:

```bash
curl http://localhost:3000/_debug/manifest
# Expected: worktypes including "echo" with live_workers >= 1
```

### 3.6 Smoke test the full path

Open `http://localhost:3000/` in a browser. You should see the V2 GUI. Pick action `chat`, worktype `echo`, type something, hit Submit. You should see your text echoed back as a result card.

If that works, the orchestrator and one worker are talking. Proceed to add more workers.

---

## 4. Adding Workers

The worker-startup pattern is always the same:

```bash
python -m workers.<module> --name <peer_id>
```

Each worker is a standalone process. Run as many as you want; they self-register on connect. If two workers register the same worktype, the dispatcher load-balances between them according to the configured `[scheduler] policy` in `orchestrator.ini`.

### 4.1 Local LLM (Ollama)

```bash
# On the GPU node:
ollama serve &
ollama pull llama3
python -m workers.ollama --name ollama_rtx1
```

### 4.2 Vision (Llava)

```bash
ollama pull llava
python -m workers.llava --name llava_rtx1
```

### 4.3 Stable Diffusion

```bash
# Start A1111 on :7860 separately, then:
python -m workers.stable_diffusion --name sd_rtx2
```

### 4.4 Whisper STT

```bash
pip install faster-whisper
python -m workers.whisper --name whisper_rtx1
```

### 4.5 Cloud workers

```bash
ANTHROPIC_API_KEY=sk-ant-... python -m workers.claude_api --name claude_cloud
OPENAI_API_KEY=sk-... python -m workers.openai_api --name openai_cloud
HF_API_TOKEN=hf_... python -m workers.hf_api --name hf_cloud
```

### 4.6 TTS workers

```bash
# Offline robotic TTS — needs `apt install espeak-ng`
python -m workers.tts_espeak --name tts_espeak1

# Offline neural TTS — needs `pip install TTS`
python -m workers.tts_coqui --name tts_coqui1

# Cloud premium TTS
ELEVENLABS_API_KEY=... python -m workers.tts_elevenlabs --name tts_eleven1
```

> **TODO: vacation** — Document any per-worker startup gotchas discovered on real RTX hardware. Specifically: GPU memory allocation, model loading time, A1111 cold-start timing, whisper model selection per node.

---

## 5. ngrok Tunnel for Public Access

V1 used ngrok to expose the orchestrator at `rentahal.com`. The same pattern works for V2.

### 5.1 Install ngrok

```bash
# https://ngrok.com/download
```

### 5.2 Authenticate

```bash
ngrok config add-authtoken <your token>
```

### 5.3 Reserve a domain (paid tier)

If you want a stable URL like `rentahal.com`, you need a reserved domain in your ngrok account, plus DNS pointing the domain at ngrok's edge.

> **TODO: vacation** — Document the exact ngrok domain reservation flow and DNS records required. Include the V1 setup notes if available.

### 5.4 Start the tunnel

```bash
ngrok http 3000 --domain=rentahal.com
```

The orchestrator's `/bus` WebSocket endpoint, `/admin` console, and `/` GUI are now reachable at `https://rentahal.com`.

### 5.5 WebSocket support

ngrok's free tier supports WebSocket out of the box. If you're using a different tunnel provider (Cloudflare Tunnel, Tailscale Funnel, etc.), verify WebSocket support before deploying.

> **TODO: vacation** — Document the actual production tunnel setup. Likely includes ngrok-specific config for keep-alive, header passthrough, and any rate limiting.

---

## 6. systemd Units (Linux)

For production, the orchestrator and workers should run as systemd services so they restart on failure and survive reboots.

### 6.1 Orchestrator unit

`/etc/systemd/system/rentahal-orch.service`:

```ini
[Unit]
Description=RENTAHAL V2 Orchestrator
After=network.target

[Service]
Type=simple
User=rentahal
WorkingDirectory=/opt/rentahal
ExecStart=/usr/bin/python3 -m orchestrator
Restart=on-failure
RestartSec=5
StandardOutput=append:/var/log/rentahal/orch.log
StandardError=append:/var/log/rentahal/orch.log

[Install]
WantedBy=multi-user.target
```

### 6.2 Worker unit (templated)

`/etc/systemd/system/rentahal-worker@.service`:

```ini
[Unit]
Description=RENTAHAL V2 Worker (%i)
After=network.target rentahal-orch.service

[Service]
Type=simple
User=rentahal
WorkingDirectory=/opt/rentahal
EnvironmentFile=/etc/rentahal/env
ExecStart=/usr/bin/python3 -m workers.%i --name %i
Restart=on-failure
RestartSec=5

[Install]
WantedBy=multi-user.target
```

### 6.3 Environment file

`/etc/rentahal/env`:

```bash
ANTHROPIC_API_KEY=sk-ant-...
OPENAI_API_KEY=sk-...
HF_API_TOKEN=hf_...
ELEVENLABS_API_KEY=...
```

### 6.4 Enable and start

```bash
systemctl daemon-reload
systemctl enable rentahal-orch
systemctl start rentahal-orch
systemctl enable rentahal-worker@ollama
systemctl start rentahal-worker@ollama
# repeat for each worker
```

> **TODO: vacation** — Validate these unit files on a real systemd system. The `%i` template instantiation may need adjustment, and the worker name vs module name distinction needs to be made cleaner. Likely the right shape is one unit file per worker module name with explicit naming, not a templated unit.

---

## 7. Multi-Node Deployment

For a deployment spanning multiple machines (e.g., one head node + three RTX compute nodes):

### 7.1 Head node (orchestrator)

The head node runs only the orchestrator. It needs no GPU. It needs a public IP (or an ngrok tunnel) so browsers can reach it.

### 7.2 Compute nodes (workers)

Each compute node runs whatever workers fit its hardware. RTX nodes typically run:
- One `ollama` worker (chat)
- One `llava` worker (vision)
- One `stable_diffusion` worker (imagine)
- Possibly one `whisper` worker (STT)
- Possibly one `tts_coqui` worker (premium TTS)

The cloud workers (claude_api, openai_api, hf_api, tts_elevenlabs) can run on any node — they don't need GPU. Often it makes sense to run them on the head node since they're lightweight.

### 7.3 Worker → orchestrator URL

Each worker reads its orchestrator URL from configuration. By default this is `ws://localhost:3000/bus`. For multi-node deployment, set the orchestrator URL via the worker's `--orch` flag (or environment variable):

```bash
python -m workers.ollama --name ollama_rtx1 --orch ws://head-node.local:3000/bus
```

> **TODO: vacation** — Verify the `--orch` flag exists on every worker module and that it accepts both `ws://` and `wss://` URLs. The SDK base class should handle this consistently. Add the flag if it's missing.

### 7.4 Network considerations

If the worker nodes can reach the orchestrator on a private network (LAN, VPN, Tailscale), use the private address. If they have to go over the public internet, use the public ngrok URL but be aware that every dispatch round-trip adds latency.

For voice loops where every additional 50ms matters, prefer LAN or VPN connections between the orchestrator and the workers.

---

## 8. Operational Runbook

### 8.1 Starting from cold

```bash
systemctl start rentahal-orch
# wait ~3 seconds
systemctl start rentahal-worker@ollama rentahal-worker@llava rentahal-worker@sd
# verify
curl -s http://localhost:3000/_sysop/workers | jq
```

### 8.2 Stopping

```bash
systemctl stop rentahal-worker@ollama rentahal-worker@llava rentahal-worker@sd
systemctl stop rentahal-orch
```

### 8.3 Reloading configuration without restart

Edit the `.ini` file, then:

```bash
curl -X POST http://localhost:3000/_sysop/reload
```

> **TODO: vacation** — Verify the reload endpoint actually exists and works for hot reload. If it doesn't, document a graceful-restart procedure.

### 8.4 Broadcasting a sysop message

```bash
curl -X POST http://localhost:3000/_sysop/broadcast \
  -H 'Content-Type: application/json' \
  -d '{"message": "scheduled maintenance in 5 minutes", "level": "warn"}'
```

Or use the broadcast composer in the `/admin` console.

### 8.5 Banning a misbehaving client

```bash
curl -X POST http://localhost:3000/_sysop/ban \
  -H 'Content-Type: application/json' \
  -d '{"peer_id": "client_abc123"}'
```

Or click the ban button in the user cost report on `/admin`.

### 8.6 Inspecting live state

```bash
curl http://localhost:3000/_debug/peers      # all connected peers
curl http://localhost:3000/_debug/manifest   # current capability manifest
curl http://localhost:3000/_debug/queue      # work queue
curl http://localhost:3000/_sysop/workers    # worker fleet with health scores
curl http://localhost:3000/_sysop/users      # user cost report
curl http://localhost:3000/_sysop/api_health # cloud API probe state
```

### 8.7 Tailing logs

The orchestrator's logs go to stdout (or wherever the systemd unit redirects them). For live tailing through the bus:

```bash
# WebSocket log stream (in a browser console or via wscat):
wscat -c ws://localhost:3000/_debug/log/stream
```

Or open the `/admin` console — it has a built-in log drawer.

### 8.8 Backup

The entire stateful surface of an orchestrator is two directories:

```
data/             — SQLite database, WAL files
payload_store/    — large blobs (images, audio uploads)
```

Backup is `tar czf rentahal-backup-$(date +%F).tar.gz data/ payload_store/`. Restore is `tar xzf` to the same paths.

For SQLite specifically, you should run `sqlite3 data/rentahal.db '.backup data/rentahal.db.bak'` rather than copying the file directly while the orchestrator is running, to ensure a consistent snapshot.

> **TODO: vacation** — Verify the backup procedure under real load. Document RPO/RTO expectations.

---

## 9. Notes on Container/Kubernetes Deployment

V2 is intentionally simple enough that running it in Docker is straightforward but rarely necessary for the target deployment shape (single-tenant per orchestrator on dedicated hardware). If you want containers anyway:

### 9.1 Dockerfile sketch

```dockerfile
FROM python:3.12-slim
RUN apt-get update && apt-get install -y espeak-ng
WORKDIR /app
COPY requirements.txt .
RUN pip install -r requirements.txt
COPY . .
EXPOSE 3000
CMD ["python", "-m", "orchestrator"]
```

### 9.2 Volumes

You **must** mount `data/` and `payload_store/` as volumes. Otherwise the container loses all state on restart.

```bash
docker run -d \
  -p 3000:3000 \
  -v rentahal-data:/app/data \
  -v rentahal-payloads:/app/payload_store \
  -e ANTHROPIC_API_KEY=$ANTHROPIC_API_KEY \
  rentahal-v2:latest
```

### 9.3 Kubernetes

V2's single-tenant-per-instance model maps to **one StatefulSet per tenant**, not a Deployment. You want stable hostnames for the orchestrators and persistent volumes for `data/` and `payload_store/`. Workers can be Deployments (stateless).

> **TODO: vacation** — Build and validate a real Dockerfile + docker-compose.yml + (optionally) k8s manifests. The above is a sketch.

---

## 10. Troubleshooting

### Orchestrator won't start

Check the logs. Common causes:
- Port 3000 already in use → change `[bus] port` in `orchestrator.ini`
- Database file permissions → ensure the user running the orchestrator can write to `data/`
- Missing Python dependency → `pip install -r requirements.txt`

### Worker connects but isn't in the manifest

- Check the orchestrator log for the `hello` frame
- Verify the worker's declared `worktype` matches a section in `worktypes.ini`
- Check `/_debug/peers` to see if the worker is in the peer table

### Submit returns "no eligible workers"

- Check the manifest: `curl http://localhost:3000/_debug/manifest`
- If `live_workers` is 0 for the requested worktype, no worker is registered
- If workers are registered but health_score is below `dispatch_threshold`, they're being filtered out — check `/_sysop/workers`

### TTS audio doesn't play in the browser

- Check that a `tts` worker is registered in the manifest
- Check that the speech-output checkbox is enabled in the GUI
- Check the browser console for autoplay restrictions (some browsers require user interaction before allowing autoplay)
- Check that the deliver body has `result_kind: audio_b64` and a non-empty `result`

### Health scores collapse to zero

- Check `/_sysop/workers` for `fail_count` per worker
- If a worker is taking repeated hard failures, it's silently timing out — check the worker's logs
- If a worker is taking soft failures, it's responding with errors — check the deliver bodies in the orchestrator log
- The `idle_recovery_loop` will eventually restore scores; if it's not, check `health.ini [scoring] idle_recovery_delta`

### Cloud API probes flap

- Check `/_sysop/api_health` for the probe target's `last_error`
- Verify the API key is set correctly in the env var
- Increase `[api_health] fail_threshold` if the API has occasional 500s and the alerts are too noisy

> **TODO: vacation** — Add real troubleshooting cases discovered during the first deployment. Include log excerpts and resolution steps.

---

## 11. What's Missing From This Guide

This guide is **explicitly incomplete**. Sections that need real-deployment validation are marked `TODO: vacation`. Additional topics that should be covered after the first real deployment:

- **Capacity planning** — how much RAM, CPU, GPU memory, network bandwidth per worker type
- **Latency budgets** — what to expect end-to-end for voice loop, image generation, chat
- **Scaling guidance** — when to add a second worker of the same type, when to add a second orchestrator
- **Upgrade procedure** — how to move from V2.x to V2.y without losing the cost ledger (will require Phase 5.8 schema migrations)
- **Monitoring integration** — Prometheus exporter, Grafana dashboards, alerting hooks
- **Security hardening** — TLS termination, sysop endpoint authentication, API key rotation, rate limiting
- **Disaster recovery** — RTO/RPO targets, backup verification, restore drills

These will be added in future revisions as real deployment experience accumulates.

---

*See also: `README.md` for quick-start. `CONFIG_REFERENCE.md` for configuration. `ARCHITECTURE.md` for design rationale. `algebraic-design-paper.md` for methodology.*
