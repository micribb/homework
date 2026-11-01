/*
 * graph.js — canvas grapher for StepCam solutions.
 * Draws: functions y=f(x) (with domain limits), parametric curves, vertical lines,
 * labeled points (open/closed), shaded regions between curves, and number lines
 * with intervals. Tap to trace values; "Zoom" mode enables pan + pinch zoom.
 */
(function (global) {
  'use strict';

  const PALETTE = ['#5aa9ff', '#ff9f45', '#3ddc97', '#ff6b9a', '#b48cff', '#f2d14b', '#4dd4e6', '#ff7a5c'];
  const COLORS = {
    bg: '#0f1620', grid: 'rgba(255,255,255,0.055)', gridMajor: 'rgba(255,255,255,0.11)',
    axis: 'rgba(235,242,255,0.72)', text: 'rgba(225,233,245,0.82)', textDim: 'rgba(200,212,230,0.55)',
  };
  const VLINE = 'rgba(255,120,120,0.9)';
  const TRIG_RE = /\b(sin|cos|tan|sec|csc|cot)\b/;

  function isTopWord(s) { return /^\s*(top|\+?inf(inity)?|∞)\s*$/i.test(String(s)); }
  function isBottomWord(s) { return /^\s*(bottom|-inf(inity)?|-∞)\s*$/i.test(String(s)); }

  function num(v, fallback) {
    if (typeof v === 'number' && Number.isFinite(v)) return v;
    if (typeof v === 'string') { const r = global.Expr.evalConst(v); if (Number.isFinite(r)) return r; }
    return fallback;
  }

  function niceStep(raw) {
    const p = Math.pow(10, Math.floor(Math.log10(raw)));
    const m = raw / p;
    return (m <= 1 ? 1 : m <= 2 ? 2 : m <= 5 ? 5 : 10) * p;
  }

  function fmt(v, step) {
    if (Math.abs(v) < step * 1e-6) return '0';
    const decimals = Math.max(0, -Math.floor(Math.log10(step) + 1e-9));
    let s = v.toFixed(Math.min(decimals, 6));
    if (Math.abs(v) >= 1e5 || (Math.abs(v) < 1e-4 && v !== 0)) s = v.toExponential(1);
    return s.replace('-', '−');
  }

  function gcd(a, b) { return b ? gcd(b, a % b) : Math.abs(a); }
  function piLabel(n, k) {
    if (n === 0) return '0';
    const g = gcd(n, k); n /= g; k /= g;
    const sign = n < 0 ? '−' : '';
    const a = Math.abs(n);
    const numer = (a === 1 ? '' : a) + 'π';
    return sign + (k === 1 ? numer : numer + '/' + k);
  }

  class Graph {
    constructor(host, spec) {
      this.spec = spec || {};
      this.host = host;
      this.errors = [];
      this.interactive = false;
      this.trace = null;
      this.isNumberLine = this.spec.kind === 'number_line';
      this._compile();
      this._initialView();
      this._buildDom();
      this.render();
      if (global.ResizeObserver) {
        let lastW = 0;
        this._ro = new ResizeObserver(() => {
          const w = this.wrap.clientWidth;
          if (Math.abs(w - lastW) > 2) { lastW = w; this.render(); }
        });
        this._ro.observe(this.wrap);
      }
    }

    _compile() {
      const s = this.spec;
      let ci = 0;
      const nextColor = () => PALETTE[ci++ % PALETTE.length];
      this.funcs = (s.functions || []).map((f) => {
        const c = global.Expr.compile(f.expr, ['x']);
        if (!c.ok) this.errors.push('Could not graph "' + f.expr + '": ' + c.error);
        return Object.assign({}, f, { fn: c.ok ? c.fn : null, color: nextColor() });
      }).filter((f) => f.fn);
      this.params = (s.parametric || []).map((f) => {
        const cx = global.Expr.compile(f.x_expr, ['t']);
        const cy = global.Expr.compile(f.y_expr, ['t']);
        if (!cx.ok || !cy.ok) this.errors.push('Could not graph parametric curve: ' + (cx.error || cy.error));
        return Object.assign({}, f, { fx: cx.ok ? cx.fn : null, fy: cy.ok ? cy.fn : null, color: nextColor() });
      }).filter((f) => f.fx && f.fy);
      this.shades = (s.shaded || []).map((r, i) => {
        const mk = (src, isLower) => {
          if (isTopWord(src)) return { inf: 1 };
          if (isBottomWord(src)) return { inf: -1 };
          const c = global.Expr.compile(src, ['x']);
          if (!c.ok) { this.errors.push('Could not shade "' + src + '": ' + c.error); return null; }
          return { fn: c.fn };
        };
        const lo = mk(r.lower, true), hi = mk(r.upper, false);
        if (!lo || !hi) return null;
        const base = this.funcs[i] ? this.funcs[i].color : PALETTE[(i + 2) % PALETTE.length];
        return Object.assign({}, r, { lo, hi, color: base });
      }).filter(Boolean);
      this.hasTrig = (s.functions || []).some((f) => TRIG_RE.test(f.expr || ''));
    }

    _initialView() {
      const s = this.spec;
      let xmin = num(s.x_min, -10), xmax = num(s.x_max, 10);
      if (!(xmax > xmin)) { xmin = -10; xmax = 10; }
      let ymin = num(s.y_min, NaN), ymax = num(s.y_max, NaN);
      if (!(ymax > ymin) && !this.isNumberLine) {
        // auto-fit y from sampled data
        const ys = [];
        for (const f of this.funcs) {
          for (let i = 0; i <= 200; i++) {
            const x = xmin + (xmax - xmin) * i / 200;
            const y = f.fn({ x });
            if (Number.isFinite(y)) ys.push(y);
          }
        }
        for (const pt of s.points || []) if (Number.isFinite(pt.y)) ys.push(pt.y);
        ys.sort((a, b) => a - b);
        if (ys.length) {
          ymin = ys[Math.floor(ys.length * 0.03)];
          ymax = ys[Math.ceil(ys.length * 0.97) - 1];
          const pad = (ymax - ymin) * 0.12 || 1;
          ymin -= pad; ymax += pad;
        } else { ymin = -10; ymax = 10; }
      }
      this.home = { xmin, xmax, ymin, ymax };
      this.view = Object.assign({}, this.home);
    }

    _buildDom() {
      const s = this.spec;
      const wrap = document.createElement('div');
      wrap.className = 'graph';
      const head = document.createElement('div');
      head.className = 'graph-head';
      const title = document.createElement('div');
      title.className = 'graph-title';
      title.textContent = s.title || (this.isNumberLine ? 'Number line' : 'Graph');
      head.appendChild(title);
      const tools = document.createElement('div');
      tools.className = 'graph-tools';
      if (!this.isNumberLine) {
        const zoom = document.createElement('button');
        zoom.type = 'button';
        zoom.className = 'chip';
        zoom.textContent = 'Pan / zoom';
        zoom.addEventListener('click', () => {
          this.interactive = !this.interactive;
          zoom.classList.toggle('on', this.interactive);
          this.canvas.classList.toggle('interactive', this.interactive);
        });
        const reset = document.createElement('button');
        reset.type = 'button';
        reset.className = 'chip';
        reset.textContent = 'Reset';
        reset.addEventListener('click', () => { this.view = Object.assign({}, this.home); this.trace = null; this.render(); });
        tools.appendChild(zoom);
        tools.appendChild(reset);
      }
      head.appendChild(tools);
      wrap.appendChild(head);

      const canvas = document.createElement('canvas');
      canvas.className = 'graph-canvas' + (this.isNumberLine ? ' numberline' : '');
      wrap.appendChild(canvas);

      const legend = document.createElement('div');
      legend.className = 'graph-legend';
      const addLegend = (color, label, dashed, kind) => {
        if (!label) return;
        const item = document.createElement('span');
        item.className = 'legend-item';
        const sw = document.createElement('i');
        sw.className = 'sw ' + (kind || '') + (dashed ? ' dashed' : '');
        sw.style.setProperty('--c', color);
        item.appendChild(sw);
        item.appendChild(document.createTextNode(label));
        legend.appendChild(item);
      };
      this.funcs.forEach((f) => addLegend(f.color, f.label || ('y = ' + f.expr), f.dashed));
      this.params.forEach((f) => addLegend(f.color, f.label, f.dashed));
      this.shades.forEach((r) => addLegend(r.color, r.label, false, 'area'));
      (s.vertical_lines || []).forEach((v) => addLegend(VLINE, v.label, v.dashed !== false));
      (s.intervals || []).forEach((iv, i) => addLegend(PALETTE[i % PALETTE.length], iv.label, false));
      if (legend.childNodes.length) wrap.appendChild(legend);

      const readout = document.createElement('div');
      readout.className = 'graph-readout';
      readout.textContent = this.isNumberLine ? '' : 'Tap the graph to trace a curve.';
      wrap.appendChild(readout);

      if (this.errors.length) {
        const err = document.createElement('div');
        err.className = 'graph-errors';
        err.textContent = this.errors.join('\n');
        wrap.appendChild(err);
      }
      this.host.appendChild(wrap);
      this.wrap = wrap;
      this.canvas = canvas;
      this.readout = readout;
      this._bindPointer();
    }

    // ---------- coordinate helpers ----------
    _layout() {
      const dpr = global.devicePixelRatio || 1;
      const W = Math.max(200, this.wrap.clientWidth || 320);
      const H = this.isNumberLine ? 96 : Math.round(Math.min(Math.max(W * 0.78, 240), 520));
      if (this.canvas.width !== Math.round(W * dpr) || this.canvas.height !== Math.round(H * dpr)) {
        this.canvas.width = Math.round(W * dpr);
        this.canvas.height = Math.round(H * dpr);
        this.canvas.style.height = H + 'px';
      }
      this.W = W; this.H = H; this.dpr = dpr;
      if (this.spec.equal_scale && !this.isNumberLine) this._equalize();
    }
    _equalize() {
      const v = this.view;
      const ux = (v.xmax - v.xmin) / this.W, uy = (v.ymax - v.ymin) / this.H;
      const u = Math.max(ux, uy);
      const cx = (v.xmin + v.xmax) / 2, cy = (v.ymin + v.ymax) / 2;
      v.xmin = cx - u * this.W / 2; v.xmax = cx + u * this.W / 2;
      v.ymin = cy - u * this.H / 2; v.ymax = cy + u * this.H / 2;
    }
    X(x) { const v = this.view; return (x - v.xmin) / (v.xmax - v.xmin) * this.W; }
    Y(y) { const v = this.view; return this.H - (y - v.ymin) / (v.ymax - v.ymin) * this.H; }
    invX(px) { const v = this.view; return v.xmin + px / this.W * (v.xmax - v.xmin); }
    invY(py) { const v = this.view; return v.ymin + (this.H - py) / this.H * (v.ymax - v.ymin); }

    render() {
      this._layout();
      const ctx = this.canvas.getContext('2d');
      ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
      ctx.fillStyle = COLORS.bg;
      ctx.fillRect(0, 0, this.W, this.H);
      if (this.isNumberLine) { this._drawNumberLine(ctx); return; }
      this._drawGrid(ctx);
      this._drawShades(ctx);
      this._drawVerticals(ctx);
      this._drawFunctions(ctx);
      this._drawParams(ctx);
      this._drawPoints(ctx);
      this._drawTrace(ctx);
    }

    _ticks(min, max, pixels, minGap, usePi) {
      if (usePi) {
        const span = (max - min) / Math.PI;
        const options = [[1, 12], [1, 6], [1, 4], [1, 2], [1, 1], [2, 1], [4, 1], [8, 1]];
        for (const [n, k] of options) {
          const step = n * Math.PI / k;
          if (step / (max - min) * pixels >= minGap && span <= 40) {
            const ticks = [];
            const start = Math.ceil(min / step);
            for (let i = start; i * step <= max + 1e-9; i++) ticks.push({ v: i * step, label: piLabel(i * n, k) });
            return { step, ticks };
          }
        }
      }
      const step = niceStep((max - min) / Math.max(1, pixels / minGap));
      const ticks = [];
      const start = Math.ceil(min / step);
      for (let i = start; i * step <= max + step * 1e-9; i++) ticks.push({ v: i * step, label: fmt(i * step, step) });
      return { step, ticks };
    }

    _drawGrid(ctx) {
      const v = this.view;
      const usePiX = this.hasTrig && (v.xmax - v.xmin) >= Math.PI && (v.xmax - v.xmin) <= 40 * Math.PI;
      const tx = this._ticks(v.xmin, v.xmax, this.W, 58, usePiX);
      const ty = this._ticks(v.ymin, v.ymax, this.H, 44, false);
      // minor grid
      ctx.lineWidth = 1;
      ctx.strokeStyle = COLORS.grid;
      ctx.beginPath();
      const minorX = tx.step / (usePiX ? 2 : 5), minorY = ty.step / 5;
      for (let x = Math.ceil(v.xmin / minorX) * minorX; x <= v.xmax; x += minorX) { const px = Math.round(this.X(x)) + 0.5; ctx.moveTo(px, 0); ctx.lineTo(px, this.H); }
      for (let y = Math.ceil(v.ymin / minorY) * minorY; y <= v.ymax; y += minorY) { const py = Math.round(this.Y(y)) + 0.5; ctx.moveTo(0, py); ctx.lineTo(this.W, py); }
      ctx.stroke();
      ctx.strokeStyle = COLORS.gridMajor;
      ctx.beginPath();
      tx.ticks.forEach((t) => { const px = Math.round(this.X(t.v)) + 0.5; ctx.moveTo(px, 0); ctx.lineTo(px, this.H); });
      ty.ticks.forEach((t) => { const py = Math.round(this.Y(t.v)) + 0.5; ctx.moveTo(0, py); ctx.lineTo(this.W, py); });
      ctx.stroke();

      // axes
      const ax = Math.min(Math.max(this.Y(0), 0), this.H);
      const ay = Math.min(Math.max(this.X(0), 0), this.W);
      ctx.strokeStyle = COLORS.axis;
      ctx.lineWidth = 1.4;
      ctx.beginPath();
      if (v.ymin <= 0 && v.ymax >= 0) { ctx.moveTo(0, Math.round(ax) + 0.5); ctx.lineTo(this.W, Math.round(ax) + 0.5); }
      if (v.xmin <= 0 && v.xmax >= 0) { ctx.moveTo(Math.round(ay) + 0.5, 0); ctx.lineTo(Math.round(ay) + 0.5, this.H); }
      ctx.stroke();

      // tick labels
      ctx.font = '11px system-ui, -apple-system, Roboto, sans-serif';
      ctx.fillStyle = COLORS.text;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'top';
      const labelY = Math.min(Math.max(ax + 4, 2), this.H - 15);
      tx.ticks.forEach((t) => {
        if (Math.abs(t.v) < tx.step * 1e-6) return;
        const px = this.X(t.v);
        if (px < 10 || px > this.W - 10) return;
        this._labelBg(ctx, t.label, px, labelY, 'center');
      });
      ctx.textAlign = 'right';
      ctx.textBaseline = 'middle';
      const labelX = Math.min(Math.max(ay - 5, 30), this.W - 4);
      ty.ticks.forEach((t) => {
        if (Math.abs(t.v) < ty.step * 1e-6) return;
        const py = this.Y(t.v);
        if (py < 8 || py > this.H - 8) return;
        this._labelBg(ctx, t.label, labelX, py, 'right');
      });
      // axis names
      ctx.fillStyle = COLORS.textDim;
      ctx.font = 'italic 12px system-ui, sans-serif';
      ctx.textAlign = 'right'; ctx.textBaseline = 'bottom';
      ctx.fillText(this.spec.x_label || 'x', this.W - 6, Math.min(Math.max(ax - 4, 14), this.H - 2));
      ctx.textAlign = 'left'; ctx.textBaseline = 'top';
      ctx.fillText(this.spec.y_label || 'y', Math.min(Math.max(ay + 6, 4), this.W - 40), 4);
    }

    _labelBg(ctx, text, x, y, align) {
      const w = ctx.measureText(text).width;
      const bx = align === 'center' ? x - w / 2 : x - w;
      ctx.save();
      ctx.fillStyle = 'rgba(15,22,32,0.78)';
      if (ctx.textBaseline === 'top') ctx.fillRect(bx - 2, y - 1, w + 4, 14);
      else ctx.fillRect(bx - 2, y - 7, w + 4, 14);
      ctx.restore();
      ctx.fillText(text, x, y);
    }

    _sampleFn(fn, a, b, n) {
      const pts = [];
      for (let i = 0; i <= n; i++) {
        const x = a + (b - a) * i / n;
        pts.push([x, fn({ x })]);
      }
      return pts;
    }

    _strokeCurve(ctx, fn, a, b, color, dashed, width) {
      const n = Math.ceil(this.W * 1.5);
      const H = this.H;
      const clampY = (py) => Math.max(-4 * H, Math.min(5 * H, py));
      ctx.save();
      ctx.strokeStyle = color;
      ctx.lineWidth = width || 2.4;
      ctx.lineJoin = 'round';
      ctx.lineCap = 'round';
      if (dashed) ctx.setLineDash([7, 6]);
      ctx.beginPath();
      let pen = false, prev = null;
      for (let i = 0; i <= n; i++) {
        const x = a + (b - a) * i / n;
        const y = fn({ x });
        if (!Number.isFinite(y)) { pen = false; prev = null; continue; }
        const px = this.X(x), py = this.Y(y);
        if (pen && prev) {
          const jump = Math.abs(py - prev.py);
          if (jump > H * 0.5) {
            // check for a discontinuity / vertical asymptote between samples
            const xm = (prev.x + x) / 2;
            const ym = fn({ x: xm });
            const lo = Math.min(prev.y, y), hi = Math.max(prev.y, y);
            const tol = (hi - lo) * 0.25;
            if (!Number.isFinite(ym) || ym < lo - tol || ym > hi + tol || Math.sign(prev.y) !== Math.sign(y) && jump > H * 1.5) {
              pen = false;
            }
          }
        }
        if (!pen) { ctx.moveTo(px, clampY(py)); pen = true; } else ctx.lineTo(px, clampY(py));
        prev = { x, y, py };
      }
      ctx.stroke();
      ctx.restore();
    }

    _drawFunctions(ctx) {
      const v = this.view;
      for (const f of this.funcs) {
        const a = Math.max(v.xmin, num(f.x_from, -Infinity));
        const b = Math.min(v.xmax, num(f.x_to, Infinity));
        if (!(b > a)) continue;
        this._strokeCurve(ctx, f.fn, a, b, f.color, f.dashed);
      }
    }

    _drawParams(ctx) {
      for (const f of this.params) {
        const t0 = num(f.t_min, 0), t1 = num(f.t_max, 2 * Math.PI);
        const n = 1200;
        ctx.save();
        ctx.strokeStyle = f.color;
        ctx.lineWidth = 2.4;
        if (f.dashed) ctx.setLineDash([7, 6]);
        ctx.beginPath();
        let pen = false;
        for (let i = 0; i <= n; i++) {
          const t = t0 + (t1 - t0) * i / n;
          const x = f.fx({ t }), y = f.fy({ t });
          if (!Number.isFinite(x) || !Number.isFinite(y)) { pen = false; continue; }
          const px = this.X(x), py = this.Y(y);
          if (!pen) { ctx.moveTo(px, py); pen = true; } else ctx.lineTo(px, py);
        }
        ctx.stroke();
        ctx.restore();
      }
    }

    _drawShades(ctx) {
      const v = this.view;
      for (const r of this.shades) {
        const a = Math.max(v.xmin, num(r.x_from, v.xmin));
        const b = Math.min(v.xmax, num(r.x_to, v.xmax));
        if (!(b > a)) continue;
        const n = Math.ceil(this.W);
        const val = (side, x) => (side.inf ? (side.inf > 0 ? v.ymax + (v.ymax - v.ymin) : v.ymin - (v.ymax - v.ymin)) : side.fn({ x }));
        ctx.save();
        ctx.fillStyle = hexA(r.color, 0.22);
        let run = [];
        const flush = () => {
          if (run.length > 1) {
            ctx.beginPath();
            run.forEach((p, i) => (i ? ctx.lineTo(this.X(p[0]), this.Y(p[2])) : ctx.moveTo(this.X(p[0]), this.Y(p[2]))));
            for (let i = run.length - 1; i >= 0; i--) ctx.lineTo(this.X(run[i][0]), this.Y(run[i][1]));
            ctx.closePath();
            ctx.fill();
          }
          run = [];
        };
        for (let i = 0; i <= n; i++) {
          const x = a + (b - a) * i / n;
          let lo = val(r.lo, x), hi = val(r.hi, x);
          if (!Number.isFinite(lo) || !Number.isFinite(hi)) { flush(); continue; }
          const span = v.ymax - v.ymin;
          lo = Math.max(v.ymin - span, Math.min(v.ymax + span, lo));
          hi = Math.max(v.ymin - span, Math.min(v.ymax + span, hi));
          run.push([x, lo, hi]);
        }
        flush();
        ctx.restore();
      }
    }

    _drawVerticals(ctx) {
      for (const vl of this.spec.vertical_lines || []) {
        const x = num(vl.x, NaN);
        if (!Number.isFinite(x)) continue;
        const px = this.X(x);
        ctx.save();
        ctx.strokeStyle = VLINE;
        ctx.lineWidth = 1.6;
        if (vl.dashed !== false) ctx.setLineDash([6, 5]);
        ctx.beginPath(); ctx.moveTo(px, 0); ctx.lineTo(px, this.H); ctx.stroke();
        ctx.restore();
        if (vl.label) {
          ctx.save();
          ctx.font = '11px system-ui, sans-serif';
          ctx.textBaseline = 'top';
          ctx.textAlign = 'left';
          const w = ctx.measureText(vl.label).width;
          const lx = px + 6 + w > this.W ? px - 6 - w : px + 6;
          ctx.fillStyle = 'rgba(15,22,32,0.85)';
          ctx.fillRect(lx - 3, 16, w + 6, 16);
          ctx.fillStyle = 'rgba(255,170,170,1)';
          ctx.fillText(vl.label, lx, 18);
          ctx.restore();
        }
      }
    }

    _drawPoints(ctx) {
      const placed = [];
      for (const p of this.spec.points || []) {
        const x = num(p.x, NaN), y = num(p.y, NaN);
        if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
        const px = this.X(x), py = this.Y(y);
        if (px < -10 || px > this.W + 10 || py < -10 || py > this.H + 10) continue;
        ctx.save();
        ctx.lineWidth = 2;
        ctx.strokeStyle = '#ffffff';
        ctx.fillStyle = p.hollow ? COLORS.bg : '#ffffff';
        ctx.beginPath(); ctx.arc(px, py, 4.8, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
        ctx.restore();
        if (p.label) {
          ctx.save();
          ctx.font = '600 11.5px system-ui, sans-serif';
          const w = ctx.measureText(p.label).width;
          let lx = px + 8, ly = py - 10;
          if (lx + w > this.W - 4) lx = px - 8 - w;
          if (ly < 12) ly = py + 18;
          for (const q of placed) if (Math.abs(q[0] - lx) < w && Math.abs(q[1] - ly) < 13) ly += 14;
          placed.push([lx, ly]);
          ctx.fillStyle = 'rgba(15,22,32,0.82)';
          ctx.fillRect(lx - 3, ly - 11, w + 6, 15);
          ctx.fillStyle = '#ffffff';
          ctx.fillText(p.label, lx, ly);
          ctx.restore();
        }
      }
    }

    _drawTrace(ctx) {
      if (!this.trace) return;
      const { x, y, color } = this.trace;
      const px = this.X(x), py = this.Y(y);
      ctx.save();
      ctx.strokeStyle = 'rgba(255,255,255,0.35)';
      ctx.setLineDash([3, 4]);
      ctx.beginPath(); ctx.moveTo(px, 0); ctx.lineTo(px, this.H); ctx.moveTo(0, py); ctx.lineTo(this.W, py); ctx.stroke();
      ctx.setLineDash([]);
      ctx.fillStyle = color; ctx.strokeStyle = '#fff'; ctx.lineWidth = 2;
      ctx.beginPath(); ctx.arc(px, py, 6, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
      ctx.restore();
    }

    _drawNumberLine(ctx) {
      const v = this.view;
      const W = this.W, H = this.H;
      const padL = 18, padR = 18;
      const X = (x) => padL + (x - v.xmin) / (v.xmax - v.xmin) * (W - padL - padR);
      const lineY = Math.round(H * 0.62) + 0.5;
      ctx.strokeStyle = COLORS.axis; ctx.fillStyle = COLORS.axis; ctx.lineWidth = 1.6;
      ctx.beginPath(); ctx.moveTo(4, lineY); ctx.lineTo(W - 4, lineY); ctx.stroke();
      arrow(ctx, 4, lineY, -1); arrow(ctx, W - 4, lineY, 1);
      const tx = this._ticks(v.xmin, v.xmax, W - padL - padR, 40, false);
      ctx.font = '11px system-ui, sans-serif';
      ctx.textAlign = 'center'; ctx.textBaseline = 'top'; ctx.fillStyle = COLORS.text;
      tx.ticks.forEach((t) => {
        const px = Math.round(X(t.v)) + 0.5;
        ctx.beginPath(); ctx.moveTo(px, lineY - 5); ctx.lineTo(px, lineY + 5); ctx.stroke();
        ctx.fillText(t.label, px, lineY + 8);
      });
      (this.spec.intervals || []).forEach((iv, i) => {
        const color = PALETTE[i % PALETTE.length];
        const fromInf = iv.from === null || iv.from === undefined || !Number.isFinite(num(iv.from, NaN));
        const toInf = iv.to === null || iv.to === undefined || !Number.isFinite(num(iv.to, NaN));
        const a = fromInf ? 4 : X(num(iv.from, 0));
        const b = toInf ? W - 4 : X(num(iv.to, 0));
        const y = lineY - 14 - i * 9;
        ctx.save();
        ctx.strokeStyle = color; ctx.fillStyle = color; ctx.lineWidth = 5; ctx.lineCap = 'butt';
        ctx.beginPath(); ctx.moveTo(a, y); ctx.lineTo(b, y); ctx.stroke();
        if (fromInf) arrow(ctx, a, y, -1, 9);
        if (toInf) arrow(ctx, b, y, 1, 9);
        const end = (px, closed) => {
          ctx.lineWidth = 2.2;
          ctx.fillStyle = closed ? color : COLORS.bg;
          ctx.beginPath(); ctx.arc(px, y, 5.5, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
          ctx.setLineDash([2, 3]); ctx.lineWidth = 1; ctx.beginPath(); ctx.moveTo(px, y + 6); ctx.lineTo(px, lineY); ctx.stroke(); ctx.setLineDash([]);
        };
        if (!fromInf) end(a, !!iv.from_closed);
        if (!toInf) end(b, !!iv.to_closed);
        ctx.restore();
      });
      (this.spec.points || []).forEach((p) => {
        const x = num(p.x, NaN);
        if (!Number.isFinite(x)) return;
        const px = X(x);
        ctx.save();
        ctx.strokeStyle = '#fff'; ctx.lineWidth = 2; ctx.fillStyle = p.hollow ? COLORS.bg : '#fff';
        ctx.beginPath(); ctx.arc(px, lineY, 5, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
        if (p.label) { ctx.font = '600 11px system-ui, sans-serif'; ctx.fillStyle = '#fff'; ctx.textAlign = 'center'; ctx.textBaseline = 'bottom'; ctx.fillText(p.label, px, lineY - 9); }
        ctx.restore();
      });
    }

    // ---------- interaction ----------
    _bindPointer() {
      const c = this.canvas;
      const pts = new Map();
      let start = null, moved = false, lastTap = 0;
      const pos = (e) => { const r = c.getBoundingClientRect(); return { x: e.clientX - r.left, y: e.clientY - r.top }; };
      c.addEventListener('pointerdown', (e) => {
        pts.set(e.pointerId, pos(e));
        moved = false;
        start = { view: Object.assign({}, this.view), pts: new Map(pts) };
        if (this.interactive) c.setPointerCapture(e.pointerId);
      });
      c.addEventListener('pointermove', (e) => {
        if (!pts.has(e.pointerId)) return;
        pts.set(e.pointerId, pos(e));
        if (!this.interactive || this.isNumberLine) {
          const s0 = start && start.pts.get(e.pointerId);
          if (s0 && Math.hypot(s0.x - pos(e).x, s0.y - pos(e).y) > 8) moved = true;
          return;
        }
        e.preventDefault();
        const ids = [...pts.keys()];
        const sv = start.view;
        const spanX = sv.xmax - sv.xmin, spanY = sv.ymax - sv.ymin;
        if (ids.length === 1) {
          const p0 = start.pts.get(ids[0]), p1 = pts.get(ids[0]);
          if (!p0) return;
          const dx = (p1.x - p0.x) / this.W * spanX, dy = (p1.y - p0.y) / this.H * spanY;
          if (Math.abs(p1.x - p0.x) + Math.abs(p1.y - p0.y) > 6) moved = true;
          this.view = { xmin: sv.xmin - dx, xmax: sv.xmax - dx, ymin: sv.ymin + dy, ymax: sv.ymax + dy };
        } else if (ids.length >= 2) {
          const a0 = start.pts.get(ids[0]), b0 = start.pts.get(ids[1]);
          const a1 = pts.get(ids[0]), b1 = pts.get(ids[1]);
          if (!a0 || !b0) { start = { view: Object.assign({}, this.view), pts: new Map(pts) }; return; }
          moved = true;
          const d0 = Math.hypot(a0.x - b0.x, a0.y - b0.y) || 1, d1 = Math.hypot(a1.x - b1.x, a1.y - b1.y) || 1;
          const k = d0 / d1;
          const m0 = { x: (a0.x + b0.x) / 2, y: (a0.y + b0.y) / 2 }, m1 = { x: (a1.x + b1.x) / 2, y: (a1.y + b1.y) / 2 };
          const cx = sv.xmin + m0.x / this.W * spanX, cy = sv.ymin + (this.H - m0.y) / this.H * spanY;
          const nsx = spanX * k, nsy = spanY * k;
          const xmin = cx - m1.x / this.W * nsx;
          const ymin = cy - (this.H - m1.y) / this.H * nsy;
          this.view = { xmin, xmax: xmin + nsx, ymin, ymax: ymin + nsy };
        }
        this.render();
      });
      const up = (e) => {
        const p = pts.get(e.pointerId);
        pts.delete(e.pointerId);
        if (pts.size) { start = { view: Object.assign({}, this.view), pts: new Map(pts) }; return; }
        if (!moved && p && !this.isNumberLine) {
          const now = Date.now();
          if (this.interactive && now - lastTap < 320) { this.view = Object.assign({}, this.home); this.trace = null; this.render(); }
          else this._traceAt(p.x, p.y);
          lastTap = now;
        }
      };
      c.addEventListener('pointerup', up);
      c.addEventListener('pointercancel', (e) => { pts.delete(e.pointerId); });
      c.addEventListener('wheel', (e) => {
        if (!this.interactive) return;
        e.preventDefault();
        const p = pos(e);
        const k = Math.exp(e.deltaY * 0.0015);
        const cx = this.invX(p.x), cy = this.invY(p.y);
        const v = this.view;
        this.view = { xmin: cx - (cx - v.xmin) * k, xmax: cx + (v.xmax - cx) * k, ymin: cy - (cy - v.ymin) * k, ymax: cy + (v.ymax - cy) * k };
        this.render();
      }, { passive: false });
    }

    _traceAt(px, py) {
      const x = this.invX(px);
      let best = null;
      for (const f of this.funcs) {
        const lo = num(f.x_from, -Infinity), hi = num(f.x_to, Infinity);
        if (x < lo || x > hi) continue;
        const y = f.fn({ x });
        if (!Number.isFinite(y)) continue;
        const d = Math.abs(this.Y(y) - py);
        if (!best || d < best.d) best = { d, x, y, f };
      }
      if (best && best.d < 60) {
        this.trace = { x: best.x, y: best.y, color: best.f.color };
        const lbl = best.f.label || ('y = ' + best.f.expr);
        this.readout.textContent = lbl + ':  x = ' + round(best.x) + ',  y = ' + round(best.y);
      } else {
        this.trace = null;
        this.readout.textContent = 'Point: (' + round(x) + ', ' + round(this.invY(py)) + ')';
      }
      this.render();
    }
  }

  function round(v) {
    if (!Number.isFinite(v)) return String(v);
    const r = Math.round(v * 1e4) / 1e4;
    return String(Object.is(r, -0) ? 0 : r).replace('-', '−');
  }
  function hexA(hex, a) {
    const m = /^#([0-9a-f]{6})$/i.exec(hex);
    if (!m) return hex;
    const n = parseInt(m[1], 16);
    return 'rgba(' + (n >> 16 & 255) + ',' + (n >> 8 & 255) + ',' + (n & 255) + ',' + a + ')';
  }
  function arrow(ctx, x, y, dir, size) {
    size = size || 7;
    ctx.beginPath();
    ctx.moveTo(x, y);
    ctx.lineTo(x - dir * size, y - size * 0.6);
    ctx.lineTo(x - dir * size, y + size * 0.6);
    ctx.closePath();
    ctx.fill();
  }

  global.Graph = Graph;
})(window);
