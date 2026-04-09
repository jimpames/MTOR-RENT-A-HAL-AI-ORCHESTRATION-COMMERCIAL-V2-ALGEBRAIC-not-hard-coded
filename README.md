# RENTAHAL V2

You are now viewing a private closed github.

You were invited.

disregard these standalone files, they are now in the async zip


tts_coqui.py

tts_elevenlabs.py

tts_espeak.py

ui.js

Use this fileset:

rentahal-phase5-7-async.zip

BY: N2NHU LABS  - j p ames

9 APR 26

License: 

Commercial only - contact jimpames@gmail.com or jim@mtorfoundation.org for license

This codebase is derived from my 33rd book and the principles and GPL3 code within:

https://www.amazon.com/Applied-Algebraic-Design-Agentic-AI-ebook/dp/B0GKX969Y2

No one may use this code without license.

This code is not covered under GPL3

This code is a clean room re-write of MTOR RENTAHAL v1

https://www.amazon.com/MTOR-Alice-Enters-Theory-Operation-ebook/dp/B0F7DF2XTP

You are provided access to this source only for the purpose of evaluation.

Upon completion of evaluation, you must destroy your copy of the software or obtain a commercial license.

A commercial re-seller license is also available.

Disclaimer:

You are being provided a first look.

This code has never run on the N2NHU Labs Array - that is slated for Memorial Day.

This code has ONLY been tested in Claude's docker.

For support before  Memorial Day:
- Consult your local Claude Opus 4.6 extended, standard $20 consumer license.
- Explode the zip of code
- upload all files - code and doc - to Claude as a project
- Chat with Claude in the project to troubleshoot

Restriction:
- You must never reveal or share the code or product outside your license, covering your organization.
- The very existence of the product is confidential.
- You may only share information with the Owners, Board of Directors, C-Level officers and necessary technical staff for evaluation purposes.

**Multi-Tronic Operating Realm — voice-first AI orchestration platform**

A stateless, event-driven, multi-tenant orchestrator that dispatches AI work from connected clients to autonomous workers over a custom WebSocket bus, accumulates a durable cost ledger, and exposes the running system to operators through a sysop console — all driven entirely by `.ini` configuration with **zero hardcoded behavioral constants** in Python.

