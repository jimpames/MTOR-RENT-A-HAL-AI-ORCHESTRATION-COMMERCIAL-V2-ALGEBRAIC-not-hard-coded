// Phase 5.6 — speech output GUI test
//
// Verifies the speech-output auto-route in ui.js:
//   - Toggling the checkbox flips speechOutputEnabled
//   - When ON, text delivers trigger a follow-up bus.submit('chat', 'tts', ...)
//   - When OFF, no follow-up submit fires
//   - TTS delivers do NOT trigger recursive TTS
//   - audio_b64 delivers attach an <audio> element to the pending card
//   - Direct submission to tts renders an audio player on its own card
//   - Image delivers do NOT trigger TTS (only text does)
//   - Error delivers do NOT trigger TTS

const fs = require('fs');
const path = require('path');

// -------------------- Mini DOM (same shape as test_phase51_gui.js) --------------------

let idCounter = 0;

class ElementStub {
  constructor(tag) {
    this.tagName = (tag || 'DIV').toUpperCase();
    this._id = 'el_' + (++idCounter);
    this.children = [];
    this.parent = null;
    this.style = {};
    this.classList = new ClassList(this);
    this._listeners = {};
    this._textContent = '';
    this._innerHTML = '';
    this.value = '';
    this.disabled = false;
    this.placeholder = '';
    this.files = null;
    this.src = '';
    this.type = '';
    this.checked = false;
    this.controls = false;
    this.autoplay = false;
  }
  appendChild(child) {
    child.parent = this;
    this.children.push(child);
    return child;
  }
  insertBefore(child, ref) {
    child.parent = this;
    if (!ref) { this.children.unshift(child); return child; }
    const i = this.children.indexOf(ref);
    if (i < 0) this.children.push(child);
    else this.children.splice(i, 0, child);
    return child;
  }
  removeChild(child) {
    const i = this.children.indexOf(child);
    if (i >= 0) this.children.splice(i, 1);
    return child;
  }
  remove() { if (this.parent) this.parent.removeChild(this); }
  addEventListener(ev, fn) {
    if (!this._listeners[ev]) this._listeners[ev] = [];
    this._listeners[ev].push(fn);
  }
  fire(ev, payload) {
    const list = this._listeners[ev] || [];
    list.forEach((fn) => fn(payload || {
      preventDefault: () => {}, stopPropagation: () => {}, target: this
    }));
  }
  set textContent(v) { this._textContent = String(v); }
  get textContent() { return this._textContent; }
  set innerHTML(v) { this._innerHTML = String(v); }
  get innerHTML() { return this._innerHTML; }
  // Real DOM querySelector — used by attachAudioToCard to detect dupes
  querySelector(sel) {
    // We only support 'audio.result-audio' lookups in this test
    if (sel === 'audio.result-audio') {
      for (const c of this.children) {
        if (c.tagName === 'AUDIO' && c.classList.contains('result-audio')) {
          return c;
        }
        if (c.querySelector) {
          const nested = c.querySelector(sel);
          if (nested) return nested;
        }
      }
    }
    return null;
  }
  get firstChild() { return this.children[0] || null; }
  set onclick(fn) { this._onclick = fn; }
  get onclick() { return this._onclick; }
  get options() { return this.children; }
  set className(v) {
    this.classList._set = new Set(String(v || '').split(/\s+/).filter(Boolean));
  }
  get className() { return this.classList._toString(); }
}

class ClassList {
  constructor(el) { this._el = el; this._set = new Set(); }
  add(...names) { names.forEach(n => this._set.add(n)); }
  remove(...names) { names.forEach(n => this._set.delete(n)); }
  toggle(name, force) {
    if (force === undefined) {
      if (this._set.has(name)) { this._set.delete(name); return false; }
      this._set.add(name); return true;
    }
    if (force) this._set.add(name); else this._set.delete(name);
    return !!force;
  }
  contains(n) { return this._set.has(n); }
  get length() { return this._set.size; }
  _toString() { return Array.from(this._set).join(' '); }
}

