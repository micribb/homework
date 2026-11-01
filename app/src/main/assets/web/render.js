/*
 * render.js — turns the solver's Markdown + LaTeX text into HTML.
 * Math: $...$, $$...$$, \(...\), \[...\]   (\$ is a literal dollar sign)
 * Markdown: paragraphs, **bold**, *italic*, `code`, - lists, 1. lists, | tables |, ### headings
 */
(function (global) {
  'use strict';

  function esc(s) {
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  function tex(src, display) {
    const k = global.katex;
    if (k && k.renderToString) {
      try {
        return k.renderToString(src, { displayMode: display, throwOnError: false, strict: 'ignore', trust: false, output: 'html' });
      } catch (e) { /* fall through */ }
    }
    return '<span class="tex-raw">' + esc(display ? '$$' + src + '$$' : '$' + src + '$') + '</span>';
  }

  // Pull math out first so Markdown never touches it.
  function extractMath(text) {
    const parts = [];
    const hold = (html, block) => { parts.push({ html, block }); return '\u0000' + (parts.length - 1) + '\u0000'; };
    let s = String(text == null ? '' : text).replace(/\r\n/g, '\n');
    s = s.replace(/\\\$/g, '\u0001'); // literal dollars
    s = s.replace(/\$\$([\s\S]+?)\$\$/g, (_, m) => hold(tex(m.trim(), true), true));
    s = s.replace(/\\\[([\s\S]+?)\\\]/g, (_, m) => hold(tex(m.trim(), true), true));
    s = s.replace(/\\\(([\s\S]+?)\\\)/g, (_, m) => hold(tex(m.trim(), false), false));
    // inline $...$: no newline inside, opening $ not followed by space, closing $ not preceded by space
    s = s.replace(/\$(?=\S)((?:[^$\n\\]|\\.)+?)(?<=\S)\$(?!\d)/g, (_, m) => hold(tex(m, false), false));
    // bare environments the model may emit without delimiters
    s = s.replace(/\\begin\{(aligned|align\*?|array|cases|gather\*?|matrix|pmatrix|bmatrix)\}([\s\S]+?)\\end\{\1\}/g,
      (all) => hold(tex(all.replace(/\{align\*?\}/g, '{aligned}').replace(/\{gather\*?\}/g, '{gathered}'), true), true));
    return { s, parts };
  }

  function inlineMd(s) {
    return s
      .replace(/`([^`]+)`/g, '<code>$1</code>')
      .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
      .replace(/__([^_]+)__/g, '<strong>$1</strong>')
      .replace(/(^|[\s(])\*([^*\s][^*]*?)\*(?=[\s).,;:!?]|$)/g, '$1<em>$2</em>');
  }

  function isTableRow(line) { return /^\s*\|.*\|\s*$/.test(line); }
  function isSepRow(line) { return /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/.test(line); }
  function cells(line) { return line.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map((c) => c.trim()); }

  function md(s) {
    const lines = s.split('\n');
    const out = [];
    let para = [];
    const flushPara = () => {
      if (para.length) { out.push('<p>' + inlineMd(para.join('<br>')) + '</p>'); para = []; }
    };
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const t = line.trim();
      if (!t) { flushPara(); continue; }
      // block math placeholder alone on its line
      if (/^\u0000\d+\u0000$/.test(t)) { flushPara(); out.push(t); continue; }
      if (isTableRow(t) && i + 1 < lines.length && isSepRow(lines[i + 1])) {
        flushPara();
        const head = cells(t);
        i += 1;
        const rows = [];
        while (i + 1 < lines.length && isTableRow(lines[i + 1])) { i++; rows.push(cells(lines[i])); }
        out.push('<table><thead><tr>' + head.map((c) => '<th>' + inlineMd(c) + '</th>').join('') + '</tr></thead><tbody>' +
          rows.map((r) => '<tr>' + r.map((c) => '<td>' + inlineMd(c) + '</td>').join('') + '</tr>').join('') + '</tbody></table>');
        continue;
      }
      const ul = /^[-*•]\s+(.*)$/.exec(t);
      const ol = /^(\d+)[.)]\s+(.*)$/.exec(t);
      if (ul || ol) {
        flushPara();
        const tag = ul ? 'ul' : 'ol';
        const items = [(ul ? ul[1] : ol[2])];
        while (i + 1 < lines.length) {
          const nt = lines[i + 1].trim();
          const m = ul ? /^[-*•]\s+(.*)$/.exec(nt) : /^(\d+)[.)]\s+(.*)$/.exec(nt);
          if (!m) break;
          items.push(ul ? m[1] : m[2]);
          i++;
        }
        out.push('<' + tag + '>' + items.map((it) => '<li>' + inlineMd(it) + '</li>').join('') + '</' + tag + '>');
        continue;
      }
      const h = /^#{1,6}\s+(.*)$/.exec(t);
      if (h) { flushPara(); out.push('<h4>' + inlineMd(h[1]) + '</h4>'); continue; }
      para.push(t);
    }
    flushPara();
    return out.join('');
  }

  function rich(text) {
    const { s, parts } = extractMath(text);
    let html = md(esc(s));
    // restore math (block placeholders sitting alone become block divs)
    html = html.replace(/\u0000(\d+)\u0000/g, (_, i) => {
      const p = parts[+i];
      // span (styled display:block) so it is valid inside <p> and <li>
      return p.block ? '<span class="mblock">' + p.html + '</span>' : p.html;
    });
    html = html.replace(/<br>(<span class="mblock">)/g, '$1').replace(/(<span class="mblock">(?:(?!<span class="mblock">).)*?<\/span>)<br>/g, '$1');
    return html.replace(/\u0001/g, '$');
  }

  global.Rich = { render: rich, esc };
  if (typeof module !== 'undefined' && module.exports) module.exports = global.Rich;
})(typeof window !== 'undefined' ? window : globalThis);