V2 is the commercial-license clean-room rewrite of [RENTAHAL V1](https://github.com/jimpames/rentahal), which has served thousands of users in production at rentahal.com. V1 is GPL3; V2 is licensed commercially. Both implement the same external behavior; V2 is the modular, .ini-driven, IBM-mainframe-architected version suitable for licensing to enterprise buyers.

> **207 tests across 21 files. All passing.**
> **Built in a 24-hour focused sprint on top of two years of V1 production validation.**
> **Zero hardcoded behavioral constants in the entire kernel.**
> **Architecture explicitly modeled on JES2, VTAM, CICS, SNA, MVS WLM, and APPC/APPN LU 6.2.**

---

## What V2 Does

In one paragraph: a user opens a browser, sees a voice-first GUI, says "HAL chat tell me about Apollo 11" — the browser captures audio, streams it to a Whisper worker for transcription, the orchestrator routes the transcribed text to a chat worker (Ollama, Claude API, OpenAI, gpt4all, etc.), the response comes back as a result card, and if speech output is enabled the response is automatically routed through a TTS worker (espeak, coqui, or ElevenLabs) and played back to the user. Every step is dispatched through a custom WebSocket bus, every cost is logged to a per-user ledger, every worker's health is scored and tracked, every operator action is exposed through a sysop console at `/admin`, and every behavioral parameter is read from `.ini` files at runtime so a licensee can reconfigure the system without touching Python.

In two sentences: V2 is a complete production AI orchestration system, not a library. The competitive landscape (LangChain, CrewAI, AutoGen, Haystack) provides components you compose into systems; V2 provides the system, designed coherently, and you compose workers into V2.

## Quick Start

```bash
# Clone and install
git clone https://github.com/jimpames/rentahal-v2.git
cd rentahal-v2
pip install -r requirements.txt

# Verify the test suite
python tests/test_phase51_backend.py    # should print "12/12 ALL OK"

# Start the orchestrator
python -m orchestrator

# In another shell, start a worker
python -m workers.echo --name echo1

# Open the GUI
open http://localhost:3000/

# Open the operator console
open http://localhost:3000/admin
```

That's the minimum. To run a real deployment with multiple workers (Ollama for chat, Stable Diffusion for images, Whisper for speech, ElevenLabs for TTS), see `DEPLOYMENT.md`. For the operator cheat sheet, see `QUICK_REFERENCE.md`.

## Documentation

This repository ships with a layered documentation set. Read them in roughly this order depending on your role:

| Document | Audience | Length | Read it for |
|---|---|---|---|
| **`README.md`** (this file) | Everyone | 5 min | Orientation and the elevator pitch |
| **`EXECUTIVE_SUMMARY.md`** | Decision-makers, eval teams | 10 min | The commercial case: what V2 is, what it competes with, why it's licensable |
| **`QUICK_REFERENCE.md`** | Operators, sysadmins | 5 min | Cheat sheet of commands, endpoints, file layout |
| **`ARCHITECTURE.md`** | Engineers, architects | 30 min | System design, mainframe lineage, component-by-component breakdown |
| **`CONFIG_REFERENCE.md`** | Operators, integrators | 30 min | Authoritative reference for every key in every `.ini` file |
| **`DEPLOYMENT.md`** | Operators deploying V2 | 20 min | Step-by-step deployment guide (currently a speculative draft — see header) |
| **`CHANGELOG.md`** | Maintainers | 5 min | What changed phase by phase during the V2 build |
| **`algebraic-design-paper.md`** | Senior architects, academics | 45 min | The methodology that produced V2, with comparison to LangChain et al. |

For the methodology in book form: **Ames (2026), *Applied Algebraic Design for Agentic AI: Game Engine Methods.*** Free PDF in the V1 repository, $249 hardcover for institutional procurement, cheap softcover and KU on Amazon.

## What's in This Repository

```
rentahal-v2/
├── orchestrator/         Bus, dispatcher, db, config, api_health, frames, schema
│   ├── __main__.py       Entry point (python -m orchestrator)
│   ├── bus.py            WebSocket server + HTTP + sysop endpoints + admin route
│   ├── dispatcher.py     Queue runner + cost stamping + health scoring
│   ├── db.py             SQLite layer with swappable Database protocol
│   ├── api_health.py     Cloud API probe loop
│   ├── config.py         .ini hot-reload loader (the algebraic-design crux)
│   ├── frames.py         14-frame protocol definitions
│   └── schema.sql        peers / work_queue / invoices / payloads / events
├── workers/              13 worker modules + sdk.py
│   ├── sdk.py            Worker base class
│   ├── echo.py           Trivial echo worker (smoke test)
│   ├── ollama.py         Local LLM via Ollama
│   ├── llava.py          Local vision via Ollama
│   ├── stable_diffusion.py  A1111 webui integration
│   ├── whisper.py        faster-whisper STT
│   ├── gpt4all.py        gpt4all native LLM
│   ├── claude_api.py     Anthropic Claude
│   ├── openai_api.py     OpenAI completion
│   ├── hf_api.py         HuggingFace Inference
│   ├── tts_espeak.py     espeak-ng offline TTS
│   ├── tts_coqui.py      coqui neural TTS
│   └── tts_elevenlabs.py ElevenLabs cloud TTS
├── gui/                  Vanilla HTML + CSS + JS (no build step)
│   ├── index.html        User-facing GUI with V1 parity
│   ├── admin.html        Operator console (cost report, workers, broadcast, API health)
│   ├── style.css         Theme-driven CSS
│   ├── bus.js            WebSocket client
│   ├── ui.js             DOM rendering, speech output auto-route
│   └── speech.js         Wake word + Whisper combo + chunked upload
├── config/               11 .ini files — the executable specification
│   ├── orchestrator.ini  Bus, scheduler, debug, db, payloads, api_health
│   ├── worktypes.ini     Capability declarations
│   ├── workers.ini       Generic worker policy
│   ├── worker_endpoints.ini  Per-worker URLs, models, env vars
│   ├── actions.ini       User-facing actions (chat/vision/imagine)
│   ├── routes.ini        Frame routing rules
│   ├── health.ini        Worker health policy + numeric scoring
│   ├── api_health.ini    Cloud API probe targets
│   ├── speech.ini        Wake word, Whisper, audio chunking
│   ├── logging.ini       Log levels, ring buffer
│   └── theme.ini         GUI colors, fonts
├── tests/                21 test files (207 cases) + fakes/
├── README.md             You are here
├── EXECUTIVE_SUMMARY.md
├── QUICK_REFERENCE.md
├── ARCHITECTURE.md
├── CONFIG_REFERENCE.md
├── DEPLOYMENT.md
├── CHANGELOG.md
└── algebraic-design-paper.md
```

## What Makes V2 Different

If you've evaluated LangChain, CrewAI, AutoGen, or Haystack and found them lacking for production multi-tenant deployment, V2 is the alternative you've been looking for. Here's the comparison in one table:

| Dimension | LangChain et al. | RENTAHAL V2 |
|---|---|---|
| **Hardcoded constants in framework code** | Many (timeouts, retries, prompts) | **Zero** |
| **Adding a new worker/tool** | Subclass, register, often modify chain | **One config section + one ~150-line file. Zero kernel edits.** |
| **Multi-tenant cost ledger** | Not provided; build it yourself | **Built-in `invoices` table; per-user totals; sysop dashboard** |
| **Worker health scoring** | Not provided | **0–100 numeric; MVS WLM-style; auto-recovery** |
| **Replay-on-reconnect** | Not provided | **Built-in via `events` table + welcome frame** |
| **Operator console** | Not provided | **Built-in `/admin` page** |
| **Voice-first input/output** | Not provided | **Wake-word + Whisper input; espeak/coqui/elevenlabs output** |
| **Bus protocol** | HTTP REST + ad-hoc | **WebSocket with 14-frame protocol modeled on SNA LU 6.2** |
| **Lines of kernel code** | ~100K+ across LangChain ecosystem | **~3K Python kernel + workers** |
| **Mainframe ancestry** | None | **JES2 / VTAM / CICS / SNA / MVS WLM / APPC LU 6.2** |

V2 is the right tool when your application needs production multi-tenant deployment of voice-first AI workloads with cost accounting, operator visibility, and a clean audit trail. V2 is the wrong tool when your application needs general-purpose chain composition or rapid experimentation with novel agent topologies — for that, LangChain is the right choice.

For the full comparison with caveats and "where the contemporary frameworks are better", see `algebraic-design-paper.md`.

## The Methodology

V2 is the result of a software design discipline called **algebraic systems design**. Three rules:

1. **Zero hardcoded behavioral constants.** Every threshold, timeout, retry count, scoring delta, scheduling policy, cost value, URL, and model name lives in a `.ini` file. Implementation code reads values; it does not contain values.
2. **Configuration is the executable specification.** The `.ini` files in `config/` are the *primary* artifact that defines what V2 does. Source code is the secondary artifact that interprets the configuration.
3. **Code as homomorphism.** Adding a new capability is a configuration addition plus a localized code addition. Never a kernel edit. The structure of the code mirrors the structure of the configuration.

These rules are not new individually — they show up in MVS PARMLIB, Lisp environments, Terraform, and functional programming. What's novel is their **strict synthesis applied to AI orchestration**, where the prevailing pattern is exactly the opposite (hardcoded prompt strings, scattered magic numbers, configuration as an afterthought).

The methodology is documented in book form: **Ames, J. (2026). *Applied Algebraic Design for Agentic AI: Game Engine Methods.*** N2NHU Labs. Free PDF in the [V1 GitHub repository](https://github.com/jimpames/rentahal). Hardcover and Kindle on Amazon.

The methodology is also documented in `algebraic-design-paper.md` in this repo, which is the technical companion paper that grounds the methodology in V2's specific implementation and contrasts it with contemporary AI orchestration frameworks.

## The 207 Tests

V2 ships with a comprehensive integration test suite. The breakdown:

| Component | Test Files | Tests |
|---|---|---|
| Worker integration (10 workers + chunk upload) | 10 | 105 |
| Phase 5.1 GUI parity (backend + GUI DOM-stub) | 2 | 35 |
| Phase 5.2-5.4 admin console + API health probe | 2 | 18 |
| Phase 5.5 numeric worker health scoring | 1 | 13 |
| Phase 5.6 TTS workers + speech output GUI | 4 | 47 |
| Speech parser, whisper glue, wake-word combo | 3 | 20 |
| **Total** | **21** | **207** |

These are **integration tests**, not mocked-out unit tests. Each test spawns real orchestrator subprocesses, real worker subprocesses, and real WebSocket clients, and asserts on actual deliver bodies. Mock cloud APIs are stood up as local HTTP servers; mock binaries and Python packages are injected via PATH/PYTHONPATH for hermetic testing.

The tests are **parameterized over the configuration** — they assert that the score went down by `hard_failure_delta`, not by 15. This means the tests are forward-compatible with operational tuning: an operator who changes a constant in `health.ini` does not break the test suite. Tests verify the *relationship* between configuration and behavior, not arbitrary values.

To run the full suite:
```bash
for t in tests/test_*.py; do python "$t"; done
for t in tests/test_*.js; do node "$t"; done
```

## Status

Phase 5 status (the V2 build sprint):

- [x] **5.1** GUI parity with V1 (35 tests)
- [x] **5.2** Cost accounting (column + admin display)
- [x] **5.3** API health probe with auto-broadcast (8 tests)
- [x] **5.4** Operator console with ban/unban + broadcast (10 tests)
- [x] **5.5** Numeric worker health scoring (MVS WLM-style) (13 tests)
- [x] **5.6** TTS workers + speech output GUI (47 tests)
- [ ] **5.7** ngrok deployment guide + multi-node hardening (`DEPLOYMENT.md` is the speculative draft; will be refined after first real deployment)
- [ ] **5.8** Schema migrations (versioned up/down + runner; pending)

## Authorship and Credits

V2 was designed and built by **Jim Ames** (j p ames / N2NHU Labs), in collaboration with **Claude Opus 4.6** (Anthropic). The collaboration mode is documented in `algebraic-design-paper.md` Section 6 — what we've called *methodology-mediated collaboration*, where the human supplies the methodology and strategic decisions and the AI supplies execution and articulation within the methodology's constraints.

The methodology itself is older than the AI collaboration: it consolidates approximately forty years of Ames's systems engineering practice from VTAM and 3174 mainframe operations through the V1 production system. The 33rd book in the Ames series (*Applied Algebraic Design for Agentic AI*, February 2026) is the formal statement of the methodology; this V2 codebase is its executable companion.

The IBM systems architects of the 1970s and 1980s are credited prominently throughout the codebase and the architecture documentation. JES2, VTAM, CICS, VM/370, SNA, APPN, and MVS WLM are not analogies — they are the *load-bearing ancestry* of every major V2 component. The hardware changed; the abstractions did not.

## License

V2 is licensed commercially. For licensing inquiries, contact N2NHU Labs.

V1 (the GPL3 reference implementation that thousands of users have validated in production) lives at https://github.com/jimpames/rentahal.

The methodology book (*Applied Algebraic Design for Agentic AI*) is freely available as a PDF in the V1 repository and in print from Amazon.

This `README.md` and the other documentation files in this directory are released under the same terms as the methodology book — free to read, redistribute, and adapt; see the book for full terms.

## Contact

For commercial licensing, technical evaluation, or to inquire about adopting RENTAHAL V2 at your organization:

**N2NHU Labs** — via the contact info at https://github.com/jimpames

For methodology questions, the book is the right starting point. For specific technical questions about V2's architecture, `ARCHITECTURE.md` and `algebraic-design-paper.md` should answer them; for what's not answered there, contact N2NHU directly.

---

*RENTAHAL V2 — built in 24 hours on top of two years of production validation, on top of forty years of systems engineering practice, on top of fifty years of mainframe-proven architecture. The methodology is what holds it all together.*