const REGISTERED_IDS = [
  'conn-dot', 'conn-text', 'peer-id-display', 'undelivered-badge',
  'sysop-banners',
  'instructions-panel', 'wake-word-display',
  'user-info-row', 'nickname-input', 'set-nickname-btn',
  'query-count-display', 'total-cost-display',
  'input-panel', 'action-select', 'worktype-select', 'speech-toggle',
  'text-input', 'submit-btn',
  'speech-output-toggle', 'tts-engine-select',
  'drop-zone', 'drop-zone-label', 'file-input', 'image-preview', 'clear-attachment-btn',
  'results-section', 'results-header', 'results-history', 'boot-message',
  'debug-drawer', 'drawer-toggle', 'log-tail',
];

const domRegistry = {};
for (const id of REGISTERED_IDS) {
  const el = new ElementStub('div');
  el._id_user = id;
  domRegistry[id] = el;
}
domRegistry['file-input'].click = function() {};
domRegistry['speech-output-toggle'].tagName = 'INPUT';
domRegistry['speech-output-toggle'].type = 'checkbox';

const docHandlers = {};
global.document = {
  getElementById: (id) => domRegistry[id] || null,
  createElement: (tag) => new ElementStub(tag),
  createTextNode: (text) => {
    const n = new ElementStub('#text');
    n._textContent = String(text);
    return n;
  },
  addEventListener: (ev, fn) => { docHandlers[ev] = fn; },
  body: new ElementStub('body'),
};

global.FileReader = class {
  constructor() { this.result = null; this.onload = null; this.onerror = null; }
  readAsDataURL(blob) {
    setTimeout(() => {
      this.result = 'data:' + (blob.type || 'image/png') + ';base64,' + (blob._b64 || 'AAAA');
      if (this.onload) this.onload();
    }, 0);
  }
};

// localStorage stub
const lsStore = {};
global.localStorage = {
  getItem: (k) => lsStore[k] || null,
  setItem: (k, v) => { lsStore[k] = String(v); },
  removeItem: (k) => { delete lsStore[k]; },
};

// -------------------- Bus stub --------------------

const submitCalls = [];
const eventListeners = {};

const stubBus = {
  peerId: 'client_speech_test',
  manifest: {
    actions: {
      chat:    { default_worktype: 'echo', allowed_worktypes: 'echo, llama' },
      vision:  { default_worktype: 'llava', allowed_worktypes: 'llava' },
      imagine: { default_worktype: 'sd', allowed_worktypes: 'sd' },
    },
    worktypes: {
      echo:  { available: true, live_workers: 1 },
      llama: { available: true, live_workers: 1 },
      llava: { available: true, live_workers: 1 },
      sd:    { available: true, live_workers: 1 },
      tts:   { available: true, live_workers: 1 },  // TTS available
    },
  },
  userTotals: null,
  submit: (action, worktype, text, attachment, extraBody) => {
    submitCalls.push({ action, worktype, text, attachment, extraBody });
  },
  setNickname: () => true,
  sendChunk: () => {},
  on: (ev, fn) => {
    if (!eventListeners[ev]) eventListeners[ev] = [];
    eventListeners[ev].push(fn);
  },
  emit: (ev, payload) => {
    (eventListeners[ev] || []).forEach((fn) => fn(payload));
  },
  connect: () => {},
  requestReplay: () => {},
  dismissReplay: () => {},
};

global.window = { bus: stubBus };
global.fetch = async () => ({ json: async () => ({ wake_word: { word: 'HAL' } }) });
global.location = { protocol: 'http:', host: 'localhost' };

// -------------------- Load ui.js --------------------

const uiSrc = fs.readFileSync(path.join(__dirname, '..', 'gui', 'ui.js'), 'utf8');
eval(uiSrc);

// -------------------- Run tests --------------------

