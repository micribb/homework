/*
 * solver.js — sends the captured image to Claude and returns a structured, fully worked solution.
 *
 * Accuracy features:
 *  - Claude identifies the problem type and the right method, then solves step by step.
 *  - Code execution (Python sandbox with SymPy/NumPy/SciPy) is used to verify every computation.
 *  - Double-check: two independent solves run in parallel; if their answers differ, a third pass
 *    re-reads the image, compares both and produces the corrected solution.
 * Reliability features:
 *  - Automatic retries for network drops, rate limits (429), overloads (529/5xx) and stalled streams.
 *  - Long tool-using turns are continued automatically (stop_reason "pause_turn").
 *  - Falls back to schema-constrained output without tools if a request shape is rejected.
 */
(function (global) {
  'use strict';

  const API_URL = 'https://api.anthropic.com/v1/messages';
  const CODE_TOOL = { type: 'code_execution_20260521', name: 'code_execution' };
  const STALL_MS = 240000;      // abort an attempt if the stream is silent this long
  const MAX_CONTINUES = 6;      // pause_turn continuations per turn

  // ------------------------------------------------------------------ JSON schema
  const nullableNumber = { anyOf: [{ type: 'number' }, { type: 'null' }] };
  const obj = (props, desc) => ({
    type: 'object', additionalProperties: false, required: Object.keys(props), properties: props,
    ...(desc ? { description: desc } : {}),
  });
  const str = (description) => ({ type: 'string', description });
  const bool = (description) => ({ type: 'boolean', description });
  const numb = (description) => ({ type: 'number', description });
  const arr = (items, description) => ({ type: 'array', items, description });

  const GRAPH = obj({
    title: str('Short plain-text title, e.g. "Graph of f(x) = x^2 - 4x + 3".'),
    kind: { type: 'string', enum: ['plane', 'number_line'], description: 'plane = xy coordinate graph; number_line = one-variable solution set.' },
    x_min: numb('Left edge of the window.'),
    x_max: numb('Right edge of the window.'),
    y_min: numb('Bottom edge (use 0 for number_line).'),
    y_max: numb('Top edge (use 0 for number_line).'),
    x_label: str('Horizontal axis name, usually "x".'),
    y_label: str('Vertical axis name, usually "y".'),
    equal_scale: bool('true when shapes must not be distorted (circles, ellipses, geometry).'),
    functions: arr(obj({
      expr: str('Right-hand side only, in x. Explicit * for multiplication. Example: "2*x^3 - 3*x + 1".'),
      label: str('Plain-text legend label, e.g. "f(x) = 2x³ − 3x + 1".'),
      dashed: bool('true for asymptotes, boundaries of strict inequalities, or reference lines.'),
      x_from: { ...nullableNumber, description: 'Domain start, or null for unbounded.' },
      x_to: { ...nullableNumber, description: 'Domain end, or null for unbounded.' },
    }), 'Curves y = f(x). One entry per piece for piecewise functions.'),
    parametric: arr(obj({
      x_expr: str('x(t)'), y_expr: str('y(t)'),
      t_min: numb('Start of t.'), t_max: numb('End of t.'),
      label: str('Legend label.'), dashed: bool('Dashed line?'),
    }), 'Curves that are not functions of x (circles, ellipses, parametric/polar curves).'),
    vertical_lines: arr(obj({ x: numb('x position'), label: str('e.g. "x = 3 (asymptote)"'), dashed: bool('Dashed?') }), 'Vertical asymptotes or lines x = c.'),
    points: arr(obj({ x: numb('x'), y: numb('y (0 on a number line)'), label: str('e.g. "vertex (2, -1)"'), hollow: bool('true = open circle (excluded point / hole).') }), 'Key points to mark.'),
    shaded: arr(obj({
      lower: str('Lower boundary expression in x, or "bottom".'),
      upper: str('Upper boundary expression in x, or "top".'),
      x_from: numb('Left limit of the shading.'),
      x_to: numb('Right limit of the shading.'),
      label: str('e.g. "area = 4/3" or "solution region".'),
    }), 'Regions to shade (areas, integrals, 2-variable inequalities).'),
    intervals: arr(obj({
      from: { ...nullableNumber, description: 'Left endpoint, null for -infinity.' },
      to: { ...nullableNumber, description: 'Right endpoint, null for +infinity.' },
      from_closed: bool('true if the left endpoint is included.'),
      to_closed: bool('true if the right endpoint is included.'),
      label: str('e.g. "x ≤ -2"'),
    }), 'number_line only: solution intervals.'),
  });

  const PROBLEM = obj({
    label: str('e.g. "Problem 4" or "Part (b)"; empty string if unnumbered.'),
    subject: str('Problem type, e.g. "Quadratic equation", "Related rates", "Two-sample t-test", "Stoichiometry".'),
    method: str('Name of the solving method, e.g. "Factoring", "Quadratic formula", "u-substitution", "Law of Cosines", "Row reduction".'),
    statement: str('Faithful transcription of the question including all numbers, units, answer choices and answer-format instructions. Markdown + LaTeX.'),
    strategy: str('How to recognise this kind of problem and why this method works here, in 1-3 sentences.'),
    steps: arr(obj({
      title: str('Short step title, e.g. "Factor the quadratic".'),
      work: str('The math written out for this step (Markdown + LaTeX, display math for main lines).'),
      explanation: str('One or two sentences telling the student why this step is done.'),
    }), 'Worked steps in order, as a teacher would write them on the board.'),
    final_answer: str('The final answer(s), in the exact form requested, Markdown + LaTeX.'),
    answer_entry: str('Plain text exactly as it should be typed into an online answer box (e.g. 3*sqrt(2)/2, (-inf, 4], 12.57, B). Several answers separated by "; ".'),
    check: str('How the answer was verified (substitution, estimate, units, graph, code check) — written for the student.'),
    graphs: arr(GRAPH, 'Graphs for this problem; empty array if none are useful.'),
  });

  const SCHEMA = obj({
    image_readable: bool('false if the image is too blurry/cropped to read the problem reliably.'),
    notes: str('Short note about image quality or any value you had to interpret; empty string if none.'),
    problems: arr(PROBLEM, 'One entry per problem or part, in the order shown.'),
  });
  const SCHEMA_ADJ = JSON.parse(JSON.stringify(SCHEMA));
  SCHEMA_ADJ.properties.verification_summary = str('1-3 sentences: where the two solutions differed, which was right and why.');
  SCHEMA_ADJ.required.push('verification_summary');

  // ------------------------------------------------------------------ prompts
  function systemPrompt(detail, tools) {
    return [
      'You are StepCam, an expert math and science tutor. You solve homework problems from a photo — like a brilliant live tutor sitting next to the student — and show complete, correct work the student can follow.',
      '',
      'READING THE IMAGE',
      '- It comes from a USB webcam or phone camera aimed at a computer screen (often an online homework page: WebAssign, MyLab/Mastering, ALEKS, Canvas, McGraw Hill Connect, Khan Academy, Desmos activities) or at paper/a textbook/a whiteboard, typed or handwritten.',
      '- Expect glare, moiré, slight blur, perspective and parts of the browser UI. Ignore browser chrome, menus, timers and navigation.',
      '- Read every number, sign, exponent, subscript, fraction bar, radical, absolute-value bar and unit carefully; use context to resolve ambiguous characters (1/l/7, 0/O, 5/S, x/×, −/–). Read diagrams, tables and graphs in the image (labels, tick marks, given lengths/angles).',
      '- Never invent missing data. If a needed value is unreadable, say so in notes, give your best reading, and flag it.',
      '- Transcribe each question faithfully in `statement`, including answer choices and format instructions (rounding, exact form, interval notation, units, significant figures, degrees vs radians).',
      '- If several problems or parts are visible, solve all of them (one entry per part) unless the student note says which. For multiple choice, determine the correct option, put its letter and value in the answer, and briefly say why the tempting wrong options fail.',
      '- If the image contains no problem, return an empty problems array and describe what you see in notes.',
      '',
      'IDENTIFY THE PROBLEM AND THE METHOD (do this first, like an expert)',
      '- Classify the problem (`subject`) and choose the most direct standard method a teacher would expect (`method`). Explain in `strategy` how to recognise this kind of problem and why the method fits.',
      '- Coverage includes: arithmetic, fractions, percent; linear/quadratic/polynomial/rational/radical/exponential/logarithmic equations and inequalities; absolute value; systems; functions, domain/range, transformations, inverses, composition; sequences and series; trigonometry (identities, equations, unit circle, laws of sines/cosines); geometry (area, volume, similarity, proofs, coordinate geometry, circles); conics; vectors; complex numbers; matrices and linear algebra (row reduction, determinants, inverses, eigenvalues); limits, derivatives, implicit differentiation, related rates, optimization, curve sketching, integrals (substitution, parts, partial fractions, trig substitution), area/volume, differential equations; probability, combinatorics, distributions (binomial, normal, t, chi-square), confidence intervals, hypothesis tests, regression; finance (interest, annuities); physics and chemistry calculations; word problems (define variables, translate to equations).',
      '- Use the method the problem asks for when it names one (e.g. "use the quadratic formula", "by completing the square", "using the Ratio Test").',
      '',
      'SOLVING',
      detail === 'key'
        ? '- Show the key steps only (setup, main computations, result) — concise but complete enough to follow.'
        : '- Show every meaningful step: what is given, the formula or theorem used, substitution, each algebraic manipulation, simplification and the result. Do not skip arithmetic a student would need to see.',
      '- Each step has a short title, the math in `work`, and a one- or two-sentence `explanation` of why that step is taken.',
      '- Follow the requested answer format exactly. Round only at the end (state the unrounded value too) and include units. For statistics use precise critical values/p-values, not rounded table values, unless the problem says to use a table.',
      tools
        ? '- VERIFY WITH CODE: you have a Python code-execution tool (sandbox with sympy, numpy and scipy). Use it to check every non-trivial computation — solving equations, simplifying, factoring, derivatives and integrals, limits, matrix work, probabilities and critical values (scipy.stats), and the final answer (e.g. substitute it back). If the code disagrees with your hand work, find the error and fix the solution. Present the math by hand as a teacher would; do not paste code into the solution. In `check`, mention what was verified.'
        : '- Re-derive critical arithmetic and verify the result (substitute back, estimate, units).',
      '- `answer_entry` is the plain text to type into an online answer box (sqrt(), ^, *, /, inf, pi, interval notation, or the choice letter).',
      '',
      'MATH FORMATTING (statement, strategy, work, explanation, final_answer, check)',
      '- Markdown with LaTeX. Inline math in $...$, display math in $$...$$ on its own line. For multi-line algebra use $$\\begin{aligned} ... \\end{aligned}$$ with & alignment and \\\\ line breaks.',
      '- Write a literal dollar sign (money) as \\$ so it is not read as math.',
      '- Sign charts and tables of values as Markdown pipe tables. Chemistry may use \\ce{...}.',
      '',
      'GRAPHS',
      '- Include a graph whenever the problem asks to graph/sketch/identify a graph, involves function behaviour (intercepts, extrema, asymptotes, end behaviour), systems, inequalities, regions, areas between curves, or when a picture makes the answer clearer. Otherwise use an empty array.',
      '- Choose a window (x_min, x_max, y_min, y_max) that shows every key feature: intercepts, vertices, extrema, intersections, asymptotes, holes.',
      '- functions[].expr uses ONLY: the variable x; numbers; + - * / ^; parentheses; sin cos tan sec csc cot asin acos atan sinh cosh tanh sqrt cbrt abs ln log (base 10) log(x, b) exp floor ceil; constants pi and e. Always write * for multiplication. Do not write "y =". Examples: "2*x^3 - 3*x + 1", "abs(x - 2) + 1", "1/(x - 3) + 2", "e^(-x)*sin(2*x)", "sqrt(9 - x^2)".',
      '- Piecewise functions: one functions entry per piece with x_from/x_to (null = unbounded), plus points with hollow=true for excluded endpoints and hollow=false for included ones.',
      '- Vertical asymptotes go in vertical_lines; horizontal/slant asymptotes are dashed functions. Mark intercepts, vertices, extrema, intersections and holes in points with labels like "(2, -3)" or "vertex (1, 4)".',
      '- Circles, ellipses and other non-functions: parametric with t from 0 to 2*pi and equal_scale=true.',
      '- Two-variable inequalities: dashed boundary for strict (<, >), solid for ≤/≥, and a shaded entry using "top"/"bottom" for unbounded sides. Areas/integrals: shaded between the curves over [x_from, x_to].',
      '- One-variable inequalities / solution sets: kind "number_line" with intervals (null endpoints for infinity) and points for isolated solutions; set y_min = y_max = 0.',
      '- Graph labels are plain text (no LaTeX). Leave unused arrays empty.',
    ].join('\n');
  }

  function jsonInstruction(schema) {
    return '\n\nOUTPUT FORMAT: when you have finished (including any code checks), your final reply must be ONLY one JSON object — no prose before or after it and no code fences — that matches this JSON Schema exactly:\n' + JSON.stringify(schema);
  }

  function userText(note) {
    return 'Identify each problem in this image, choose the right method, and solve it with full worked steps and explanations.' +
      (note && note.trim() ? '\nStudent note: ' + note.trim() : '');
  }

  // ------------------------------------------------------------------ errors / helpers
  class ApiError extends Error {
    constructor(status, message, type, extra) {
      super(message);
      this.status = status; this.type = type;
      Object.assign(this, extra || {});
    }
  }
  const sleep = (ms, signal) => new Promise((resolve, reject) => {
    const t = setTimeout(resolve, ms);
    if (signal) signal.addEventListener('abort', () => { clearTimeout(t); reject(new DOMException('Aborted', 'AbortError')); }, { once: true });
  });
  const isAbort = (e) => e && e.name === 'AbortError';

  // ------------------------------------------------------------------ one HTTP request (streaming)
  async function postOnce(apiKey, body, signal, onEvent) {
    const local = new AbortController();
    let stalled = false;
    const onOuterAbort = () => local.abort();
    if (signal) {
      if (signal.aborted) throw new DOMException('Aborted', 'AbortError');
      signal.addEventListener('abort', onOuterAbort, { once: true });
    }
    let stallTimer = null;
    const bump = () => { clearTimeout(stallTimer); stallTimer = setTimeout(() => { stalled = true; local.abort(); }, STALL_MS); };
    bump();
    try {
      let res;
      try {
        res = await fetch(API_URL, {
          method: 'POST',
          signal: local.signal,
          headers: {
            'content-type': 'application/json',
            'x-api-key': apiKey,
            'anthropic-version': '2023-06-01',
            'anthropic-dangerous-direct-browser-access': 'true',
          },
          body: JSON.stringify(body),
        });
      } catch (e) {
        if (stalled) throw new ApiError(0, 'The connection stalled.', 'stall', { retryable: true });
        if (isAbort(e)) throw e;
        throw new ApiError(0, 'Network error: ' + (e.message || e), 'network', { retryable: true });
      }
      if (!res.ok) {
        let msg = res.status + ' ' + (res.statusText || ''), type, code;
        try {
          const j = await res.json();
          if (j.error) { msg = j.error.message || msg; type = j.error.type; code = j.error.details && j.error.details.error_code; }
        } catch (e) { /* ignore */ }
        const ra = parseFloat(res.headers.get('retry-after'));
        const retryable = [408, 409, 429, 500, 502, 503, 504, 529].includes(res.status) && code !== 'enforced_spend_limit_reached';
        throw new ApiError(res.status, msg, type, { retryable, retryAfter: Number.isFinite(ra) ? ra : null, code });
      }
      return await readStream(res, local.signal, onEvent, bump, () => stalled);
    } catch (e) {
      if (stalled && isAbort(e)) throw new ApiError(0, 'The connection stalled.', 'stall', { retryable: true });
      throw e;
    } finally {
      clearTimeout(stallTimer);
      if (signal) signal.removeEventListener('abort', onOuterAbort);
    }
  }

  async function readStream(res, signal, onEvent, bump, isStalled) {
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = '';
    const blocks = [];
    const out = { content: blocks, stopReason: null, usage: { input_tokens: 0, output_tokens: 0 }, container: null, done: false };
    const handle = (data) => {
      switch (data.type) {
        case 'message_start': {
          const m = data.message || {};
          if (m.usage) out.usage.input_tokens = (m.usage.input_tokens || 0) + (m.usage.cache_read_input_tokens || 0) + (m.usage.cache_creation_input_tokens || 0);
          if (m.container && m.container.id) out.container = m.container.id;
          onEvent({ kind: 'start' });
          break;
        }
        case 'content_block_start': {
          const b = JSON.parse(JSON.stringify(data.content_block || {}));
          if (b.type === 'text' && typeof b.text !== 'string') b.text = '';
          if (b.type === 'thinking' && typeof b.thinking !== 'string') b.thinking = '';
          blocks[data.index] = b;
          onEvent({ kind: 'block', block: b });
          break;
        }
        case 'content_block_delta': {
          const b = blocks[data.index] || (blocks[data.index] = { type: 'text', text: '' });
          const d = data.delta || {};
          if (d.type === 'text_delta') { b.text = (b.text || '') + d.text; onEvent({ kind: 'text', delta: d.text }); }
          else if (d.type === 'thinking_delta') { b.thinking = (b.thinking || '') + d.thinking; onEvent({ kind: 'thinking' }); }
          else if (d.type === 'signature_delta') { b.signature = (b.signature || '') + d.signature; }
          else if (d.type === 'input_json_delta') { b._json = (b._json || '') + (d.partial_json || ''); }
          else if (d.type === 'citations_delta') { (b.citations || (b.citations = [])).push(d.citation); }
          break;
        }
        case 'content_block_stop': {
          const b = blocks[data.index];
          if (b && b._json !== undefined) {
            try { b.input = b._json ? JSON.parse(b._json) : {}; } catch (e) { b.input = {}; }
            delete b._json;
          }
          break;
        }
        case 'message_delta':
          if (data.delta && data.delta.stop_reason) out.stopReason = data.delta.stop_reason;
          if (data.delta && data.delta.container && data.delta.container.id) out.container = data.delta.container.id;
          if (data.usage && data.usage.output_tokens) out.usage.output_tokens = data.usage.output_tokens;
          break;
        case 'message_stop':
          out.done = true;
          break;
        case 'error': {
          const e = data.error || {};
          const retryable = e.type === 'overloaded_error' || e.type === 'api_error' || e.type === 'rate_limit_error';
          throw new ApiError(0, e.message || 'Stream error', e.type, { retryable });
        }
        default:
          break; // ping etc.
      }
    };
    for (;;) {
      let chunk;
      try { chunk = await reader.read(); } catch (e) {
        if (isStalled()) throw new ApiError(0, 'The connection stalled.', 'stall', { retryable: true });
        if (isAbort(e) || (signal && signal.aborted)) throw new DOMException('Aborted', 'AbortError');
        throw new ApiError(0, 'Connection dropped.', 'network', { retryable: true });
      }
      if (chunk.done) break;
      bump();
      buf += dec.decode(chunk.value, { stream: true }).replace(/\r\n/g, '\n');
      let idx;
      while ((idx = buf.indexOf('\n\n')) >= 0) {
        const raw = buf.slice(0, idx);
        buf = buf.slice(idx + 2);
        const dataLines = [];
        for (const line of raw.split('\n')) if (line.startsWith('data:')) dataLines.push(line.slice(5).trimStart());
        if (!dataLines.length) continue;
        let data;
        try { data = JSON.parse(dataLines.join('\n')); } catch (e) { continue; }
        handle(data);
      }
    }
    if (!out.done && !out.stopReason) throw new ApiError(0, 'The response was cut off.', 'network', { retryable: true });
    for (let i = 0; i < blocks.length; i++) if (!blocks[i]) blocks.splice(i--, 1);
    return out;
  }

  // ------------------------------------------------------------------ request with retries
  async function post(apiKey, body, signal, onEvent) {
    const delays = [2000, 5000, 12000, 25000];
    for (let attempt = 0; ; attempt++) {
      try {
        return await postOnce(apiKey, body, signal, onEvent);
      } catch (e) {
        if (isAbort(e) || !e.retryable || attempt >= delays.length) throw e;
        const wait = e.retryAfter != null ? Math.min(60, e.retryAfter) * 1000 + 250 : delays[attempt];
        onEvent({ kind: 'retry', error: e, wait });
        await sleep(wait, signal);
      }
    }
  }

  // ------------------------------------------------------------------ one full assistant turn (handles pause_turn)
  async function runTurn(apiKey, body, signal, onEvent) {
    const messages = body.messages.slice();
    const usage = { input_tokens: 0, output_tokens: 0 };
    let container = null, allContent = [], last = null;
    for (let n = 0; n <= MAX_CONTINUES; n++) {
      const req = Object.assign({}, body, { messages });
      if (container) req.container = container;
      let r;
      try {
        r = await post(apiKey, req, signal, onEvent);
      } catch (e) {
        if (container && e.status === 400 && /container/i.test(e.message)) { container = null; n--; continue; }
        throw e;
      }
      usage.input_tokens += r.usage.input_tokens;
      usage.output_tokens += r.usage.output_tokens;
      if (r.container) container = r.container;
      allContent = allContent.concat(r.content);
      last = r;
      if (r.stopReason !== 'pause_turn') break;
      onEvent({ kind: 'continue' });
      // Continue the same turn: send the partial assistant content back unchanged.
      const prev = messages[messages.length - 1];
      if (prev && prev.role === 'assistant') {
        messages[messages.length - 1] = { role: 'assistant', content: prev.content.concat(r.content) };
      } else {
        messages.push({ role: 'assistant', content: r.content });
      }
    }
    const finalText = last.content.filter((b) => b.type === 'text').map((b) => b.text).join('');
    const allText = allContent.filter((b) => b.type === 'text').map((b) => b.text).join('\n');
    const usedCode = allContent.some((b) => b.type === 'server_tool_use');
    return { finalText, allText, stopReason: last.stopReason, usage, usedCode };
  }

  // ------------------------------------------------------------------ JSON handling
  function parseJson(text) {
    let t = String(text || '').trim();
    const fence = /```(?:json)?\s*([\s\S]*?)```/.exec(t);
    if (fence) t = fence[1].trim();
    try { return JSON.parse(t); } catch (e) { /* cut out the object */ }
    const a = t.indexOf('{'), b = t.lastIndexOf('}');
    if (a >= 0 && b > a) return JSON.parse(t.slice(a, b + 1));
    throw new Error('The solver returned text that is not valid JSON.');
  }

  function normalize(r) {
    const out = { image_readable: r.image_readable !== false, notes: r.notes || '', problems: [] };
    for (const p of r.problems || []) {
      out.problems.push({
        label: p.label || '', subject: p.subject || '', method: p.method || '', statement: p.statement || '', strategy: p.strategy || '',
        steps: (p.steps || []).map((s) => ({ title: s.title || '', work: s.work || '', explanation: s.explanation || '' })),
        final_answer: p.final_answer || '', answer_entry: p.answer_entry || '', check: p.check || '',
        graphs: (p.graphs || []).map((g) => Object.assign({
          kind: 'plane', functions: [], parametric: [], vertical_lines: [], points: [], shaded: [], intervals: [],
        }, g)),
      });
    }
    if (r.verification_summary) out.verification_summary = r.verification_summary;
    return out;
  }

  // ------------------------------------------------------------------ a single solve, with fallbacks
  function imageBlock(b64, mediaType) {
    return { type: 'image', source: { type: 'base64', media_type: mediaType || 'image/jpeg', data: b64 } };
  }

  function toTurns(content) {
    const img = content.find((b) => b.type === 'image');
    const txt = content.filter((b) => b.type === 'text').map((b) => b.text).join('\n');
    return [{ role: 'user', image: img ? img.source.data : null, text: txt }];
  }

  // Gemini / OpenAI path (see providers.js)
  async function solveOnceGeneric(opts, content, schema, extraSystem, onProgress) {
    const progress = (p) => onProgress && onProgress(p);
    const tools = opts.useCode !== false;
    const onEvent = (ev) => {
      if (ev.kind === 'start') progress({ phase: 'reading' });
      else if (ev.kind === 'thinking') progress({ phase: 'thinking' });
      else if (ev.kind === 'code') progress({ phase: 'computing' });
      else if (ev.kind === 'text') progress({ phase: 'writing', delta: ev.delta });
      else if (ev.kind === 'retry') progress({ phase: 'retry', error: ev.error });
      else if (ev.kind === 'model') progress({ phase: 'switching', model: ev.model });
    };
    for (let attempt = 1; attempt <= 3; attempt++) {
      const out = await global.Providers.call({
        provider: opts.provider, apiKey: opts.apiKey, model: opts.model, effort: opts.effort || 'high',
        system: systemPrompt(opts.detail, tools) + (extraSystem || ''), jsonInstruction: jsonInstruction(schema),
        turns: toTurns(content), schema, tools, signal: opts.signal, onEvent, maxTokens: 64000,
      });
      if (out.stopReason === 'max_tokens') throw new Error('The solution was too long and got cut off. Crop to one problem, or choose "Key steps only" in Settings.');
      if (out.stopReason === 'refusal') {
        if (attempt < 2) { progress({ phase: 'retry' }); continue; }
        throw new Error('The model declined to answer this image. Try cropping to just the problem.');
      }
      try {
        const parsed = parseJson(out.text);
        if (!parsed || !Array.isArray(parsed.problems)) throw new Error('missing problems');
        return { result: normalize(parsed), usage: out.usage, usedCode: out.usedCode, effort: opts.effort, model: out.model || opts.model };
      } catch (e) {
        if (attempt < 3) { progress({ phase: 'retry' }); continue; }
        throw new Error('Could not read the solver\'s answer. Please try again.');
      }
    }
    throw new Error('The solver could not complete this problem. Please try again.');
  }

  async function solveOnce(opts, content, schema, extraSystem, onProgress) {
    if (opts.provider && opts.provider !== 'anthropic') return solveOnceGeneric(opts, content, schema, extraSystem, onProgress);
    const { apiKey, model, detail, signal } = opts;
    let effort = opts.effort || 'high';
    let tools = opts.useCode !== false;
    let structured = !tools;
    const progress = (p) => onProgress && onProgress(p);
    const onEvent = (ev) => {
      if (ev.kind === 'start') progress({ phase: 'reading' });
      else if (ev.kind === 'thinking') progress({ phase: 'thinking' });
      else if (ev.kind === 'block' && ev.block.type === 'server_tool_use') progress({ phase: 'computing' });
      else if (ev.kind === 'block' && ev.block.type === 'thinking') progress({ phase: 'thinking' });
      else if (ev.kind === 'text') progress({ phase: 'writing', delta: ev.delta });
      else if (ev.kind === 'retry') progress({ phase: 'retry', error: ev.error });
    };
    for (let attempt = 1; attempt <= 5; attempt++) {
      const body = {
        model,
        max_tokens: 64000,
        stream: true,
        thinking: { type: 'adaptive' },
        output_config: structured ? { effort, format: { type: 'json_schema', schema } } : { effort },
        system: [{ type: 'text', text: systemPrompt(detail, tools) + (extraSystem || '') + (structured ? '' : jsonInstruction(schema)), cache_control: { type: 'ephemeral' } }],
        messages: [{ role: 'user', content }],
      };
      if (tools) body.tools = [CODE_TOOL];
      let out;
      try {
        out = await runTurn(apiKey, body, signal, onEvent);
      } catch (err) {
        if (isAbort(err)) throw err;
        if (err.status === 400 && /effort/i.test(err.message) && effort !== 'high') { effort = 'high'; continue; }
        if (err.status === 400 && tools && /(tool|code_execution)/i.test(err.message)) { tools = false; structured = true; continue; }
        if (err.status === 400 && structured && /(output_config|format|schema)/i.test(err.message)) { structured = false; continue; }
        if (err.status === 400 && /cache_control/i.test(err.message)) { /* very unlikely */ }
        throw err;
      }
      if (out.stopReason === 'max_tokens') throw new Error('The solution was too long and got cut off. Crop to one problem, or choose "Key steps only" in Settings.');
      if (out.stopReason === 'refusal') {
        if (attempt < 3) { structured = false; progress({ phase: 'retry' }); continue; }
        throw new Error('The model declined to answer this image.');
      }
      try {
        const parsed = parseJson(out.finalText.trim() ? out.finalText : out.allText);
        if (!parsed || !Array.isArray(parsed.problems)) throw new Error('missing problems');
        return { result: normalize(parsed), usage: out.usage, usedCode: out.usedCode, effort };
      } catch (e) {
        // Unparseable answer: try again with schema-constrained output (no tools).
        if (attempt < 4 && !structured) { tools = false; structured = true; progress({ phase: 'retry' }); continue; }
        throw new Error('Could not read the solver\'s answer. Please try again.');
      }
    }
    throw new Error('The solver could not complete this problem. Please try again.');
  }

  // ------------------------------------------------------------------ answer comparison
  const NUM_RE = /-?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?/gi;
  function normAns(s) {
    return String(s || '').trim().toLowerCase()
      .replace(/[\u2212\u2013\u2014]/g, '-').replace(/\u00d7|\u00b7/g, '*').replace(/\u03c0/g, 'pi').replace(/\u221e/g, 'inf')
      .replace(/infinity/g, 'inf').replace(/\\left|\\right|\$|\\,/g, '').replace(/\*\*/g, '^')
      .replace(/^(x|y|answer|ans)\s*=\s*/, '').replace(/\s+/g, '').replace(/[.;,]+$/, '');
  }
  function decimals(s) { const m = /\.(\d+)/.exec(s); return m ? m[1].length : 0; }
  function numEval(s) {
    if (!global.Expr) return NaN;
    if (/[a-z]/.test(s.replace(/sqrt|pi|ln|log|sin|cos|tan|exp|e\b/g, ''))) return NaN;
    const v = global.Expr.evalConst(s);
    return Number.isFinite(v) ? v : NaN;
  }
  function numClose(x, y) {
    const dx = decimals(x), dy = decimals(y);
    const a = parseFloat(x), b = parseFloat(y);
    if (!dx || !dy) return Math.abs(a - b) <= 1e-9 * Math.max(1, Math.abs(a)); // an integer must match exactly
    return Math.abs(a - b) <= 0.51 * Math.pow(10, -Math.min(dx, dy)) + 1e-12;   // equal up to the coarser rounding
  }
  function samePart(a, b) {
    if (a === b) return true;
    if (!a || !b) return false;
    // same expression shape, numbers equal up to rounding: "(2.12, -1)" vs "(2.1213, -1)"
    const sa = a.replace(NUM_RE, '#'), sb = b.replace(NUM_RE, '#');
    const na = a.match(NUM_RE) || [], nb = b.match(NUM_RE) || [];
    if (sa === sb && na.length === nb.length && na.length && na.every((x, i) => numClose(x, nb[i]))) return true;
    // both evaluate to numbers: "3*sqrt(2)/2" vs "2.1213"
    const va = numEval(a), vb = numEval(b);
    if (Number.isFinite(va) && Number.isFinite(vb)) {
      const d = Math.max(decimals(a), decimals(b));
      const tol = d ? 0.51 * Math.pow(10, -Math.min(d, 8)) : 1e-9 * Math.max(1, Math.abs(va));
      return Math.abs(va - vb) <= tol;
    }
    return false;
  }
  function splitParts(s) {
    return String(s || '').toLowerCase().split(/;|\s+or\s+|\s+and\s+/).map(normAns).filter(Boolean).sort();
  }
  function sameAnswer(x, y) {
    const a = normAns(x), b = normAns(y);
    if (a === b) return true;
    const pa = splitParts(x), pb = splitParts(y);
    if (pa.length !== pb.length || !pa.length) return false;
    const used = new Array(pb.length).fill(false);
    return pa.every((p) => { const i = pb.findIndex((q, k) => !used[k] && samePart(p, q)); if (i < 0) return false; used[i] = true; return true; });
  }
  function solutionsAgree(A, B) {
    if (A.problems.length !== B.problems.length || !A.problems.length) return false;
    return A.problems.every((p, i) => sameAnswer(p.answer_entry || p.final_answer, B.problems[i].answer_entry || B.problems[i].final_answer));
  }

  function slim(result) {
    return JSON.stringify({ problems: result.problems.map((p) => ({ label: p.label, statement: p.statement, method: p.method, steps: p.steps, final_answer: p.final_answer, answer_entry: p.answer_entry })) });
  }

  // ------------------------------------------------------------------ public: solve
  /**
   * solve({apiKey, model, effort, detail, imageBase64, mediaType, note, signal, onProgress, useCode, doubleCheck})
   * -> { result, usage, model, effort, verification: {status, summary}, usedCode }
   */
  async function solve(opts) {
    const onProgress = opts.onProgress || (() => {});
    const content = [imageBlock(opts.imageBase64, opts.mediaType), { type: 'text', text: userText(opts.note) }];
    const addUsage = (a, b) => ({ input_tokens: (a.input_tokens || 0) + (b.input_tokens || 0), output_tokens: (a.output_tokens || 0) + (b.output_tokens || 0) });

    if (!opts.doubleCheck) {
      const r = await solveOnce(opts, content, SCHEMA, '', onProgress);
      return { result: r.result, usage: r.usage, model: r.model || opts.model, effort: r.effort, usedCode: r.usedCode, verification: { status: 'none', summary: '' } };
    }

    onProgress({ phase: 'reading', dual: true });
    const settled = await Promise.allSettled([
      solveOnce(opts, content, SCHEMA, '', onProgress),
      solveOnce(opts, content, SCHEMA, '', () => {}),
    ]);
    if (opts.signal && opts.signal.aborted) throw new DOMException('Aborted', 'AbortError');
    const ok = settled.filter((s) => s.status === 'fulfilled').map((s) => s.value);
    if (!ok.length) throw settled[0].reason;
    if (ok.length === 1) {
      const r = ok[0];
      return { result: r.result, usage: r.usage, model: r.model || opts.model, effort: r.effort, usedCode: r.usedCode,
        verification: { status: 'single', summary: 'The second, independent solve did not finish, so this answer was not cross-checked.' } };
    }
    const [A, B] = ok;
    let usage = addUsage(A.usage, B.usage);
    if (solutionsAgree(A.result, B.result)) {
      return { result: A.result, usage, model: A.model || opts.model, effort: A.effort, usedCode: A.usedCode || B.usedCode,
        verification: { status: 'confirmed', summary: 'Solved twice independently — both solutions reached the same answer.' } };
    }

    // Disagreement: re-read the image and decide.
    onProgress({ phase: 'resolving' });
    const adjContent = [
      imageBlock(opts.imageBase64, opts.mediaType),
      { type: 'text', text: 'Two tutors solved the problem(s) in this image independently and got DIFFERENT answers.\n\nSOLUTION A:\n' + slim(A.result) +
        '\n\nSOLUTION B:\n' + slim(B.result) +
        '\n\nRe-read the image carefully yourself (check every number and sign), work out the correct answer to each problem independently, verify it, and output the single correct, complete solution. Explain the discrepancy in verification_summary.' +
        (opts.note && opts.note.trim() ? '\nStudent note: ' + opts.note.trim() : '') },
    ];
    try {
      const adjEffort = (!opts.provider || opts.provider === 'anthropic') ? (opts.effort === 'max' ? 'max' : 'xhigh') : 'max';
      const C = await solveOnce(Object.assign({}, opts, { effort: adjEffort }), adjContent, SCHEMA_ADJ,
        '\n\nYou are the senior reviewer resolving a disagreement between two solutions. Be rigorous; trust neither solution until you have verified it.', onProgress)
        .catch((e) => {
          if (e && e.status === 400 && /effort/i.test(e.message)) return solveOnce(Object.assign({}, opts, { effort: 'high' }), adjContent, SCHEMA_ADJ, '', onProgress);
          throw e;
        });
      usage = addUsage(usage, C.usage);
      const summary = C.result.verification_summary || 'The two solutions disagreed; a third, careful pass decided the answer.';
      return { result: C.result, usage, model: C.model || opts.model, effort: C.effort, usedCode: true, verification: { status: 'resolved', summary } };
    } catch (e) {
      if (isAbort(e)) throw e;
      const other = B.result.problems.map((p, i) => (p.label || ('Problem ' + (i + 1))) + ': ' + (p.answer_entry || p.final_answer)).join('; ');
      return { result: A.result, usage, model: opts.model, effort: A.effort, usedCode: A.usedCode,
        verification: { status: 'disputed', summary: 'Two independent solves disagreed and the tie-break failed. The other solution got: ' + other + '. Tap Re-solve to try again.' } };
    }
  }

  // ------------------------------------------------------------------ public: follow-up questions
  /**
   * ask({apiKey, model, entry, history:[{q,a}], question, signal, onText(fullText), useCode}) -> {text, usage}
   */
  async function ask(opts) {
    const { apiKey, model, entry, question, signal } = opts;
    const ctx = [];
    if (entry.image) ctx.push(imageBlock(entry.image, 'image/jpeg'));
    ctx.push({ type: 'text', text: 'This is the problem the student photographed' + (entry.image ? ' (image above)' : '') +
      ' and the worked solution they were shown (JSON):\n' + JSON.stringify({ notes: entry.result.notes, problems: entry.result.problems.map((p) => ({ label: p.label, statement: p.statement, method: p.method, strategy: p.strategy, steps: p.steps, final_answer: p.final_answer, answer_entry: p.answer_entry })) }) });
    const messages = [{ role: 'user', content: ctx }, { role: 'assistant', content: 'I have the problem and the full solution in front of me. What would you like to know?' }];
    for (const h of opts.history || []) {
      messages.push({ role: 'user', content: h.q });
      messages.push({ role: 'assistant', content: h.a || '(no answer)' });
    }
    messages.push({ role: 'user', content: question });
    const tools = opts.useCode !== false;
    const body = {
      model,
      max_tokens: 16000,
      stream: true,
      thinking: { type: 'adaptive' },
      output_config: { effort: 'medium' },
      system: [{ type: 'text', cache_control: { type: 'ephemeral' }, text: [
        'You are StepCam, the patient expert tutor who wrote this solution. Answer the student\'s follow-up question about it like a great live tutor.',
        '- Be clear and direct. Explain the idea behind a step, not just the mechanics. Use a short example when it helps.',
        '- If the student thinks something is wrong, re-check carefully' + (tools ? ' (use the code-execution tool to verify)' : '') + '. If the original solution had an error, say so plainly and give the corrected work and answer.',
        '- If asked for a similar practice problem, give one with a hidden-until-asked answer (put the answer at the end under "Answer:").',
        '- Format: Markdown with LaTeX ($...$ inline, $$...$$ display, \\begin{aligned} for multi-line work). Write money as \\$. Keep it focused — usually under 250 words unless more is needed.',
      ].join('\n') }],
      messages,
    };
    if (opts.provider && opts.provider !== 'anthropic') {
      let gtext = '';
      const turns = [{ role: 'user', image: entry.image || null, text: ctx[ctx.length - 1].text },
        { role: 'assistant', text: messages[1].content }];
      for (const h of opts.history || []) { turns.push({ role: 'user', text: h.q }); turns.push({ role: 'assistant', text: h.a || '(no answer)' }); }
      turns.push({ role: 'user', text: question });
      const out = await global.Providers.call({
        provider: opts.provider, apiKey, model, effort: 'medium', system: body.system[0].text, turns, tools, signal, maxTokens: 16000,
        onEvent: (ev) => {
          if (ev.kind === 'text') { gtext += ev.delta; opts.onText && opts.onText(gtext); }
          else if (ev.kind === 'code') { opts.onStatus && opts.onStatus('Checking with code…'); }
          else if (ev.kind === 'retry') { opts.onStatus && opts.onStatus('Connection problem — retrying…'); }
        },
      });
      return { text: out.text || gtext, usage: out.usage };
    }
    if (tools) body.tools = [CODE_TOOL];
    let text = '';
    const onEvent = (ev) => {
      if (ev.kind === 'text') { text += ev.delta; opts.onText && opts.onText(text); }
      else if (ev.kind === 'block' && ev.block.type === 'server_tool_use') { opts.onStatus && opts.onStatus('Checking with code…'); }
      else if (ev.kind === 'retry') { opts.onStatus && opts.onStatus('Connection problem — retrying…'); }
    };
    try {
      const out = await runTurn(apiKey, body, signal, onEvent);
      return { text: out.allText || text, usage: out.usage };
    } catch (e) {
      if (!isAbort(e) && tools && e.status === 400 && /(tool|code_execution)/i.test(e.message)) {
        return ask(Object.assign({}, opts, { useCode: false }));
      }
      throw e;
    }
  }

  // ------------------------------------------------------------------ public: setup check
  /** Verifies key, model access and credits with a tiny real request. */
  async function testKey(apiKey, model, provider) {
    if (provider && provider !== 'anthropic') {
      try {
        await global.Providers.call({ provider, apiKey, model, effort: 'medium', system: 'Be brief.', turns: [{ role: 'user', text: 'Reply with the single word: ready' }], tools: false, maxTokens: 1024, onEvent: () => {} });
        return { ok: true };
      } catch (e) {
        return { ok: false, status: e.status, message: e.message, code: e.code, kind: e.kind };
      }
    }
    const body = {
      model: model || 'claude-opus-5-5',
      max_tokens: 400,
      stream: true,
      output_config: { effort: 'low' },
      messages: [{ role: 'user', content: 'Reply with the single word: ready' }],
    };
    try {
      await postOnce(apiKey, body, null, () => {});
      return { ok: true };
    } catch (e) {
      if (e.status === 400 && /effort/i.test(e.message)) {
        delete body.output_config;
        try { await postOnce(apiKey, body, null, () => {}); return { ok: true }; } catch (e2) { e = e2; }
      }
      return { ok: false, status: e.status, message: e.message, code: e.code };
    }
  }

  global.Solver = {
    solve, ask, testKey, ApiError, SCHEMA,
    _normalize: normalize, _parseJson: parseJson, _sameAnswer: sameAnswer, _solutionsAgree: solutionsAgree,
  };
})(window);
