/*
 * expr.js — small, safe math expression compiler for graphing.
 * No eval(). Supports:
 *   numbers (2, 3.5, 1e-3), variables x / t, constants pi, e
 *   + - * / ^ (or **), unary minus, parentheses, |abs|, n! (integers)
 *   implicit multiplication: 2x, 3(x+1), (x+1)(x-1), 2pi, x sin(x)
 *   comparisons < <= > >= == != and ternary  cond ? a : b   (for piecewise)
 *   functions: sin cos tan sec csc cot asin acos atan arcsin arccos arctan atan2
 *              sinh cosh tanh asinh acosh atanh sqrt cbrt abs ln log log10 log2 exp
 *              floor ceil round sign min max pow nthroot mod
 *   log(x) = base 10, log(x, b) = base b, ln(x) = natural log
 *   x^(1/3) and x^(2/3) etc. give real roots for negative x.
 */
(function (global) {
  'use strict';

  const FUNCS = {
    sin: Math.sin, cos: Math.cos, tan: Math.tan,
    sec: (a) => 1 / Math.cos(a), csc: (a) => 1 / Math.sin(a), cot: (a) => 1 / Math.tan(a),
    asin: Math.asin, acos: Math.acos, atan: Math.atan,
    arcsin: Math.asin, arccos: Math.acos, arctan: Math.atan,
    asec: (a) => Math.acos(1 / a), acsc: (a) => Math.asin(1 / a), acot: (a) => Math.atan(1 / a),
    atan2: Math.atan2,
    sinh: Math.sinh, cosh: Math.cosh, tanh: Math.tanh,
    asinh: Math.asinh, acosh: Math.acosh, atanh: Math.atanh,
    sqrt: Math.sqrt, cbrt: Math.cbrt, abs: Math.abs,
    ln: Math.log, log10: Math.log10, log2: Math.log2, exp: Math.exp,
    log: (a, b) => (b === undefined ? Math.log10(a) : Math.log(a) / Math.log(b)),
    floor: Math.floor, ceil: Math.ceil, round: Math.round, sign: Math.sign,
    min: Math.min, max: Math.max,
    pow: (a, b) => realPow(a, b),
    nthroot: (a, n) => realPow(a, 1 / n),
    root: (a, n) => realPow(a, 1 / n),
    mod: (a, b) => ((a % b) + b) % b,
    fact: factorial,
  };
  const CONSTS = { pi: Math.PI, e: Math.E, tau: 2 * Math.PI, inf: Infinity, infinity: Infinity };

  function factorial(n) {
    if (n < 0 || !Number.isFinite(n)) return NaN;
    if (Math.abs(n - Math.round(n)) > 1e-9) return gamma(n + 1);
    n = Math.round(n);
    if (n > 170) return Infinity;
    let r = 1;
    for (let i = 2; i <= n; i++) r *= i;
    return r;
  }
  // Lanczos approximation (for non-integer factorials)
  function gamma(z) {
    const g = 7;
    const c = [0.99999999999980993, 676.5203681218851, -1259.1392167224028, 771.32342877765313,
      -176.61502916214059, 12.507343278686905, -0.13857109526572012, 9.9843695780195716e-6, 1.5056327351493116e-7];
    if (z < 0.5) return Math.PI / (Math.sin(Math.PI * z) * gamma(1 - z));
    z -= 1;
    let x = c[0];
    for (let i = 1; i < g + 2; i++) x += c[i] / (z + i);
    const t = z + g + 0.5;
    return Math.sqrt(2 * Math.PI) * Math.pow(t, z + 0.5) * Math.exp(-t) * x;
  }

  // Real-valued power: negative base with exponent p/q (q odd) returns the real root.
  function realPow(a, b) {
    if (a >= 0 || Number.isInteger(b)) return Math.pow(a, b);
    for (let q = 3; q <= 15; q += 2) {
      const p = b * q;
      const pr = Math.round(p);
      if (Math.abs(p - pr) < 1e-9) {
        const mag = Math.pow(-a, b);
        return pr % 2 === 0 ? mag : -mag;
      }
    }
    return NaN;
  }

  function normalize(src) {
    return String(src)
      .replace(/[−–—]/g, '-')
      .replace(/[×⋅·∙]/g, '*')
      .replace(/÷/g, '/')
      .replace(/π/g, 'pi')
      .replace(/√/g, 'sqrt')
      .replace(/∞/g, 'inf')
      .replace(/≤/g, '<=')
      .replace(/≥/g, '>=')
      .replace(/²/g, '^2')
      .replace(/³/g, '^3')
      .replace(/\*\*/g, '^')
      .replace(/\\cdot/g, '*')
      .replace(/\\left|\\right/g, '')
      .replace(/\\(sin|cos|tan|sec|csc|cot|ln|log|exp|sqrt|pi|arcsin|arccos|arctan|sinh|cosh|tanh)/g, '$1')
      .replace(/[{]/g, '(').replace(/[}]/g, ')')
      .replace(/\[/g, '(').replace(/\]/g, ')');
  }

  function tokenize(src) {
    const s = normalize(src);
    const out = [];
    let i = 0;
    while (i < s.length) {
      const ch = s[i];
      if (/\s/.test(ch)) { i++; continue; }
      if (/[0-9.]/.test(ch)) {
        const m = /^(\d+\.?\d*|\.\d+)(e[+-]?\d+)?/i.exec(s.slice(i));
        if (!m) throw new Error('Bad number near "' + s.slice(i, i + 6) + '"');
        out.push({ t: 'num', v: parseFloat(m[0]) });
        i += m[0].length;
        continue;
      }
      if (/[A-Za-z_]/.test(ch)) {
        const m = /^[A-Za-z_][A-Za-z0-9_]*/.exec(s.slice(i));
        out.push({ t: 'id', v: m[0] });
        i += m[0].length;
        continue;
      }
      const two = s.slice(i, i + 2);
      if (['<=', '>=', '==', '!='].includes(two)) { out.push({ t: 'op', v: two }); i += 2; continue; }
      if ('+-*/^(),|?:<>!%'.includes(ch)) { out.push({ t: 'op', v: ch }); i++; continue; }
      if (ch === '=') { out.push({ t: 'op', v: '==' }); i++; continue; }
      throw new Error('Unexpected character "' + ch + '"');
    }
    return splitIdentifiers(out);
  }

  // Split glued identifiers such as "xsin" -> x * sin, "pix" -> pi * x, "2xy" handled by implicit mult.
  function splitIdentifiers(tokens) {
    const known = (w) => w === 'x' || w === 't' || w === 'y' || w in CONSTS || w in FUNCS;
    const res = [];
    for (const tk of tokens) {
      if (tk.t !== 'id' || known(tk.v.toLowerCase()) || known(tk.v)) { res.push(tk); continue; }
      // greedy split from the left into known words
      let w = tk.v, parts = [], ok = true;
      while (w.length) {
        let found = null;
        for (let len = Math.min(6, w.length); len >= 1; len--) {
          const cand = w.slice(0, len);
          if (known(cand)) { found = cand; break; }
        }
        if (!found) { ok = false; break; }
        parts.push(found);
        w = w.slice(found.length);
      }
      if (ok && parts.length > 1) parts.forEach((p) => res.push({ t: 'id', v: p }));
      else res.push(tk);
    }
    return res;
  }

  function compile(src, vars) {
    vars = vars || ['x'];
    const toks = tokenize(src);
    let p = 0;
    const peek = () => toks[p];
    const isOp = (v) => toks[p] && toks[p].t === 'op' && toks[p].v === v;
    const eat = (v) => {
      if (!isOp(v)) throw new Error('Expected "' + v + '"' + (toks[p] ? ' near "' + toks[p].v + '"' : ' at end'));
      p++;
    };

    function parseTernary() {
      const cond = parseCompare();
      if (isOp('?')) {
        p++;
        const a = parseTernary();
        eat(':');
        const b = parseTernary();
        return (env) => (cond(env) ? a(env) : b(env));
      }
      return cond;
    }
    function parseCompare() {
      let left = parseAdd();
      while (peek() && peek().t === 'op' && ['<', '<=', '>', '>=', '==', '!='].includes(peek().v)) {
        const op = toks[p++].v;
        const right = parseAdd();
        const l = left;
        if (op === '<') left = (e) => (l(e) < right(e) ? 1 : 0);
        else if (op === '<=') left = (e) => (l(e) <= right(e) ? 1 : 0);
        else if (op === '>') left = (e) => (l(e) > right(e) ? 1 : 0);
        else if (op === '>=') left = (e) => (l(e) >= right(e) ? 1 : 0);
        else if (op === '==') left = (e) => (Math.abs(l(e) - right(e)) < 1e-12 ? 1 : 0);
        else left = (e) => (Math.abs(l(e) - right(e)) >= 1e-12 ? 1 : 0);
      }
      return left;
    }
    function parseAdd() {
      let left = parseMul();
      while (isOp('+') || isOp('-')) {
        const op = toks[p++].v;
        const right = parseMul();
        const l = left;
        left = op === '+' ? (e) => l(e) + right(e) : (e) => l(e) - right(e);
      }
      return left;
    }
    function startsFactor(tk) {
      if (!tk) return false;
      if (tk.t === 'num' || tk.t === 'id') return true;
      return tk.t === 'op' && tk.v === '(';
    }
    function parseMul() {
      let left = parseUnary();
      for (;;) {
        if (isOp('*') || isOp('/') || isOp('%')) {
          const op = toks[p++].v;
          const right = parseUnary();
          const l = left;
          if (op === '*') left = (e) => l(e) * right(e);
          else if (op === '/') left = (e) => l(e) / right(e);
          else left = (e) => l(e) % right(e);
        } else if (startsFactor(peek())) {
          const right = parsePower(); // implicit multiplication binds like *
          const l = left;
          left = (e) => l(e) * right(e);
        } else break;
      }
      return left;
    }
    function parseUnary() {
      if (isOp('-')) { p++; const a = parseUnary(); return (e) => -a(e); }
      if (isOp('+')) { p++; return parseUnary(); }
      return parsePower();
    }
    function parsePower() {
      const base = parsePostfix();
      if (isOp('^')) {
        p++;
        const ex = parseUnary(); // right-assoc, allows 2^-x
        return (e) => realPow(base(e), ex(e));
      }
      return base;
    }
    function parsePostfix() {
      let a = parsePrimary();
      while (isOp('!') && !(toks[p + 1] && toks[p + 1].t === 'op' && toks[p + 1].v === '=')) {
        p++;
        const inner = a;
        a = (e) => factorial(inner(e));
      }
      return a;
    }
    function parseArgs() {
      eat('(');
      const args = [];
      if (!isOp(')')) {
        args.push(parseTernary());
        while (isOp(',')) { p++; args.push(parseTernary()); }
      }
      eat(')');
      return args;
    }
    function parsePrimary() {
      const tk = peek();
      if (!tk) throw new Error('Unexpected end of expression');
      if (tk.t === 'num') { p++; const v = tk.v; return () => v; }
      if (tk.t === 'op' && tk.v === '(') { p++; const a = parseTernary(); eat(')'); return a; }
      if (tk.t === 'op' && tk.v === '|') { p++; const a = parseTernary(); eat('|'); return (e) => Math.abs(a(e)); }
      if (tk.t === 'id') {
        p++;
        const name = tk.v;
        const lname = name.toLowerCase();
        if (vars.includes(name)) return (e) => e[name];
        if (lname in FUNCS && isOp('^')) {
          // sin^2(x) -> (sin(x))^2 ; sin^-1(x) -> asin(x)
          p++;
          const ex = parseUnary();
          const exVal = ex({});
          const fn = FUNCS[lname];
          const arg = isOp('(') ? parseArgs()[0] : parsePower();
          if (exVal === -1 && FUNCS['a' + lname]) { const inv = FUNCS['a' + lname]; return (e) => inv(arg(e)); }
          return (e) => realPow(fn(arg(e)), exVal);
        }
        if (lname in FUNCS && isOp('(')) {
          const fn = FUNCS[lname];
          const args = parseArgs();
          // allow sin^2(x) style handled by normalize? (no) -- simple call
          if (args.length === 1) { const a0 = args[0]; return (e) => fn(a0(e)); }
          if (args.length === 2) { const a0 = args[0], a1 = args[1]; return (e) => fn(a0(e), a1(e)); }
          return (e) => fn.apply(null, args.map((f) => f(e)));
        }
        if (lname in FUNCS && !isOp('(')) {
          // "sin x" without parentheses: apply to next power-level factor
          const fn = FUNCS[lname];
          const a = parsePower();
          return (e) => fn(a(e));
        }
        if (name in CONSTS) { const v = CONSTS[name]; return () => v; }
        if (lname in CONSTS) { const v = CONSTS[lname]; return () => v; }
        throw new Error('Unknown name "' + name + '"');
      }
      throw new Error('Unexpected "' + tk.v + '"');
    }

    const fn = parseTernary();
    if (p < toks.length) throw new Error('Unexpected "' + toks[p].v + '"');
    return fn;
  }

  // Strip a leading "y =" / "f(x) =" so either "x^2" or "y = x^2" works.
  function stripLhs(src) {
    return String(src).replace(/^\s*(y|[a-zA-Z]\s*\(\s*[xt]\s*\))\s*=(?!=)\s*/, '');
  }

  function compileSafe(src, vars) {
    try {
      const f = compile(stripLhs(src), vars);
      return {
        ok: true,
        fn: (env) => {
          try { const v = f(env); return typeof v === 'number' ? v : NaN; } catch (e) { return NaN; }
        },
      };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  }

  // Evaluate a constant expression such as "pi/2", "-inf", "TOP".
  function evalConst(src) {
    if (typeof src === 'number') return src;
    if (src === null || src === undefined || src === '') return NaN;
    const r = compileSafe(String(src), []);
    return r.ok ? r.fn({}) : NaN;
  }

  const api = { compile: compileSafe, evalConst, realPow, _tokenize: tokenize, _normalize: normalize };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else global.Expr = api;
})(typeof window !== 'undefined' ? window : globalThis);