(async () => {
  await docHandlers.DOMContentLoaded();
  // Welcome the bus so the manifest is wired
  stubBus.emit('welcome', {
    manifest: stubBus.manifest,
    undelivered_count: 0,
    heartbeat_interval_sec: 5,
    user_totals: { nickname: null, query_count: 0, total_cost: 0 },
  });

  let pass = 0, fail = 0;
  const test = (name, fn) => {
    try {
      const ok = fn();
      if (ok) { pass++; console.log(`  PASS ${name}`); }
      else { fail++; console.log(`  FAIL ${name}`); }
    } catch (e) {
      fail++;
      console.log(`  FAIL ${name} — ${e.message}`);
    }
  };

  // ---- T1: speech output starts disabled ----
  test('T1 speech output disabled by default', () =>
    window.ui._getSpeechOutput() === false);

  // ---- T2: toggling the checkbox flips state and shows engine dropdown ----
  domRegistry['speech-output-toggle'].checked = true;
  domRegistry['speech-output-toggle'].fire('change');
  test('T2 toggling checkbox enables speech output', () =>
    window.ui._getSpeechOutput() === true);
  test('T2b engine dropdown shown when enabled', () =>
    !domRegistry['tts-engine-select'].classList.contains('hidden'));

  // ---- T3: localStorage persistence ----
  test('T3 speech output persisted to localStorage', () =>
    lsStore['rentahal_speech_output'] === '1');

  // ---- T4: text deliver with speech output ON triggers TTS submit ----
  submitCalls.length = 0;
  stubBus.emit('deliver', {
    type: 'deliver',
    body: {
      work_id: 100,
      worktype: 'echo',
      worker_peer: 'worker_echo_a',
      processing_ms: 50,
      cost_units: 0,
      result: 'Apollo 11 landed on the Moon.',
    }
  });
  test('T4 text deliver triggers TTS submit', () =>
    submitCalls.length === 1
      && submitCalls[0].worktype === 'tts'
      && submitCalls[0].text === 'Apollo 11 landed on the Moon.');

  // ---- T5: pending audio card is queued ----
  test('T5 pending audio card queued', () =>
    window.ui._getPendingAudioCards().length === 1);

  // ---- T6: TTS deliver attaches audio element to the pending card ----
  stubBus.emit('deliver', {
    type: 'deliver',
    body: {
      work_id: 101,
      worktype: 'tts',
      worker_peer: 'worker_tts_a',
      processing_ms: 800,
      cost_units: 0,
      result: 'BASE64FAKEAUDIO',
      result_kind: 'audio_b64',
      audio_format: 'wav',
      engine: 'espeak',
      byte_size: 12345,
    }
  });

  // After TTS deliver, the pending card should have its audio attached
  // and be removed from the queue. The TTS deliver itself also creates a
  // result card (newest at top), so we look for the audio on either.
  test('T6 pending audio queue drained', () =>
    window.ui._getPendingAudioCards().length === 0);

  function findAudio(node) {
    if (!node || !node.children) return null;
    for (const c of node.children) {
      if (c.tagName === 'AUDIO') return c;
      const nested = findAudio(c);
      if (nested) return nested;
    }
    return null;
  }

  // The first card in results-history should be the TTS-direct render
  // (since insertBefore puts newest first); the second should be the
  // original text deliver, which now has the audio attached.
  const cards = domRegistry['results-history'].children;
  // Filter to result-card class only (skipping any boot message)
  const resultCards = cards.filter(c => c.classList && c.classList.contains('result-card'));

  // The card created by the original text deliver gets the audio attached
  // via the pending-card mechanism. Find any card that has an audio child.
  let audioCard = null;
  for (const c of resultCards) {
    if (findAudio(c)) { audioCard = c; break; }
  }
  test('T6b audio element attached to a result card', () => audioCard !== null);

  const audio = audioCard ? findAudio(audioCard) : null;
  test('T6c audio element has src with data: URI', () =>
    audio && audio.src && audio.src.indexOf('data:audio/wav;base64,BASE64FAKEAUDIO') === 0);

  test('T6d audio element has controls and autoplay', () =>
    audio && audio.controls === true && audio.autoplay === true);

  // ---- T7: TTS deliver does NOT trigger recursive TTS submit ----
  // (We already saw the TTS deliver above; the submit count should not have
  //  increased beyond the one from T4.)
  test('T7 TTS deliver does not recurse', () => submitCalls.length === 1);

  // ---- T8: error deliver does NOT trigger TTS ----
  submitCalls.length = 0;
  stubBus.emit('deliver', {
    type: 'deliver',
    body: {
      work_id: 102,
      worktype: 'echo',
      worker_peer: 'worker_echo_a',
      error: 'something went wrong',
      processing_ms: 10,
    }
  });
  test('T8 error deliver does not trigger TTS', () => submitCalls.length === 0);

  // ---- T9: image deliver does NOT trigger TTS ----
  stubBus.emit('deliver', {
    type: 'deliver',
    body: {
      work_id: 103,
      worktype: 'sd',
      worker_peer: 'worker_sd_a',
      processing_ms: 8000,
      cost_units: 0,
      result: 'BASE64IMAGE',
      result_kind: 'image_b64',
    }
  });
  test('T9 image deliver does not trigger TTS', () => submitCalls.length === 0);

  // ---- T10: replayed deliver does NOT trigger TTS ----
  stubBus.emit('deliver', {
    type: 'deliver',
    body: {
      work_id: 104,
      worktype: 'echo',
      worker_peer: 'worker_echo_a',
      result: 'replayed result',
      processing_ms: 5,
      replayed: true,
    }
  });
  test('T10 replayed deliver does not trigger TTS', () => submitCalls.length === 0);

  // ---- T11: turning speech output OFF stops the auto-route ----
  domRegistry['speech-output-toggle'].checked = false;
  domRegistry['speech-output-toggle'].fire('change');
  test('T11 speech output disabled', () =>
    window.ui._getSpeechOutput() === false);

  submitCalls.length = 0;
  stubBus.emit('deliver', {
    type: 'deliver',
    body: {
      work_id: 105,
      worktype: 'claude_api',
      worker_peer: 'worker_claude_a',
      result: 'this should not be spoken',
      processing_ms: 100,
      cost_units: 0.015,
    }
  });
  test('T11b text deliver with speech off → no submit', () =>
    submitCalls.length === 0);

  // ---- T12: localStorage cleared on disable ----
  test('T12 speech output state persisted as off', () =>
    lsStore['rentahal_speech_output'] === '0');

  // ---- T13: direct TTS submission renders audio without triggering recursion ----
  // Re-enable speech output
  domRegistry['speech-output-toggle'].checked = true;
  domRegistry['speech-output-toggle'].fire('change');
  // Empty pending queue
  window.ui._getPendingAudioCards().length = 0;
  submitCalls.length = 0;

  // A direct TTS deliver (e.g., user submitted to worktype=tts directly)
  stubBus.emit('deliver', {
    type: 'deliver',
    body: {
      work_id: 200,
      worktype: 'tts',
      worker_peer: 'worker_tts_eleven',
      processing_ms: 1200,
      cost_units: 0.030,
      result: 'DIRECTTTSAUDIO',
      result_kind: 'audio_b64',
      audio_format: 'mp3',
      engine: 'elevenlabs',
      byte_size: 54321,
    }
  });
  // No follow-up submit should fire (TTS deliver excluded from auto-route)
  test('T13 direct TTS deliver no recursive submit', () =>
    submitCalls.length === 0);

  // The newest card should have an audio element
  const directCard = domRegistry['results-history'].children[0];
  const directAudio = findAudio(directCard);
  test('T13b direct TTS card has audio element', () => directAudio !== null);
  test('T13c direct TTS audio src is mp3', () =>
    directAudio && directAudio.src.indexOf('data:audio/mpeg;base64,DIRECTTTSAUDIO') === 0);

  console.log(`\n${pass}/${pass + fail} ${fail === 0 ? 'ALL OK' : 'FAIL'}`);
  process.exit(fail === 0 ? 0 : 1);
})();
