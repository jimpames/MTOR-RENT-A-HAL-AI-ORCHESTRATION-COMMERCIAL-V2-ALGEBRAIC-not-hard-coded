/* RENTAHAL UI layer — Phase 5.1 V1 parity.
 *
 * Subscribes to bus events and drives the DOM. Knows nothing about WebSocket
 * mechanics — that's all in bus.js. Knows nothing about config keys other
 * than what arrives via the welcome manifest and /_config/* endpoints.
 *
 * Responsibilities:
 *   - Status strip (connection + peer id + undelivered badge)
 *   - Sysop banner rendering (sysop_message frames from the orchestrator)
 *   - User info row (nickname entry, query count, total cost)
 *   - Action / worktype dropdowns (from manifest)
 *   - Drop zone for image attachment with click-or-drag + preview
 *   - Submit pipeline that bundles text + optional image_b64
 *   - Result cards with processing_ms + cost + worker peer + inline images
 *   - Replay prompt for undelivered results
 *   - Debug log drawer (collapsed by default)
 *
 * Public surface: window.ui.appendMessage(kind, text, opts) is preserved
 * because speech.js calls it for transcript echoes and system notices. It
 * is implemented as a card-renderer now, not a message row.
 */

(function () {
  'use strict';

  const $ = (id) => document.getElementById(id);

  // Client-side state that isn't on the bus:
  //   currentAttachment — { b64, mime, name } or null. Populated by the drop
  //     zone. Consumed by the next submit, then cleared.
  //   userTotals — { nickname, query_count, total_cost }. Mirrors bus.userTotals
  //     for rendering. Incremented optimistically on submit ack, reconciled
  //     on each deliver.
  //   speechOutputEnabled — Phase 5.6. When true, every text deliver triggers
  //     a follow-up TTS submit and the audio gets attached to the result card.
  //   pendingAudioCards — FIFO queue of result cards waiting for their TTS
  //     deliver. We don't track per-work_id correlation because TTS deliveries
  //     arrive in submission order from the bus.
  let currentAttachment = null;
  let userTotals = { nickname: null, query_count: 0, total_cost: 0.0 };
  let speechIni = null;  // for wake word display
  let speechOutputEnabled = false;
  let pendingAudioCards = [];

  const SPEECH_OUTPUT_KEY = 'rentahal_speech_output';

  // ---- Formatting helpers ----

  function formatCost(v) {
    if (typeof v !== 'number' || isNaN(v)) v = 0;
    return '$' + v.toFixed(4);
  }

  function formatMs(v) {
    if (typeof v !== 'number' || isNaN(v)) return '';
    if (v < 1000) return v + 'ms';
    return (v / 1000).toFixed(2) + 's';
  }

  function shortPeer(p) {
    if (!p) return '';
    // peer_id looks like worker_rtx_node_1_abcd1234 or client_xxxxxxxx.
    // Keep the human-meaningful prefix.
    if (p.length <= 20) return p;
    return p.slice(0, 20) + '…';
  }

  // ---- Status strip ----

  function setStatus(state) {
    const dot = $('conn-dot');
    const text = $('conn-text');
    if (!dot || !text) return;
    dot.className = 'dot ' + state;
    const labels = {
      off: 'disconnected',
      connecting: 'connecting…',
      online: 'online',
      error: 'error'
    };
    text.textContent = labels[state] || state;
  }

  function setPeerId(peerId) {
    const el = $('peer-id-display');
    if (el) el.textContent = 'peer: ' + peerId.slice(0, 14);
  }

  function showUndelivered(count) {
    const el = $('undelivered-badge');
    if (!el) return;
    if (count > 0) {
      el.textContent = count + ' waiting';
      el.classList.remove('hidden');
    } else {
      el.classList.add('hidden');
    }
  }

  // ---- User info row ----

  function renderUserTotals() {
    const nick = $('nickname-input');
    const qc = $('query-count-display');
    const tc = $('total-cost-display');
    if (nick && userTotals.nickname && !nick.value) {
      nick.value = userTotals.nickname;
    }
    if (qc) qc.textContent = String(userTotals.query_count || 0);
    if (tc) tc.textContent = formatCost(userTotals.total_cost || 0);
  }

  function setupNicknameControls() {
    const btn = $('set-nickname-btn');
    const input = $('nickname-input');
    if (!btn || !input) return;
    const commit = () => {
      const val = input.value.trim();
      if (!val) return;
      if (window.bus && window.bus.setNickname) {
        window.bus.setNickname(val);
        // Local echo — server ack will update again
        userTotals.nickname = val;
        renderUserTotals();
        appendMessage('system', 'nickname set to: ' + val);
      }
    };
    btn.addEventListener('click', commit);
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); commit(); }
    });
  }

  // ---- Sysop banners ----

  function addSysopBanner(body) {
    const host = $('sysop-banners');
    if (!host) return;
    const level = (body.level || 'info').toLowerCase();
    const el = document.createElement('div');
    el.className = 'sysop-banner ' + level;

    const textSpan = document.createElement('span');
    textSpan.className = 'sysop-text';
    const prefix = document.createElement('span');
    prefix.className = 'sysop-prefix';
    prefix.textContent = 'SYSOP:';
    textSpan.appendChild(prefix);
    textSpan.appendChild(document.createTextNode(' ' + (body.message || '')));

    const dismiss = document.createElement('button');
    dismiss.className = 'sysop-dismiss';
    dismiss.textContent = '×';
    dismiss.title = 'dismiss';
    dismiss.addEventListener('click', () => el.remove());

    el.appendChild(textSpan);
    el.appendChild(dismiss);
    host.appendChild(el);
  }

  // ---- Results history ----

  function hideBootMessage() {
    const boot = $('boot-message');
    if (boot) boot.style.display = 'none';
  }

  // Public: appendMessage(kind, text, opts) — used by speech.js and internal
  // notices. Renders as a minimal "system" card.
  function appendMessage(kind, text, opts) {
    opts = opts || {};
    hideBootMessage();
    const host = $('results-history');
    if (!host) return;

    const card = document.createElement('div');
    card.className = 'result-card ' + (kind === 'error' ? 'error' : '');
    if (opts.replayed) card.classList.add('replayed');

    const meta = document.createElement('div');
    meta.className = 'result-meta';
    const ts = document.createElement('span');
    ts.className = 'meta-item';
    ts.textContent = new Date().toLocaleTimeString() +
      (opts.replayed ? ' · replayed' : '');
    meta.appendChild(ts);
    const kindSpan = document.createElement('span');
    kindSpan.className = 'meta-item meta-worker';
    kindSpan.textContent = kind;
    meta.appendChild(kindSpan);
    card.appendChild(meta);

    const body = document.createElement('div');
    body.className = 'result-body' + (kind === 'error' ? ' error-body' : '');
    body.textContent = text;
    card.appendChild(body);

    // Newest at the top — V1 orders results newest first
    host.insertBefore(card, host.firstChild);
  }

  // Render a full delivered result as a card: prompt echo, meta row with
  // worker/cost/processing, and the result body which can be text or image.
  function renderDeliver(frame) {
    hideBootMessage();
    const host = $('results-history');
    if (!host) return;
    const body = frame.body || {};
    const replayed = !!body.replayed;

    const card = document.createElement('div');
    card.className = 'result-card' + (body.error ? ' error' : '') +
                     (replayed ? ' replayed' : '');

    // ---- Meta row ----
    const meta = document.createElement('div');
    meta.className = 'result-meta';

    const ts = document.createElement('span');
    ts.className = 'meta-item';
    ts.textContent = new Date().toLocaleTimeString();
    meta.appendChild(ts);

    if (body.worktype) {
      const wt = document.createElement('span');
      wt.className = 'meta-item';
      wt.textContent = body.worktype;
      meta.appendChild(wt);
    }

    if (body.worker_peer) {
      const wp = document.createElement('span');
      wp.className = 'meta-item meta-worker';
      wp.textContent = 'by ' + shortPeer(body.worker_peer);
      meta.appendChild(wp);
    }

    if (typeof body.processing_ms === 'number') {
      const ms = document.createElement('span');
      ms.className = 'meta-item';
      ms.textContent = formatMs(body.processing_ms);
      meta.appendChild(ms);
    }

    if (typeof body.cost_units === 'number') {
      const c = document.createElement('span');
      c.className = 'meta-item meta-cost';
      c.innerHTML = 'cost <strong>' + formatCost(body.cost_units) + '</strong>';
      meta.appendChild(c);
    }

    if (replayed) {
      const r = document.createElement('span');
      r.className = 'meta-item';
      r.textContent = 'replayed';
      meta.appendChild(r);
    }

    card.appendChild(meta);

    // ---- Prompt echo (best effort: the submit text isn't echoed back
    //      in deliver, but if the worker put it in 'prompt' or 'input', use it).
    // ----
    const promptText = body.prompt || body.input || null;
    if (promptText) {
      const pe = document.createElement('div');
      pe.className = 'result-prompt';
      pe.textContent = '> ' + promptText;
      card.appendChild(pe);
    }

    // ---- Result body ----
    const bodyEl = document.createElement('div');
    bodyEl.className = 'result-body' + (body.error ? ' error-body' : '');

    if (body.error) {
      bodyEl.textContent = 'error: ' + body.error;
    } else if (body.result_kind === 'image_b64' && body.result) {
      // Inline image rendering — the cornerstone of IMAGINE parity with V1
      const img = document.createElement('img');
      img.className = 'result-image';
      // Infer MIME from the first few bytes; default to PNG which both
      // SD and DALL-E deliver.
      img.src = 'data:image/png;base64,' + body.result;
      img.alt = 'generated image';
      bodyEl.appendChild(img);
    } else if (body.result_kind === 'image_url' && body.result) {
      const img = document.createElement('img');
      img.className = 'result-image';
      img.src = body.result;
      img.alt = 'generated image';
      bodyEl.appendChild(img);
    } else if (body.result_kind === 'audio_b64' && body.result) {
      // Phase 5.6: TTS deliver. Either this card was added directly by the
      // user submitting to a tts worktype, OR it's the response to an
      // automatic speech-output follow-up. In the latter case the result
      // card was already created earlier with empty body and is waiting
      // in pendingAudioCards — we attach this audio there instead.
      const fmt = body.audio_format || 'mp3';
      attachAudioToCard(card, body.result, fmt);
      // For direct TTS submits, also show the byte count as text content
      // so the card has something readable.
      const sizeKB = body.byte_size
        ? ' (' + Math.round(body.byte_size / 1024) + ' KB)'
        : '';
      const note = document.createElement('div');
      note.className = 'audio-note';
      note.style.fontSize = '11px';
      note.style.color = 'var(--color-fg-dim)';
      note.textContent = (body.engine || 'tts') + sizeKB;
      bodyEl.appendChild(note);
    } else if (body.result !== null && body.result !== undefined) {
      bodyEl.textContent = String(body.result);
    } else {
      bodyEl.textContent = '(empty result)';
    }

    card.appendChild(bodyEl);
    host.insertBefore(card, host.firstChild);

    // ---- Update user totals from the deliver ----
    if (!replayed && typeof body.cost_units === 'number') {
      userTotals.total_cost = (userTotals.total_cost || 0) + body.cost_units;
      renderUserTotals();
    }

    // ---- Phase 5.6: speech output auto-route ----
    // If speech output is enabled and this deliver is text (not error,
    // not image, not already audio, not a TTS deliver itself), fire a
    // follow-up TTS submit and reserve this card to receive the audio.
    if (
      speechOutputEnabled
      && !replayed
      && !body.error
      && body.worktype !== 'tts'
      && body.result_kind !== 'image_b64'
      && body.result_kind !== 'image_url'
      && body.result_kind !== 'audio_b64'
      && body.result
      && typeof body.result === 'string'
      && body.result.trim().length > 0
    ) {
      requestSpeechFor(card, body.result);
    }

    // If a TTS audio_b64 just arrived and speech output is on, AND we have
    // a pending card waiting for its audio, attach there too. This handles
    // the case where the user is asking direct text questions and the
    // speech-output system is doing follow-up TTS submissions.
    if (body.result_kind === 'audio_b64' && body.result && pendingAudioCards.length > 0) {
      const targetCard = pendingAudioCards.shift();
      const fmt = body.audio_format || 'mp3';
      attachAudioToCard(targetCard, body.result, fmt);
      targetCard.classList.remove('audio-pending');
    }
  }

  // ---- Speech output (Phase 5.6) ----

  function attachAudioToCard(card, audio_b64, format) {
    if (!card) return;
    // Avoid duplicate audio elements if attach is called twice
    const existing = card.querySelector && card.querySelector('audio.result-audio');
    if (existing) return;

    const audio = document.createElement('audio');
    audio.className = 'result-audio';
    audio.controls = true;
    audio.autoplay = true;
    const mime = format === 'wav' ? 'audio/wav'
              : format === 'mp3' ? 'audio/mpeg'
              : format === 'ogg' ? 'audio/ogg'
              : 'audio/mpeg';
    audio.src = 'data:' + mime + ';base64,' + audio_b64;
    card.appendChild(audio);
  }

  function requestSpeechFor(card, text) {
    if (!window.bus || !window.bus.manifest) return;
    const tts = window.bus.manifest.worktypes && window.bus.manifest.worktypes.tts;
    if (!tts || !tts.available) {
      // No TTS worker registered; quietly skip
      return;
    }
    // Mark the card as awaiting audio + queue it
    card.classList.add('audio-pending');
    pendingAudioCards.push(card);
    // Determine which engine the user has selected, if any
    const engineSel = $('tts-engine-select');
    const engineHint = engineSel && engineSel.value ? engineSel.value : null;
    const extraBody = {};
    if (engineHint) extraBody.engine_hint = engineHint;
    window.bus.submit('chat', 'tts', text, null, extraBody);
  }

  function setupSpeechOutputControls() {
    const cb = $('speech-output-toggle');
    if (!cb) return;
    // Restore from localStorage
    try {
      const saved = localStorage.getItem(SPEECH_OUTPUT_KEY);
      speechOutputEnabled = saved === '1';
      cb.checked = speechOutputEnabled;
    } catch (e) { /* ignore */ }

    cb.addEventListener('change', () => {
      speechOutputEnabled = cb.checked;
      try { localStorage.setItem(SPEECH_OUTPUT_KEY, speechOutputEnabled ? '1' : '0'); }
      catch (e) {}
      const engineSel = $('tts-engine-select');
      if (engineSel) {
        if (speechOutputEnabled) engineSel.classList.remove('hidden');
        else engineSel.classList.add('hidden');
      }
      appendMessage('system',
        speechOutputEnabled
          ? '🔊 speech output enabled — replies will be spoken'
          : '🔊 speech output disabled');
    });
  }

  // ---- Replay prompt ----

  function showReplayPrompt(count) {
    let el = $('replay-prompt');
    if (!el) {
      el = document.createElement('div');
      el.id = 'replay-prompt';
      el.innerHTML =
        '<span>' + count + ' result' + (count === 1 ? '' : 's') +
        ' from your last session.</span>' +
        '<button id="replay-yes">replay</button>' +
        '<button id="replay-no">dismiss</button>';
      document.body.appendChild(el);
      $('replay-yes').onclick = () => {
        window.bus.requestReplay();
        el.classList.add('hidden');
      };
      $('replay-no').onclick = () => {
        window.bus.dismissReplay();
        appendMessage('system', 'undelivered results dismissed.');
        el.classList.add('hidden');
      };
    } else {
      el.classList.remove('hidden');
    }
  }

  // ---- Manifest -> dropdowns ----

  function populateActions(actions) {
    const sel = $('action-select');
    if (!sel) return;
    sel.innerHTML = '';
    Object.keys(actions || {}).forEach((name) => {
      const opt = document.createElement('option');
      opt.value = name;
      opt.textContent = name.toUpperCase() + ' — ' + (actions[name].description || '');
      sel.appendChild(opt);
    });
    sel.disabled = false;
  }

  function populateWorktypes(manifest) {
    const sel = $('worktype-select');
    if (!sel) return;
    const action = $('action-select').value;
    const actionDef = (manifest.actions || {})[action] || {};
    const allowed = (actionDef.allowed_worktypes || '')
      .split(',').map(s => s.trim()).filter(Boolean);
    sel.innerHTML = '';
    Object.keys(manifest.worktypes || {}).forEach((wt) => {
      if (allowed.length && allowed.indexOf(wt) === -1) return;
      const info = manifest.worktypes[wt];
      if (!info.available) return;
      const opt = document.createElement('option');
      opt.value = wt;
      // Show worker count, or (api) for cloud-backed worktypes.
      const suffix = info.live_workers > 0
        ? ' (' + info.live_workers + ')'
        : ' (api)';
      opt.textContent = wt + suffix;
      sel.appendChild(opt);
    });
    sel.disabled = sel.options.length === 0;
  }

  // ---- Drop zone for image attachment ----

  function setupDropZone() {
    const zone = $('drop-zone');
    const fileInput = $('file-input');
    const preview = $('image-preview');
    const label = $('drop-zone-label');
    const clearBtn = $('clear-attachment-btn');
    if (!zone || !fileInput) return;

    function loadFile(file) {
      if (!file) return;
      if (!file.type || file.type.indexOf('image/') !== 0) {
        appendMessage('error', 'not an image file: ' + (file.name || '(unnamed)'));
        return;
      }
      const reader = new FileReader();
      reader.onload = () => {
        const dataUrl = reader.result || '';
        const idx = String(dataUrl).indexOf(',');
        const b64 = idx >= 0 ? String(dataUrl).slice(idx + 1) : '';
        currentAttachment = {
          b64: b64,
          mime: file.type,
          name: file.name || 'image'
        };
        // Show preview
        if (preview) {
          preview.src = dataUrl;
          preview.classList.remove('hidden');
        }
        if (label) label.classList.add('hidden');
        if (clearBtn) clearBtn.classList.remove('hidden');
        zone.classList.add('has-attachment');
      };
      reader.onerror = () => {
        appendMessage('error', 'failed to read attachment');
      };
      reader.readAsDataURL(file);
    }

    function clearAttachment() {
      currentAttachment = null;
      if (preview) { preview.src = ''; preview.classList.add('hidden'); }
      if (label) label.classList.remove('hidden');
      if (clearBtn) clearBtn.classList.add('hidden');
      zone.classList.remove('has-attachment', 'dragover');
      fileInput.value = '';
    }

    zone.addEventListener('click', (e) => {
      if (e.target === clearBtn) return;
      fileInput.click();
    });
    fileInput.addEventListener('change', (e) => {
      const f = e.target.files && e.target.files[0];
      if (f) loadFile(f);
    });
    if (clearBtn) {
      clearBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        clearAttachment();
      });
    }

    // Drag-and-drop
    ['dragenter', 'dragover'].forEach((evt) => {
      zone.addEventListener(evt, (e) => {
        e.preventDefault();
        e.stopPropagation();
        zone.classList.add('dragover');
      });
    });
    ['dragleave', 'drop'].forEach((evt) => {
      zone.addEventListener(evt, (e) => {
        e.preventDefault();
        e.stopPropagation();
        if (evt === 'dragleave') zone.classList.remove('dragover');
      });
    });
    zone.addEventListener('drop', (e) => {
      const f = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
      if (f) loadFile(f);
    });

    // Expose for submit consumption
    window.ui._clearAttachment = clearAttachment;
  }

  // ---- Wake word display ----

  async function loadWakeWordDisplay() {
    try {
      const r = await fetch('/_config/speech');
      speechIni = await r.json();
    } catch (e) {
      speechIni = {};
    }
    const ww = (speechIni.wake_word && speechIni.wake_word.word) || 'HAL';
    const el = $('wake-word-display');
    if (el) el.textContent = ww;
  }

  // ---- Log drawer ----

  function setupLogDrawer() {
    const drawer = $('debug-drawer');
    const toggle = $('drawer-toggle');
    const tail = $('log-tail');
    if (!drawer || !toggle || !tail) return;
    let collapsed = drawer.classList.contains('collapsed');

    function flip() {
      collapsed = !collapsed;
      drawer.classList.toggle('collapsed', collapsed);
      toggle.textContent = collapsed ? '▲' : '▼';
    }
    toggle.onclick = (e) => { e.stopPropagation(); flip(); };
    const header = drawer.querySelector('.drawer-header');
    if (header) header.onclick = flip;

    function append(entry) {
      const line = document.createElement('span');
      line.className = 'log-line log-' + (entry.level || 'INFO');
      const time = new Date(entry.ts * 1000).toLocaleTimeString();
      line.textContent = '[' + time + '] ' + (entry.name || '') + ': ' + (entry.msg || '');
      tail.appendChild(line);
      while (tail.childNodes.length > 500) tail.removeChild(tail.firstChild);
      tail.scrollTop = tail.scrollHeight;
    }

    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    try {
      const ws = new WebSocket(proto + '//' + location.host + '/_debug/log/stream');
      ws.onmessage = (ev) => {
        try { append(JSON.parse(ev.data)); } catch (e) {}
      };
      ws.onclose = () => {
        append({ ts: Date.now() / 1000, level: 'WARNING', name: 'log-stream',
                 msg: 'log stream disconnected' });
      };
    } catch (e) {
      // Non-browser test env — no log stream available, that's fine
    }
  }

  // ---- Submit wiring ----

  function doSubmit() {
    const action = $('action-select').value;
    const worktype = $('worktype-select').value;
    const text = $('text-input').value.trim();
    if (!worktype) {
      appendMessage('error', 'no worktype selected');
      return;
    }
    if (!text && !currentAttachment) {
      appendMessage('error', 'prompt or attachment required');
      return;
    }

    const extra = {};
    if (currentAttachment) {
      extra.image_b64 = currentAttachment.b64;
      extra.image_media_type = currentAttachment.mime;
    }
    window.bus.submit(action, worktype, text, currentAttachment, extra);

    // Local echo: show what the user sent
    const echoText = text + (currentAttachment ? ' [+image: ' + currentAttachment.name + ']' : '');
    appendMessage('sent', '> ' + echoText);

    $('text-input').value = '';
    if (window.ui._clearAttachment) window.ui._clearAttachment();

    // Optimistic query count bump
    userTotals.query_count = (userTotals.query_count || 0) + 1;
    renderUserTotals();
  }

  // ---- Boot ----

  document.addEventListener('DOMContentLoaded', () => {
    setStatus('connecting');
    if (window.bus) setPeerId(window.bus.peerId);
    setupLogDrawer();
    setupNicknameControls();
    setupDropZone();
    setupSpeechOutputControls();
    loadWakeWordDisplay();

    if (!window.bus) return;  // test env with stub

    window.bus.on('status', (s) => setStatus(s.state));

    window.bus.on('welcome', (body) => {
      const wtCount = Object.keys((body.manifest || {}).worktypes || {}).length;
      appendMessage('system',
        'welcomed by orchestrator. ' + wtCount + ' worktypes in manifest.');
      if (body.manifest) {
        populateActions(body.manifest.actions);
        populateWorktypes(body.manifest);
      }
      showUndelivered(body.undelivered_count || 0);
      // Phase 5.1: reconcile user totals from the welcome
      if (body.user_totals) {
        userTotals = {
          nickname: body.user_totals.nickname || null,
          query_count: body.user_totals.query_count || 0,
          total_cost: body.user_totals.total_cost || 0.0
        };
        renderUserTotals();
      }
      // Enable the input panel
      const ti = $('text-input'); if (ti) { ti.disabled = false; ti.placeholder = 'type or speak a prompt…'; }
      const sb = $('submit-btn'); if (sb) sb.disabled = false;
    });

    window.bus.on('manifest', (m) => {
      if (m) populateWorktypes(m);
    });

    window.bus.on('undelivered', (u) => {
      if (u.count > 0) showReplayPrompt(u.count);
    });

    window.bus.on('deliver', renderDeliver);

    window.bus.on('sysop_message', (frame) => {
      addSysopBanner(frame.body || {});
    });

    window.bus.on('error_frame', (frame) => {
      appendMessage('error', (frame.body && frame.body.reason) || 'error');
    });

    const actionSel = $('action-select');
    if (actionSel) {
      actionSel.addEventListener('change', () => {
        if (window.bus.manifest) populateWorktypes(window.bus.manifest);
      });
    }

    const submitBtn = $('submit-btn');
    if (submitBtn) submitBtn.addEventListener('click', doSubmit);
    const textInput = $('text-input');
    if (textInput) {
      textInput.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
          e.preventDefault();
          doSubmit();
        }
      });
    }

    window.bus.connect();
  });

  // Public surface
  window.ui = {
    appendMessage: appendMessage,
    renderDeliver: renderDeliver,
    addSysopBanner: addSysopBanner,
    renderUserTotals: renderUserTotals,
    attachAudioToCard: attachAudioToCard,
    requestSpeechFor: requestSpeechFor,
    // Test hooks
    _getAttachment: () => currentAttachment,
    _setAttachment: (a) => { currentAttachment = a; },
    _getUserTotals: () => userTotals,
    _setUserTotals: (t) => { userTotals = t; renderUserTotals(); },
    _doSubmit: doSubmit,
    _getSpeechOutput: () => speechOutputEnabled,
    _setSpeechOutput: (v) => { speechOutputEnabled = !!v; },
    _getPendingAudioCards: () => pendingAudioCards
  };
})();
