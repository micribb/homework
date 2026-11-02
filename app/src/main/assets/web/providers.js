/*
 * providers.js — Google Gemini and OpenAI (ChatGPT) adapters for StepCam.
 *
 * Both are called directly from the phone with streaming responses and share one interface:
 *   Providers.call({provider, apiKey, model, effort, system, turns, schema, tools, signal, onEvent, maxTokens})
 *     turns: [{role: 'user'|'assistant', text, image?: base64 JPEG}]
 *     -> { text, usage: {input_tokens, output_tokens}, usedCode, stopReason: 'end_turn'|'max_tokens'|'refusal' }
 *   Errors are ProviderError with {status, retryable, retryAfter, kind}.
 * Features a model/account doesn't accept (structured output, code tool, thinking settings…) are
 * dropped automatically and the request is retried, so the app keeps working as the APIs change.
 */
(function (global) {
  'use strict';

  const STALL_MS = () => global.__STALL_MS || 240000; // 4 min of total silence = dead connection

  // ------------------------------------------------------------------ provider catalogue
  const CATALOG = {
    gemini: {
      name: 'Google Gemini',
      short: 'Gemini',
      free: true,
      keyHelp: 'Free key: aistudio.google.com/apikey → Create API key (starts with AIza). No credit card needed.',
      models: [
        { id: 'gemini-3.8-flash', label: 'Gemini 3.8 Flash — free, recommended' },
        { id: 'gemini-3.6-flash', label: 'Gemini 3.6 Flash — free' },
        { id: 'gemini-3.5-flash-lite', label: 'Gemini 3.5 Flash-Lite — free, fastest' },
        { id: 'gemini-3.1-pro-preview', label: 'Gemini 3.1 Pro — paid (needs billing)' },
      ],
    },
    openai: {
      name: 'OpenAI (ChatGPT)',
      short: 'ChatGPT',
      free: false,
      keyHelp: 'platform.openai.com → API keys (starts with sk-). Billed per use by OpenAI.',
      models: [
        { id: 'gpt-5.6-sol', label: 'GPT-5.6 Sol — accurate, recommended' },
        { id: 'gpt-6-astra', label: 'GPT-6 Astra — flagship, most expensive' },
        { id: 'gpt-5.6-terra', label: 'GPT-5.6 Terra — cheaper' },
        { id: 'gpt-5.6-luna', label: 'GPT-5.6 Luna — cheapest' },
      ],
    },
    anthropic: {
      name: 'Anthropic Claude',
      short: 'Claude',
      free: false,
      keyHelp: 'console.anthropic.com → API Keys (starts with sk-ant-). Billed per use by Anthropic.',
      models: [
        { id: 'claude-opus-5-5', label: 'Claude Opus 5.5 — most accurate' },
        { id: 'claude-sonnet-5-5', label: 'Claude Sonnet 5.5 — faster, cheaper' },
        { id: 'claude-haiku-5-5', label: 'Claude Haiku 5.5 — fastest, cheapest' },
      ],
    },
  };

  function detect(key) {
    const k = String(key || '').trim();
    if (/^AIza[0-9A-Za-z_\-]{20,}$/.test(k)) return 'gemini';
    if (/^AQ\.[0-9A-Za-z_\-.]{20,}$/.test(k)) return 'gemini'; // newer Google key format
    if (/^sk-ant-/.test(k)) return 'anthropic';
    if (/^sk-[A-Za-z0-9_\-]{10,}/.test(k)) return 'openai';
    return null;
  }

  function modelLabel(id) {
    for (const p of Object.values(CATALOG)) {
      const m = p.models.find((x) => x.id === id);
      if (m) return m.label.split(' — ')[0];
    }
    return id;
  }

  // ------------------------------------------------------------------ errors / helpers
  class ProviderError extends Error {
    constructor(status, message, extra) { super(message); this.status = status; Object.assign(this, extra || {}); }
  }
  const isAbort = (e) => e && e.name === 'AbortError';
  const sleep = (ms, signal) => new Promise((resolve, reject) => {
    const t = setTimeout(resolve, ms);
    if (signal) signal.addEventListener('abort', () => { clearTimeout(t); reject(new DOMException('Aborted', 'AbortError')); }, { once: true });
  });

  // POST + read an SSE stream; calls onData(json, eventName) for each event.
  async function streamPost(url, headers, body, signal, onData, parseError) {
    const local = new AbortController();
    let stalled = false, timer = null;
    const bump = () => { clearTimeout(timer); timer = setTimeout(() => { stalled = true; local.abort(); }, STALL_MS()); };
    const onOuter = () => local.abort();
    if (signal) { if (signal.aborted) throw new DOMException('Aborted', 'AbortError'); signal.addEventListener('abort', onOuter, { once: true }); }
    bump();
    try {
      let res;
      try {
        res = await fetch(url, { method: 'POST', headers, body: JSON.stringify(body), signal: local.signal });
      } catch (e) {
        if (stalled) throw new ProviderError(0, 'No data from the AI for 4 minutes.', { kind: 'stall', retryable: true, detail: 'stream silent > ' + Math.round(STALL_MS() / 1000) + 's' });
        if (isAbort(e)) throw e;
        throw new ProviderError(0, 'Network error: ' + (e.message || e), { kind: 'network', retryable: true, detail: String(e.message || e) });
      }
      if (!res.ok) {
        let j = null;
        try { j = await res.json(); } catch (e) { /* ignore */ }
        throw parseError(res, j);
      }
      const reader = res.body.getReader();
      const dec = new TextDecoder();
      let buf = '';
      for (;;) {
        let chunk;
        try { chunk = await reader.read(); } catch (e) {
          if (stalled) throw new ProviderError(0, 'No data from the AI for 4 minutes.', { kind: 'stall', retryable: true, detail: 'stream silent > ' + Math.round(STALL_MS() / 1000) + 's' });
          if (isAbort(e) || (signal && signal.aborted)) throw new DOMException('Aborted', 'AbortError');
          throw new ProviderError(0, 'Connection dropped.', { kind: 'network', retryable: true });
        }
        if (chunk.done) break;
        bump();
        buf += dec.decode(chunk.value, { stream: true }).replace(/\r\n/g, '\n');
        let idx;
        while ((idx = buf.indexOf('\n\n')) >= 0) {
          const raw = buf.slice(0, idx);
          buf = buf.slice(idx + 2);
          let ev = '', data = [];
          for (const line of raw.split('\n')) {
            if (line.startsWith('event:')) ev = line.slice(6).trim();
            else if (line.startsWith('data:')) data.push(line.slice(5).trimStart());
          }
          if (!data.length || data[0] === '[DONE]') continue;
          let j;
          try { j = JSON.parse(data.join('\n')); } catch (e) { continue; }
          onData(j, ev || j.type || '');
        }
      }
      if (buf.trim().startsWith('data:')) {
        try { onData(JSON.parse(buf.trim().slice(5).trim()), ''); } catch (e) { /* ignore partial */ }
      }
    } catch (e) {
      if (stalled && isAbort(e)) throw new ProviderError(0, 'No data from the AI for 4 minutes.', { kind: 'stall', retryable: true, detail: 'stream silent > ' + Math.round(STALL_MS() / 1000) + 's' });
      throw e;
    } finally {
      clearTimeout(timer);
      if (signal) signal.removeEventListener('abort', onOuter);
    }
  }

  async function withRetries(fn, signal, onEvent) {
    const delays = [2000, 5000, 12000, 25000];
    let stalls = 0;
    for (let attempt = 0; ; attempt++) {
      try { return await fn(); } catch (e) {
        if (e && e.kind === 'stall' && ++stalls > 1) throw e;           // don't wait out several silent streams
        if (e && e.kind === 'network' && attempt >= 3) throw e;
        if (isAbort(e) || !e.retryable || attempt >= delays.length) throw e;
        const wait = e.retryAfter != null ? Math.min(65, e.retryAfter) * 1000 + 300 : delays[attempt];
        onEvent({ kind: 'retry', error: e, wait });
        await sleep(wait, signal);
      }
    }
  }

  // ------------------------------------------------------------------ schema conversion
  // OpenAI strict mode prefers nullable types as ["number","null"] instead of anyOf.
  function toTypeArrays(schema) {
    if (Array.isArray(schema)) return schema.map(toTypeArrays);
    if (!schema || typeof schema !== 'object') return schema;
    if (Array.isArray(schema.anyOf) && schema.anyOf.every((s) => s && typeof s.type === 'string' && Object.keys(s).length === 1)) {
      const out = Object.assign({}, schema, { type: schema.anyOf.map((s) => s.type) });
      delete out.anyOf;
      return out;
    }
    const out = {};
    for (const [k, v] of Object.entries(schema)) out[k] = toTypeArrays(v);
    return out;
  }

  // ------------------------------------------------------------------ Google Gemini
  function geminiError(res, j) {
    const e = (j && j.error) || {};
    const msg = e.message || (res.status + ' ' + (res.statusText || ''));
    const details = e.details || [];
    const retryInfo = details.find((d) => /RetryInfo/.test(d['@type'] || ''));
    const quota = details.find((d) => /QuotaFailure/.test(d['@type'] || ''));
    const quotaIds = quota ? (quota.violations || []).map((v) => v.quotaId || v.quotaMetric || '').join(' ') : '';
    let retryAfter = null;
    if (retryInfo && retryInfo.retryDelay) retryAfter = parseFloat(String(retryInfo.retryDelay)) || null;
    const daily = res.status === 429 && /per ?day|PerDay|daily/i.test(quotaIds + ' ' + msg);
    const badKey = /API key not valid|API_KEY_INVALID|API key expired/i.test(msg + JSON.stringify(details));
    const retryable = !daily && [408, 429, 500, 502, 503, 504].includes(res.status);
    return new ProviderError(badKey ? 401 : res.status, msg, {
      retryable, retryAfter: retryable ? retryAfter : null,
      kind: badKey ? 'auth' : daily ? 'daily_quota' : res.status === 429 ? 'rate_limit' : '',
    });
  }

  function geminiThinking(effort) { return effort === 'medium' ? 'medium' : 'high'; }

  async function callGemini(o, feat) {
    const url = 'https://generativelanguage.googleapis.com/v1beta/models/' + encodeURIComponent(o.model) + ':streamGenerateContent?alt=sse';
    const contents = o.turns.map((t) => ({
      role: t.role === 'assistant' ? 'model' : 'user',
      parts: [].concat(t.image ? [{ inlineData: { mimeType: 'image/jpeg', data: t.image } }] : [], [{ text: t.text }]),
    }));
    const gen = { maxOutputTokens: o.maxTokens || 65536 };
    if (feat.thinking) gen.thinkingConfig = Object.assign({ thinkingLevel: geminiThinking(o.effort) }, feat.thoughts ? { includeThoughts: true } : {});
    if (feat.mediaRes && o.turns.some((t) => t.image)) gen.mediaResolution = 'MEDIA_RESOLUTION_HIGH';
    if (o.schema && feat.structured) { gen.responseMimeType = 'application/json'; gen.responseJsonSchema = o.schema; }
    const body = { contents, generationConfig: gen };
    if (o.system) body.systemInstruction = { parts: [{ text: o.system + (o.schema && !feat.structured ? o.jsonInstruction : '') }] };
    if (o.tools && feat.tools) body.tools = [{ codeExecution: {} }];

    const out = { text: '', usage: { input_tokens: 0, output_tokens: 0 }, usedCode: false, stopReason: null, blocked: null };
    let started = false;
    await streamPost(url, { 'content-type': 'application/json', 'x-goog-api-key': o.apiKey }, body, o.signal, (j) => {
      if (!started) { started = true; o.onEvent({ kind: 'start' }); }
      if (j.error) throw geminiError({ status: j.error.code || 500, statusText: '' }, j);
      if (j.promptFeedback && j.promptFeedback.blockReason) out.blocked = j.promptFeedback.blockReason;
      const c = (j.candidates || [])[0];
      if (c) {
        for (const p of (c.content && c.content.parts) || []) {
          if (p.executableCode) { out.usedCode = true; o.onEvent({ kind: 'code' }); }
          else if (p.codeExecutionResult) { /* result of a check */ }
          else if (typeof p.text === 'string') {
            if (p.thought) o.onEvent({ kind: 'thinking' });
            else { out.text += p.text; o.onEvent({ kind: 'text', delta: p.text }); }
          }
        }
        if (c.finishReason) out.stopReason = c.finishReason;
      }
      if (j.usageMetadata) {
        out.usage.input_tokens = j.usageMetadata.promptTokenCount || 0;
        out.usage.output_tokens = (j.usageMetadata.candidatesTokenCount || 0) + (j.usageMetadata.thoughtsTokenCount || 0);
      }
    }, geminiError);
    if (out.blocked) return Object.assign(out, { stopReason: 'refusal' });
    const r = out.stopReason;
    out.stopReason = r === 'MAX_TOKENS' ? 'max_tokens' : (r === 'SAFETY' || r === 'RECITATION' || r === 'PROHIBITED_CONTENT' || r === 'BLOCKLIST' || r === 'SPII') ? 'refusal'
      : (!r && !out.text) ? null : 'end_turn';
    if (!out.stopReason) throw new ProviderError(0, 'The response was cut off.', { kind: 'network', retryable: true });
    return out;
  }

  const GEMINI_FEATURES = [
    { key: 'mediaRes', test: /media_?resolution/i },
    { key: 'thoughts', test: /include_?thoughts/i },
    { key: 'thinking', test: /thinking/i },
    { key: 'tools', test: /code_?execution|tool/i },
    { key: 'structured', test: /response_?(json_)?schema|response_?mime|json|schema/i },
  ];

  // ------------------------------------------------------------------ OpenAI (Responses API)
  function openaiError(res, j) {
    const e = (j && j.error) || {};
    const msg = e.message || (res.status + ' ' + (res.statusText || ''));
    const noCredit = e.code === 'insufficient_quota' || /insufficient_quota|exceeded your current quota|billing/i.test(msg);
    const ra = res.headers && res.headers.get ? parseFloat(res.headers.get('retry-after')) : NaN;
    const retryable = !noCredit && [408, 409, 429, 500, 502, 503, 504].includes(res.status);
    return new ProviderError(res.status, msg, {
      retryable, retryAfter: Number.isFinite(ra) ? ra : null, code: e.code,
      kind: noCredit ? 'no_credit' : res.status === 401 ? 'auth' : res.status === 429 ? 'rate_limit' : '',
    });
  }

  function openaiEffort(effort, feat) {
    if (effort === 'medium') return 'medium';
    if (effort === 'max' && feat.xhigh) return 'xhigh';
    return 'high';
  }

  async function callOpenAI(o, feat) {
    const input = o.turns.map((t) => {
      if (t.role === 'assistant') return { role: 'assistant', content: t.text };
      if (!t.image) return { role: 'user', content: t.text };
      return { role: 'user', content: [
        { type: 'input_image', image_url: 'data:image/jpeg;base64,' + t.image, detail: 'high' },
        { type: 'input_text', text: t.text },
      ] };
    });
    const body = {
      model: o.model,
      input,
      instructions: (o.system || '') + (o.schema && !feat.structured ? o.jsonInstruction : ''),
      stream: true,
      max_output_tokens: o.maxTokens || 64000,
      store: false,
    };
    if (feat.reasoning) body.reasoning = Object.assign({ effort: openaiEffort(o.effort, feat) }, feat.summary ? { summary: 'auto' } : {});
    if (o.schema && feat.structured) body.text = { format: { type: 'json_schema', name: 'stepcam_solution', schema: toTypeArrays(o.schema), strict: true } };
    if (o.tools && feat.tools) body.tools = [{ type: 'code_interpreter', container: { type: 'auto' } }];

    const out = { text: '', usage: { input_tokens: 0, output_tokens: 0 }, usedCode: false, stopReason: null };
    let final = null;
    await streamPost('https://api.openai.com/v1/responses', {
      'content-type': 'application/json', authorization: 'Bearer ' + o.apiKey,
    }, body, o.signal, (j, ev) => {
      const type = j.type || ev;
      if (type === 'response.created') o.onEvent({ kind: 'start' });
      else if (type === 'response.output_text.delta') { out.text += j.delta || ''; o.onEvent({ kind: 'text', delta: j.delta || '' }); }
      else if (type === 'response.output_item.added' && j.item) {
        if (j.item.type === 'code_interpreter_call') { out.usedCode = true; o.onEvent({ kind: 'code' }); }
        else if (j.item.type === 'reasoning') o.onEvent({ kind: 'thinking' });
      } else if (/^response\.reasoning/.test(type)) o.onEvent({ kind: 'thinking' });
      else if (type === 'response.refusal.delta') out.refused = true;
      else if (type === 'response.completed' || type === 'response.incomplete' || type === 'response.failed') final = j.response || null;
      else if (type === 'error') {
        const msg = j.message || (j.error && j.error.message) || 'Stream error';
        const code = j.code || (j.error && j.error.code) || '';
        throw new ProviderError(0, msg, { retryable: /server_error|rate_limit|overloaded/i.test(code + msg), code });
      }
    }, openaiError);
    if (!final) throw new ProviderError(0, 'The response was cut off.', { kind: 'network', retryable: true });
    if (final.usage) out.usage = { input_tokens: final.usage.input_tokens || 0, output_tokens: final.usage.output_tokens || 0 };
    if (!out.text && Array.isArray(final.output)) {
      for (const item of final.output) {
        if (item.type === 'message') for (const c of item.content || []) {
          if (c.type === 'output_text') out.text += c.text || '';
          if (c.type === 'refusal') out.refused = true;
        }
      }
    }
    if (final.status === 'failed') {
      const e = final.error || {};
      throw new ProviderError(0, e.message || 'The request failed.', { retryable: /server_error|rate_limit/i.test(e.code || ''), code: e.code });
    }
    out.stopReason = out.refused && !out.text ? 'refusal'
      : final.status === 'incomplete' && final.incomplete_details && /max_output_tokens/.test(final.incomplete_details.reason || '') ? 'max_tokens'
      : 'end_turn';
    return out;
  }

  const OPENAI_FEATURES = [
    { key: 'xhigh', test: /xhigh/i },
    { key: 'summary', test: /summary/i },
    { key: 'reasoning', test: /reasoning|effort/i },
    { key: 'tools', test: /code_interpreter|tool|container/i },
    { key: 'structured', test: /text\.format|json_schema|schema|strict/i },
  ];

  // ------------------------------------------------------------------ free Gemini quota juggling
  // Each free Gemini model has its own daily quota, so when one runs out we move to the next.
  const GEMINI_FREE_CHAIN = ['gemini-3.8-flash', 'gemini-3.6-flash', 'gemini-3.5-flash-lite', 'gemini-3.1-flash-lite'];
  const EXHAUST_KEY = 'stepcam.geminiExhausted.v1';
  function pacificDay() {
    try { return new Date().toLocaleDateString('en-US', { timeZone: 'America/Los_Angeles' }); } catch (e) { return new Date().toDateString(); }
  }
  function exhaustedMap() {
    try { return JSON.parse(localStorage.getItem(EXHAUST_KEY) || '{}'); } catch (e) { return {}; }
  }
  function markExhausted(model) {
    const m = exhaustedMap();
    m[model] = pacificDay();
    try { localStorage.setItem(EXHAUST_KEY, JSON.stringify(m)); } catch (e) { /* ignore */ }
  }
  function isExhausted(model) { return exhaustedMap()[model] === pacificDay(); }
  function geminiChain(model) {
    if (!GEMINI_FREE_CHAIN.includes(model)) return [model]; // paid model: no switching
    const start = GEMINI_FREE_CHAIN.indexOf(model);
    // chosen model first, then the remaining free models in quality order
    return [model].concat(GEMINI_FREE_CHAIN.filter((m, i) => m !== model && (i > start || i < start)));
  }

  // ------------------------------------------------------------------ public entry point
  const featureMemo = {}; // remembers which features a model rejected, for this app session

  async function call(o) {
    const isG = o.provider === 'gemini';
    if (!isG) return callModel(o);
    const chain = geminiChain(o.model);
    const live = chain.filter((m) => !isExhausted(m));
    const order = live.length ? live : chain; // all marked used up: try anyway (limits may have reset)
    let lastErr = null;
    for (const model of order) {
      if (model !== o.model && o.onEvent) o.onEvent({ kind: 'model', model });
      try {
        const out = await callModel(Object.assign({}, o, { model }));
        out.model = model;
        return out;
      } catch (e) {
        if (e.kind !== 'daily_quota') throw e;
        markExhausted(model);
        lastErr = e;
      }
    }
    throw lastErr;
  }

  async function callModel(o) {
    const isG = o.provider === 'gemini';
    const list = isG ? GEMINI_FEATURES : OPENAI_FEATURES;
    const memoKey = o.provider + ':' + o.model;
    const feat = Object.assign(isG ? { mediaRes: true, thoughts: true, thinking: true, tools: true, structured: true } : { xhigh: true, summary: true, reasoning: true, tools: true, structured: true }, featureMemo[memoKey] || {});
    const onEvent = o.onEvent || (() => {});
    for (let attempt = 0; attempt < 8; attempt++) {
      try {
        const out = await withRetries(() => (isG ? callGemini : callOpenAI)(Object.assign({}, o, { onEvent }), feat), o.signal, onEvent);
        out.model = o.model;
        return out;
      } catch (e) {
        if (isAbort(e) || e.status !== 400 || e.kind === 'auth') throw e;
        // Drop the feature the API complained about (or the riskiest one) and retry.
        const f = list.find((x) => feat[x.key] && x.test.test(e.message))
          || (o.tools && feat.tools ? list.find((x) => x.key === 'tools') : null)
          || (o.schema && feat.structured ? list.find((x) => x.key === 'structured') : null);
        if (!f) throw e;
        feat[f.key] = false;
        featureMemo[memoKey] = Object.assign(featureMemo[memoKey] || {}, { [f.key]: false });
        onEvent({ kind: 'retry', error: e, wait: 0 });
      }
    }
    throw new ProviderError(0, 'The request kept failing. Please try again.');
  }

  global.Providers = { call, detect, CATALOG, modelLabel, ProviderError, isExhausted, GEMINI_FREE_CHAIN, _toTypeArrays: toTypeArrays };
})(window);
