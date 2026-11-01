/*
 * app.js — StepCam UI controller.
 * Sources: USB webcam (via the Android app's UVC driver), phone camera (getUserMedia), or a photo file.
 */
(function () {
  'use strict';

  const $ = (id) => document.getElementById(id);
  const NATIVE = window.StepCamNative || null; // injected by the Android app
  const LS_SETTINGS = 'stepcam.settings.v1';
  const LS_HISTORY = 'stepcam.history.v1';
  const MAX_HISTORY = 25;

  const defaults = {
    apiKey: '', model: 'claude-opus-5-5', effort: 'high', detail: 'full',
    usbRes: '1080', skipReview: false, flip: false, source: NATIVE ? 'usb' : 'phone', phoneDeviceId: '',
    doubleCheck: true, useCode: true,
  };

  const state = {
    settings: loadSettings(),
    source: null,
    stream: null,
    usbTimer: null,
    usbSeq: 0,
    usbLive: false,
    usbStatus: null,
    still: null,          // canvas holding the captured frame
    crop: null,           // {x, y, w, h} in still pixels
    abort: null,
    last: null,           // last history entry shown
    viewing: null,
    phoneDevices: [],
  };

  // ---------------------------------------------------------------- storage
  function loadSettings() {
    try { return Object.assign({}, defaults, JSON.parse(localStorage.getItem(LS_SETTINGS) || '{}')); } catch (e) { return Object.assign({}, defaults); }
  }
  function saveSettings() {
    try { localStorage.setItem(LS_SETTINGS, JSON.stringify(state.settings)); } catch (e) { /* ignore */ }
  }
  function loadHistory() {
    try { return JSON.parse(localStorage.getItem(LS_HISTORY) || '[]'); } catch (e) { return []; }
  }
  function saveHistory(list) {
    for (let n = list.length; n > 0; n--) {
      try { localStorage.setItem(LS_HISTORY, JSON.stringify(list.slice(0, n))); return; } catch (e) { /* quota: drop oldest */ }
    }
  }

  // ---------------------------------------------------------------- screens
  function show(name) {
    document.querySelectorAll('.screen').forEach((s) => s.classList.toggle('active', s.id === 'screen-' + name));
    if (name === 'capture') resumeSource(); else pauseSource();
  }
  function current() {
    const a = document.querySelector('.screen.active');
    return a ? a.id.replace('screen-', '') : '';
  }

  let toastTimer = null;
  function toast(msg, ms) {
    const t = $('toast');
    t.textContent = msg;
    t.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { t.hidden = true; }, ms || 2800);
  }

  // ---------------------------------------------------------------- sources
  function setSource(src) {
    if (src === 'usb' && !NATIVE) src = 'phone';
    state.source = src;
    state.settings.source = src;
    saveSettings();
    $('seg-usb').classList.toggle('active', src === 'usb');
    $('seg-phone').classList.toggle('active', src === 'phone');
    stopPhone();
    stopUsb();
    $('usb-feed').hidden = src !== 'usb';
    $('phone-feed').hidden = src !== 'phone';
    $('btn-cam-switch').hidden = true;
    if (src === 'usb') startUsb(); else startPhone();
  }
  function pauseSource() { stopUsb(); stopPhone(); }
  function resumeSource() { if (state.source === 'usb') startUsb(); else if (state.source === 'phone' && !state.stream) startPhone(); }

  function setStatus(kind, text) {
    const el = $('feed-status');
    el.className = 'feed-status ' + (kind || '');
    $('feed-status-text').textContent = text;
  }
  function setEmpty(title, body, showConnect) {
    const box = $('feed-empty');
    if (!title) { box.hidden = true; return; }
    box.hidden = false;
    $('feed-empty-title').textContent = title;
    $('feed-empty-body').textContent = body || '';
    $('btn-connect').hidden = !showConnect;
  }

  // --- USB webcam (frames served by the Android app at /usbcam/...) ---
  function startUsb() {
    stopUsb();
    pollUsbStatus();
    state.usbTimer = setInterval(pollUsbStatus, 1000);
    nextUsbFrame();
  }
  function stopUsb() {
    clearInterval(state.usbTimer);
    state.usbTimer = null;
    state.usbSeq++; // invalidates in-flight frame loop
  }
  function nextUsbFrame() {
    const seq = state.usbSeq;
    const img = $('usb-feed');
    const probe = new Image();
    probe.onload = () => {
      if (seq !== state.usbSeq) return;
      img.src = probe.src;
      if (!state.usbLive) { state.usbLive = true; renderUsbStatus(); }
      setTimeout(() => { if (seq === state.usbSeq) nextUsbFrame(); }, 90);
    };
    probe.onerror = () => {
      if (seq !== state.usbSeq) return;
      if (state.usbLive) { state.usbLive = false; renderUsbStatus(); }
      setTimeout(() => { if (seq === state.usbSeq) nextUsbFrame(); }, 600);
    };
    probe.src = '/usbcam/frame.jpg?n=' + Date.now();
  }
  function pollUsbStatus() {
    if (!NATIVE) return;
    try { state.usbStatus = JSON.parse(NATIVE.status()); } catch (e) { state.usbStatus = null; }
    renderUsbStatus();
  }
  function renderUsbStatus() {
    if (state.source !== 'usb') return;
    const st = state.usbStatus || { state: 'unknown' };
    const name = st.device || 'USB webcam';
    if (state.usbLive && st.state === 'streaming') {
      setStatus('live', name + (st.width ? ' · ' + st.width + '×' + st.height : ''));
      setEmpty(null);
      return;
    }
    switch (st.state) {
      case 'no_device':
        setStatus('err', 'No USB webcam');
        setEmpty('Plug in your webcam',
          'Connect the Logitech webcam to the phone with a USB-C OTG adapter. Android will ask to allow StepCam to use it — tap OK.', true);
        break;
      case 'no_camera_permission':
        setStatus('err', 'Camera permission needed');
        setEmpty('Allow camera access', 'Android requires the Camera permission before an app can use a USB webcam.', true);
        break;
      case 'waiting_permission':
        setStatus('wait', 'Waiting for USB permission');
        setEmpty('Allow USB access', 'Tap OK on the Android prompt to let StepCam use ' + name + '.', true);
        break;
      case 'denied':
        setStatus('err', 'USB permission denied');
        setEmpty('USB access was denied', 'Tap Connect and choose OK on the prompt (tick "Always open StepCam" to skip it next time).', true);
        break;
      case 'opening':
      case 'streaming':
        setStatus('wait', st.message || ('Starting ' + name + '…'));
        setEmpty(null);
        break;
      case 'error':
        setStatus('err', 'Webcam error');
        setEmpty('Webcam error', (st.message || 'The webcam stopped responding.') + ' Unplug it, plug it back in, then tap Connect.', true);
        break;
      default:
        setStatus('wait', 'Looking for webcam…');
        setEmpty(null);
    }
  }

  // --- phone camera (or any camera Android exposes to the browser engine) ---
  async function startPhone() {
    stopPhone();
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      setStatus('err', 'Camera unavailable');
      setEmpty('Camera not available', 'Use "Photo" to pick an image instead.', false);
      return;
    }
    setStatus('wait', 'Starting camera…');
    setEmpty(null);
    const id = state.settings.phoneDeviceId;
    const video = { width: { ideal: 1920 }, height: { ideal: 1080 } };
    if (id) video.deviceId = { exact: id }; else video.facingMode = { ideal: 'environment' };
    try {
      state.stream = await navigator.mediaDevices.getUserMedia({ video, audio: false });
    } catch (e) {
      if (id) { state.settings.phoneDeviceId = ''; saveSettings(); return startPhone(); }
      setStatus('err', 'Camera blocked');
      setEmpty('Camera permission needed', 'Allow camera access for StepCam, or use "Photo" to pick an image.', false);
      return;
    }
    if (state.source !== 'phone' || current() !== 'capture') { stopPhone(); return; }
    const v = $('phone-feed');
    v.srcObject = state.stream;
    try { await v.play(); } catch (e) { /* autoplay may need a gesture */ }
    const track = state.stream.getVideoTracks()[0];
    const s = track && track.getSettings ? track.getSettings() : {};
    setStatus('live', (track && track.label ? shortLabel(track.label) : 'Camera') + (s.width ? ' · ' + s.width + '×' + s.height : ''));
    try {
      const devs = await navigator.mediaDevices.enumerateDevices();
      state.phoneDevices = devs.filter((d) => d.kind === 'videoinput');
      $('btn-cam-switch').hidden = state.phoneDevices.length < 2;
    } catch (e) { /* ignore */ }
  }
  function shortLabel(l) { return l.replace(/\s*\([0-9a-f]{4}:[0-9a-f]{4}\)/i, '').slice(0, 32); }
  function stopPhone() {
    if (state.stream) state.stream.getTracks().forEach((t) => t.stop());
    state.stream = null;
    const v = $('phone-feed');
    if (v) v.srcObject = null;
  }
  function switchPhoneCamera() {
    if (state.phoneDevices.length < 2) return;
    const cur = state.stream && state.stream.getVideoTracks()[0];
    const curId = cur && cur.getSettings ? cur.getSettings().deviceId : state.settings.phoneDeviceId;
    const i = state.phoneDevices.findIndex((d) => d.deviceId === curId);
    const next = state.phoneDevices[(i + 1) % state.phoneDevices.length];
    state.settings.phoneDeviceId = next.deviceId;
    saveSettings();
    startPhone();
    if (next.label) toast(shortLabel(next.label));
  }

  // ---------------------------------------------------------------- capture
  async function capture() {
    let source;
    try {
      if (state.source === 'usb') {
        const res = await fetch('/usbcam/still.jpg?n=' + Date.now(), { cache: 'no-store' });
        if (!res.ok) throw new Error('No picture from the webcam yet. Check that it is connected.');
        source = await blobToImage(await res.blob());
      } else {
        const v = $('phone-feed');
        if (!state.stream || !v.videoWidth) throw new Error('Camera is not ready yet.');
        source = v;
      }
    } catch (e) { toast(e.message || String(e), 3500); return; }
    const w = source.videoWidth || source.naturalWidth || source.width;
    const h = source.videoHeight || source.naturalHeight || source.height;
    setStill(source, w, h, state.settings.flip);
  }

  function blobToImage(blob) {
    return new Promise((resolve, reject) => {
      const url = URL.createObjectURL(blob);
      const img = new Image();
      img.onload = () => { URL.revokeObjectURL(url); resolve(img); };
      img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('Could not read that image.')); };
      img.src = url;
    });
  }

  function setStill(source, w, h, flip) {
    const c = document.createElement('canvas');
    c.width = w; c.height = h;
    const ctx = c.getContext('2d');
    if (flip) { ctx.translate(w, h); ctx.rotate(Math.PI); }
    ctx.drawImage(source, 0, 0, w, h);
    state.still = c;
    state.crop = null;
    if (state.settings.skipReview) { startSolve(); return; }
    openReview();
  }

  async function onFilePicked(file) {
    if (!file) return;
    try {
      const img = await blobToImage(file);
      setStill(img, img.naturalWidth, img.naturalHeight, false);
    } catch (e) { toast(e.message); }
  }

  // ---------------------------------------------------------------- review + crop
  function openReview() {
    show('review');
    const c = $('review-canvas');
    const s = state.still;
    c.width = s.width; c.height = s.height;
    c.getContext('2d').drawImage(s, 0, 0);
    $('crop-box').hidden = true;
    $('btn-crop-clear').hidden = true;
    $('crop-tip').textContent = 'Drag over the problem to crop (optional)';
  }

  function bindCrop() {
    const stage = $('crop-stage');
    const box = $('crop-box');
    let start = null;
    const local = (e) => {
      const r = stage.getBoundingClientRect();
      return { x: Math.max(0, Math.min(r.width, e.clientX - r.left)), y: Math.max(0, Math.min(r.height, e.clientY - r.top)), r };
    };
    stage.addEventListener('pointerdown', (e) => { start = local(e); stage.setPointerCapture(e.pointerId); });
    stage.addEventListener('pointermove', (e) => {
      if (!start) return;
      const p = local(e);
      const x = Math.min(start.x, p.x), y = Math.min(start.y, p.y), w = Math.abs(p.x - start.x), h = Math.abs(p.y - start.y);
      if (w < 6 && h < 6) return;
      box.hidden = false;
      Object.assign(box.style, { left: x + 'px', top: y + 'px', width: w + 'px', height: h + 'px' });
    });
    stage.addEventListener('pointerup', (e) => {
      if (!start) return;
      const p = local(e);
      const r = p.r;
      const x = Math.min(start.x, p.x), y = Math.min(start.y, p.y), w = Math.abs(p.x - start.x), h = Math.abs(p.y - start.y);
      start = null;
      if (w < 24 || h < 24) { clearCrop(); return; }
      const sx = state.still.width / r.width, sy = state.still.height / r.height;
      state.crop = { x: Math.round(x * sx), y: Math.round(y * sy), w: Math.round(w * sx), h: Math.round(h * sy) };
      $('btn-crop-clear').hidden = false;
      $('crop-tip').textContent = 'Only the highlighted area will be solved';
    });
  }
  function clearCrop() {
    state.crop = null;
    $('crop-box').hidden = true;
    $('btn-crop-clear').hidden = true;
    $('crop-tip').textContent = 'Drag over the problem to crop (optional)';
  }

  function exportImage(maxSide) {
    const s = state.still;
    const r = state.crop || { x: 0, y: 0, w: s.width, h: s.height };
    const k = Math.min(1, maxSide / Math.max(r.w, r.h));
    // small crops get upscaled a little so fine print stays legible
    const up = Math.max(r.w, r.h) < 900 ? Math.min(2, 900 / Math.max(r.w, r.h)) : 1;
    const scale = k < 1 ? k : up;
    const c = document.createElement('canvas');
    c.width = Math.max(1, Math.round(r.w * scale));
    c.height = Math.max(1, Math.round(r.h * scale));
    const ctx = c.getContext('2d');
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(s, r.x, r.y, r.w, r.h, 0, 0, c.width, c.height);
    return c;
  }

  // ---------------------------------------------------------------- solve
  const PHASE_TEXT = {
    reading: 'Reading the problem…',
    thinking: 'Figuring out the method…',
    computing: 'Checking the math with code…',
    writing: 'Writing the steps…',
    resolving: 'Answers differed — re-checking carefully…',
    retry: 'Connection hiccup — retrying…',
  };

  async function startSolve(overrides) {
    overrides = overrides || {};
    state.lastOverrides = overrides;
    const st = state.settings;
    if (!st.apiKey) { openSheet('settings'); toast('Add your Anthropic API key first.'); return; }
    let imageBase64, thumb;
    if (overrides.entry && overrides.entry.image) {
      imageBase64 = overrides.entry.image;
      thumb = overrides.entry.thumb;
    } else {
      if (!state.still) { toast('Capture a problem first.'); return; }
      const canvas = exportImage(2576);           // high-resolution limit of current Claude models
      imageBase64 = canvas.toDataURL('image/jpeg', 0.92).split(',')[1];
      thumb = makeThumb(canvas);
    }
    const note = overrides.note != null ? overrides.note : $('note-input').value;
    const effort = overrides.effort || st.effort;

    const ac = new AbortController();
    state.abort = ac;
    const t0 = Date.now();
    let phase = 'reading', chars = 0, steps = 0;
    $('working').hidden = false;
    const tick = () => {
      const sec = Math.round((Date.now() - t0) / 1000);
      $('working-phase').textContent = PHASE_TEXT[phase] || 'Working…';
      const extra = phase === 'writing' && steps ? ' · ' + steps + ' step' + (steps === 1 ? '' : 's') + ' written' : '';
      $('working-meta').textContent = sec + 's' + extra + (st.doubleCheck ? ' · solving twice to double-check' : '');
      const pct = phase === 'reading' ? 6 : phase === 'resolving' ? Math.min(97, 75 + sec * 0.1)
        : (phase === 'thinking' || phase === 'computing' || phase === 'retry') ? Math.min(60, 10 + sec * 0.6) : Math.min(95, 62 + chars / 150);
      $('working-bar').style.width = pct + '%';
    };
    tick();
    const timer = setInterval(tick, 500);
    let written = '';

    try {
      const out = await Solver.solve({
        apiKey: st.apiKey, model: st.model, effort, detail: st.detail,
        imageBase64, mediaType: 'image/jpeg', note, signal: ac.signal,
        useCode: st.useCode !== false, doubleCheck: !!st.doubleCheck,
        onProgress: (p) => {
          if (p.phase && !(phase === 'resolving' && p.phase === 'writing' && !p.delta)) phase = p.phase;
          if (p.delta) { written += p.delta; chars = written.length; steps = (written.match(/"explanation"\s*:/g) || []).length; }
          if (p.phase === 'resolving') { written = ''; chars = 0; steps = 0; }
        },
      });
      const entry = {
        id: Date.now().toString(36), ts: Date.now(), model: out.model, effort,
        usage: out.usage, note, thumb, image: imageBase64.length < 1500000 ? imageBase64 : null, result: out.result,
        verification: out.verification, usedCode: out.usedCode, chat: [],
      };
      state.last = entry;
      persistEntry(entry);
      $('btn-last').disabled = false;
      showSolution(entry);
    } catch (err) {
      if (err.name === 'AbortError') { toast('Cancelled'); }
      else showError(err);
    } finally {
      clearInterval(timer);
      $('working').hidden = true;
      state.abort = null;
    }
  }

  // History keeps the newest few images (needed for re-solve and follow-up questions).
  function persistEntry(entry) {
    const hist = loadHistory().filter((h) => h.id !== entry.id);
    hist.unshift(entry);
    saveHistory(hist.slice(0, MAX_HISTORY).map((h, i) => (i < 4 ? h : Object.assign({}, h, { image: null }))));
  }

  function makeThumb(canvas) {
    const w = 320, h = Math.round(canvas.height * (320 / canvas.width));
    const c = document.createElement('canvas');
    c.width = w; c.height = h;
    c.getContext('2d').drawImage(canvas, 0, 0, w, h);
    return c.toDataURL('image/jpeg', 0.6);
  }

  function explainError(err) {
    const s = err.status;
    if (s === 401) return 'Your API key was rejected. Open Settings and paste a valid key from console.anthropic.com.';
    if (s === 403) return 'This API key is not allowed to use that model. Try another model in Settings.';
    if (s === 404) return 'Model not found: ' + state.settings.model + '. Pick another model in Settings.';
    if (s === 429 && err.code === 'enforced_spend_limit_reached') return 'Your Anthropic monthly spend limit is reached. Raise it at console.anthropic.com → Settings → Limits.';
    if (s === 429) return 'Rate limit reached for your API key, even after retrying. Wait a minute and tap Try again.';
    if (s === 400 && /credit|billing|balance/i.test(err.message)) return 'Your Anthropic account is out of credits. Add credits at console.anthropic.com → Billing.';
    if (s === 529 || s === 503 || s === 500 || s === 502) return 'Anthropic\'s servers are busy right now (retried automatically). Try again in a minute.';
    if (err.type === 'network' || err.type === 'stall' || err instanceof TypeError) return 'The internet connection kept dropping (retried automatically). Check the phone\'s Wi-Fi and tap Try again.';
    return err.message || String(err);
  }

  function showError(err) {
    const box = $('solution');
    box.innerHTML = '';
    const n = document.createElement('div');
    n.className = 'notice error';
    n.textContent = explainError(err);
    const retry = document.createElement('button');
    retry.className = 'btn btn-secondary btn-small';
    retry.textContent = 'Try again';
    retry.onclick = () => startSolve(state.lastOverrides || {});
    n.appendChild(document.createElement('br'));
    n.appendChild(retry);
    box.appendChild(n);
    $('chat').hidden = true;
    state.viewing = null;
    show('solution');
  }

  // ---------------------------------------------------------------- render solution
  const VERIFY_UI = {
    confirmed: { cls: 'ok', icon: '✓', title: 'Double-checked' },
    resolved: { cls: 'fixed', icon: '✓', title: 'Corrected after double-check' },
    single: { cls: 'warn', icon: '!', title: 'Not double-checked' },
    disputed: { cls: 'warn', icon: '!', title: 'Solutions disagreed' },
  };

  function showSolution(entry) {
    state.viewing = entry;
    const box = $('solution');
    box.innerHTML = '';
    box.classList.remove('answers-only');
    $('btn-answers-only').classList.remove('on');
    const R = entry.result;

    const meta = document.createElement('div');
    meta.className = 'sol-meta';
    if (entry.thumb) {
      const im = document.createElement('img');
      im.className = 'sol-thumb';
      im.src = entry.thumb;
      im.alt = 'Captured problem';
      meta.appendChild(im);
    }
    const mt = document.createElement('div');
    mt.className = 'sol-meta-text';
    const modelName = { 'claude-opus-5-5': 'Opus 5.5', 'claude-sonnet-5-5': 'Sonnet 5.5', 'claude-haiku-5-5': 'Haiku 5.5' }[entry.model] || entry.model;
    mt.innerHTML = '<b>' + R.problems.length + ' problem' + (R.problems.length === 1 ? '' : 's') + ' solved</b><br>' +
      Rich.esc(modelName) + ' · ' + Rich.esc(entry.effort || '') + ' effort' + (entry.usedCode ? ' · math checked with code' : '') + '<br>' +
      new Date(entry.ts).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' });
    meta.appendChild(mt);
    box.appendChild(meta);

    const v = entry.verification && VERIFY_UI[entry.verification.status];
    if (v) {
      const vb = document.createElement('div');
      vb.className = 'verify ' + v.cls;
      vb.innerHTML = '<span class="verify-icon">' + v.icon + '</span><div><b>' + v.title + '</b><div class="rich">' + Rich.render(entry.verification.summary || '') + '</div></div>';
      box.appendChild(vb);
    }

    if (!R.image_readable || R.notes) {
      const n = document.createElement('div');
      n.className = 'notice';
      n.innerHTML = (R.image_readable ? '' : '<b>The picture was hard to read.</b> Retake it closer or crop to the problem.<br>') + Rich.render(R.notes || '');
      box.appendChild(n);
    }
    if (!R.problems.length) {
      const n = document.createElement('div');
      n.className = 'notice';
      n.textContent = 'No problem was found in the picture. Make sure the problem fills most of the frame and is in focus.';
      box.appendChild(n);
    }

    const graphJobs = [];
    R.problems.forEach((p, pi) => {
      const card = document.createElement('article');
      card.className = 'problem';

      const head = document.createElement('div');
      head.className = 'problem-head';
      head.innerHTML = '<span class="problem-label">' + Rich.esc(p.label || ('Problem ' + (pi + 1))) + '</span>' +
        (p.subject ? '<span class="subject">' + Rich.esc(p.subject) + '</span>' : '');
      card.appendChild(head);

      // Question and answer together
      const qa = document.createElement('div');
      qa.className = 'qa';
      qa.appendChild(div('qa-label', 'Question'));
      qa.appendChild(div('statement rich', Rich.render(p.statement || '—')));
      const ans = document.createElement('div');
      ans.className = 'answer';
      ans.innerHTML = '<div class="answer-label">Answer</div><div class="answer-main rich">' + Rich.render(p.final_answer || '—') + '</div>';
      if (p.answer_entry) {
        const row = document.createElement('div');
        row.className = 'answer-entry';
        row.innerHTML = '<span>Type:</span><code>' + Rich.esc(p.answer_entry) + '</code>';
        const cp = document.createElement('button');
        cp.className = 'chip';
        cp.textContent = 'Copy';
        cp.onclick = () => copyText(p.answer_entry).then(() => toast('Copied: ' + p.answer_entry));
        row.appendChild(cp);
        ans.appendChild(row);
      }
      qa.appendChild(ans);
      card.appendChild(qa);

      // How to solve it
      if (p.method || p.strategy) {
        const how = document.createElement('div');
        how.className = 'how';
        how.innerHTML = '<div class="section-label">How to solve it</div>' +
          (p.method ? '<div class="method"><span>Method</span>' + Rich.esc(p.method) + '</div>' : '') +
          (p.strategy ? '<div class="strategy rich">' + Rich.render(p.strategy) + '</div>' : '');
        card.appendChild(how);
      }

      if (p.steps.length) {
        card.appendChild(div('section-label steps-label', 'Step-by-step explanation'));
        const ol = document.createElement('ol');
        ol.className = 'steps';
        p.steps.forEach((s) => {
          const li = document.createElement('li');
          li.className = 'step';
          li.appendChild(div('step-title rich', Rich.render(s.title).replace(/^<p>|<\/p>$/g, '')));
          if (s.work) li.appendChild(div('step-work rich', Rich.render(s.work)));
          if (s.explanation) li.appendChild(div('step-why rich', Rich.render(s.explanation)));
          ol.appendChild(li);
        });
        card.appendChild(ol);
      }

      if (p.graphs.length) {
        const g = document.createElement('div');
        g.className = 'graphs';
        card.appendChild(g);
        p.graphs.forEach((spec) => graphJobs.push([g, spec]));
      }

      if (p.check) {
        const d = document.createElement('div');
        d.className = 'check';
        d.innerHTML = '<div class="section-label">How we know it\'s right</div><div class="check-body rich">' + Rich.render(p.check) + '</div>';
        card.appendChild(d);
      }

      // final recap so the answer is also at the end of the explanation
      if (p.steps.length > 2) {
        const recap = document.createElement('div');
        recap.className = 'recap';
        recap.innerHTML = '<span>Final answer</span><div class="rich">' + Rich.render(p.final_answer || '—') + '</div>';
        card.appendChild(recap);
      }
      box.appendChild(card);
    });

    renderChat(entry);
    show('solution');
    $('solution-scroll').scrollTop = 0;
    requestAnimationFrame(() => {
      graphJobs.forEach(([host, spec]) => {
        try { new Graph(host, spec); } catch (e) {
          host.appendChild(div('graph-errors', 'Graph could not be drawn: ' + Rich.esc(e.message)));
        }
      });
    });
    $('btn-resolve').disabled = !(entry.image || state.still);
  }

  // ---------------------------------------------------------------- follow-up chat
  function renderChat(entry) {
    const wrap = $('chat');
    wrap.hidden = !entry.result.problems.length;
    const list = $('chat-list');
    list.innerHTML = '';
    (entry.chat || []).forEach((m) => list.appendChild(chatItem(m.q, m.a)));
    $('chat-input').value = '';
  }
  function chatItem(q, a) {
    const item = document.createElement('div');
    item.className = 'chat-item';
    item.appendChild(div('chat-q', Rich.esc(q)));
    const ans = div('chat-a rich', a ? Rich.render(a) : '<span class="chat-wait">Thinking…</span>');
    item.appendChild(ans);
    return item;
  }
  async function sendChat(text) {
    const entry = state.viewing;
    const q = (text || '').trim();
    if (!entry || !q || state.chatAbort) return;
    const st = state.settings;
    if (!st.apiKey) { openSheet('settings'); return; }
    $('chat-input').value = '';
    const item = chatItem(q, '');
    $('chat-list').appendChild(item);
    const ansEl = item.querySelector('.chat-a');
    item.scrollIntoView({ behavior: 'smooth', block: 'start' });
    const ac = new AbortController();
    state.chatAbort = ac;
    $('chat-send').disabled = true;
    let pending = null;
    const paint = (t) => {
      if (pending) return;
      pending = requestAnimationFrame(() => { pending = null; ansEl.innerHTML = Rich.render(t); });
    };
    try {
      const out = await Solver.ask({
        apiKey: st.apiKey, model: st.model, entry, history: entry.chat || [], question: q, signal: ac.signal,
        useCode: st.useCode !== false,
        onText: paint,
        onStatus: (s) => { if (!ansEl.textContent || ansEl.querySelector('.chat-wait')) ansEl.innerHTML = '<span class="chat-wait">' + Rich.esc(s) + '</span>'; },
      });
      if (pending) cancelAnimationFrame(pending);
      ansEl.innerHTML = Rich.render(out.text);
      entry.chat = (entry.chat || []).concat([{ q, a: out.text }]);
      persistEntry(entry);
    } catch (err) {
      ansEl.innerHTML = '<span class="chat-err">' + Rich.esc(err.name === 'AbortError' ? 'Stopped.' : explainError(err)) + '</span>';
    } finally {
      state.chatAbort = null;
      $('chat-send').disabled = false;
    }
  }

  function div(cls, html) { const d = document.createElement('div'); d.className = cls; d.innerHTML = html; return d; }

  function copyText(t) {
    if (NATIVE && NATIVE.copy) { try { NATIVE.copy(t); return Promise.resolve(); } catch (e) { /* fall through */ } }
    if (navigator.clipboard && navigator.clipboard.writeText) return navigator.clipboard.writeText(t).catch(() => legacyCopy(t));
    legacyCopy(t);
    return Promise.resolve();
  }
  function legacyCopy(t) {
    const ta = document.createElement('textarea');
    ta.value = t; document.body.appendChild(ta); ta.select();
    try { document.execCommand('copy'); } catch (e) { /* ignore */ }
    ta.remove();
  }

  // ---------------------------------------------------------------- sheets
  function openSheet(name) {
    $(name + '-backdrop').hidden = false;
    $(name + '-sheet').hidden = false;
    if (name === 'settings') fillSettings();
    if (name === 'history') renderHistory();
  }
  function closeSheet(name) {
    $(name + '-backdrop').hidden = true;
    $(name + '-sheet').hidden = true;
    if (name === 'settings') readSettings();
  }
  function anySheetOpen() { return ['settings', 'history'].find((n) => !$(n + '-sheet').hidden); }

  function fillSettings() {
    const s = state.settings;
    $('set-key').value = s.apiKey;
    $('set-model').value = s.model;
    $('set-effort').value = s.effort;
    $('set-detail').value = s.detail;
    $('set-usbres').value = s.usbRes;
    $('set-skip-review').checked = !!s.skipReview;
    $('set-double').checked = !!s.doubleCheck;
    $('set-code').checked = s.useCode !== false;
    $('field-usbres').hidden = !NATIVE;
    $('key-test-result').textContent = '';
  }
  function readSettings() {
    const s = state.settings;
    const prevRes = s.usbRes;
    s.apiKey = $('set-key').value.trim();
    s.model = $('set-model').value;
    s.effort = $('set-effort').value;
    s.detail = $('set-detail').value;
    s.usbRes = $('set-usbres').value;
    s.skipReview = $('set-skip-review').checked;
    s.doubleCheck = $('set-double').checked;
    s.useCode = $('set-code').checked;
    saveSettings();
    if (NATIVE && prevRes !== s.usbRes && NATIVE.setResolution) {
      try { NATIVE.setResolution(parseInt(s.usbRes, 10)); toast('Restarting webcam at ' + s.usbRes + 'p…'); } catch (e) { /* ignore */ }
    }
  }

  function renderHistory() {
    const list = loadHistory();
    const box = $('history-list');
    box.innerHTML = '';
    if (!list.length) { box.appendChild(div('hist-empty', 'Solutions you get will appear here.')); return; }
    list.forEach((h) => {
      const b = document.createElement('button');
      b.className = 'hist-item';
      const first = (h.result && h.result.problems && h.result.problems[0]) || {};
      const title = (first.label ? first.label + ': ' : '') + plain(first.statement || 'Solution');
      b.innerHTML = (h.thumb ? '<img src="' + h.thumb + '" alt="">' : '') +
        '<div class="hist-text"><div class="hist-title">' + Rich.esc(title) + '</div><div class="hist-sub">' +
        Rich.esc(new Date(h.ts).toLocaleString([], { dateStyle: 'short', timeStyle: 'short' }) + ' · ' + plain(first.answer_entry || first.final_answer || '')) + '</div></div>';
      b.onclick = () => { closeSheet('history'); state.still = null; state.last = h; showSolution(h); };
      box.appendChild(b);
    });
    const clear = document.createElement('button');
    clear.className = 'btn btn-ghost btn-small';
    clear.textContent = 'Clear history';
    clear.onclick = () => { if (confirm('Delete all saved solutions?')) { saveHistory([]); renderHistory(); } };
    box.appendChild(clear);
  }
  function plain(s) { return String(s).replace(/\$+/g, '').replace(/\\[a-z]+/gi, ' ').replace(/[{}]/g, '').replace(/\s+/g, ' ').trim().slice(0, 90); }

  // ---------------------------------------------------------------- setup check
  async function runSetupCheck() {
    readSettings();
    const st = state.settings;
    const out = $('key-test-result');
    const rows = [];
    const paint = () => { out.innerHTML = rows.map((r) => '<div class="chk ' + r[0] + '"><i>' + (r[0] === 'ok' ? '✓' : r[0] === 'bad' ? '✗' : '…') + '</i>' + Rich.esc(r[1]) + '</div>').join(''); };
    if (!st.apiKey) { rows.push(['bad', 'Paste your API key first.']); paint(); return; }
    rows.push(['wait', 'Checking API key, model and credits…']); paint();
    let r;
    try { r = await Solver.testKey(st.apiKey, st.model); } catch (e) { r = { ok: false, message: 'No internet connection' }; }
    rows[0] = r.ok ? ['ok', 'API key, model and credits OK'] : ['bad', explainError(Object.assign(new Error(r.message || 'Failed'), { status: r.status, code: r.code, type: r.status ? '' : 'network' }))];
    paint();
    if (NATIVE) {
      let ws = {};
      try { ws = JSON.parse(NATIVE.status()); } catch (e) { /* ignore */ }
      let frameOk = false;
      try { frameOk = (await fetch('/usbcam/still.jpg?n=' + Date.now(), { cache: 'no-store' })).ok; } catch (e) { /* ignore */ }
      rows.push(frameOk ? ['ok', 'USB webcam: ' + (ws.device || 'connected') + (ws.width ? ' · ' + ws.width + '×' + ws.height : '')]
        : ['bad', 'USB webcam not sending pictures (' + (ws.state || 'unknown').replace(/_/g, ' ') + '). Plug it in and tap Connect webcam.']);
      paint();
    }
    if (rows.every((x) => x[0] === 'ok')) { rows.push(['ok', 'Everything is ready.']); paint(); }
  }

  // ---------------------------------------------------------------- back button (Android)
  window.stepcamBack = function () {
    const sheet = anySheetOpen();
    if (sheet) { closeSheet(sheet); return true; }
    if (state.abort) { state.abort.abort(); return true; }
    if (state.chatAbort) { state.chatAbort.abort(); return true; }
    const cur = current();
    if (cur === 'review' || cur === 'solution') { show('capture'); return true; }
    return false;
  };
  // called by the app when a USB camera is plugged in
  window.stepcamUsbAttached = function () { if (NATIVE) setSource('usb'); };

  // ---------------------------------------------------------------- wire up
  function init() {
    $('seg-usb').hidden = !NATIVE;
    if (!NATIVE) $('seg-phone').textContent = 'Camera';
    $('seg-usb').onclick = () => setSource('usb');
    $('seg-phone').onclick = () => setSource('phone');
    $('file-input').onchange = (e) => { onFilePicked(e.target.files[0]); e.target.value = ''; };
    $('btn-connect').onclick = () => {
      if (NATIVE) { try { NATIVE.connect(); } catch (e) { /* ignore */ } setStatus('wait', 'Connecting…'); }
    };
    $('btn-cam-switch').onclick = switchPhoneCamera;
    $('btn-shutter').onclick = capture;
    $('btn-rotate').onclick = () => {
      state.settings.flip = !state.settings.flip;
      saveSettings();
      applyFlip();
      toast(state.settings.flip ? 'Image flipped 180°' : 'Image orientation normal');
    };
    $('btn-last').onclick = () => { if (state.last) showSolution(state.last); };
    $('btn-settings').onclick = () => openSheet('settings');
    $('btn-history').onclick = () => openSheet('history');
    document.querySelectorAll('[data-close]').forEach((b) => { b.onclick = () => closeSheet(b.dataset.close); });
    $('settings-backdrop').onclick = () => closeSheet('settings');
    $('history-backdrop').onclick = () => closeSheet('history');
    $('btn-key-show').onclick = () => {
      const k = $('set-key');
      k.type = k.type === 'password' ? 'text' : 'password';
      $('btn-key-show').textContent = k.type === 'password' ? 'Show' : 'Hide';
    };
    $('btn-key-test').onclick = runSetupCheck;
    $('chat-form').onsubmit = (e) => { e.preventDefault(); sendChat($('chat-input').value); };
    document.querySelectorAll('[data-ask]').forEach((b) => { b.onclick = () => sendChat(b.dataset.ask); });

    bindCrop();
    $('btn-crop-clear').onclick = clearCrop;
    $('btn-review-back').onclick = () => show('capture');
    $('btn-retake').onclick = () => show('capture');
    $('btn-solve').onclick = () => startSolve();
    $('btn-cancel').onclick = () => { if (state.abort) state.abort.abort(); };
    $('btn-solution-back').onclick = () => show('capture');
    $('btn-new').onclick = () => { $('note-input').value = ''; show('capture'); };
    $('btn-resolve').onclick = () => {
      if (state.still) startSolve({ effort: 'max' });
      else if (state.viewing && state.viewing.image) startSolve({ effort: 'max', entry: state.viewing, note: state.viewing.note || '' });
    };
    $('btn-answers-only').onclick = () => {
      const on = $('solution').classList.toggle('answers-only');
      $('btn-answers-only').classList.toggle('on', on);
    };

    applyFlip();
    const hist = loadHistory();
    if (hist.length) { state.last = hist[0]; $('btn-last').disabled = false; }
    setSource(state.settings.source);
    if (!state.settings.apiKey) setTimeout(() => openSheet('settings'), 400);
  }
  function applyFlip() {
    $('viewport').classList.toggle('flipped', !!state.settings.flip);
    $('btn-rotate').classList.toggle('on', !!state.settings.flip);
  }

  document.addEventListener('visibilitychange', () => {
    if (document.hidden) pauseSource();
    else if (current() === 'capture') resumeSource();
  });

  init();
})();
