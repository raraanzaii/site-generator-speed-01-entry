// A fast drop-in for makefun-site 1.0.0: run(input) returns the same output tree makefun-site's build returns for
// every input, byte for byte, in a fraction of the CPU time. The dialect is makefun-site's own (front matter,
// Markdown subset, template language, slug rule and build report); this module re-implements that behaviour from
// scratch with the hot paths engineered for speed: batched HTML escaping, a range-based inline parser that never
// copies substrings to search them, hand-rolled line classification instead of per-line regexes, memoised slugs,
// a manual word counter, and templates compiled once per build into plain JavaScript functions.
//
// The input: { site: { title, base_url, per_page, recent }, templates: { name: source }, files: [{ path, content }] }.
// The output: a JSON object of output path -> file text. A build reads no clock, no environment and no file.

// ---------------------------------------------------------------- text

const ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const ESCAPE_RE = /[&<>"']/g;

/** `text` with & < > " and ' escaped. Called on whole runs, never per character. */
function escapeHtml(text) {
  return text.replace(ESCAPE_RE, (c) => ESCAPES[c]);
}

const SLUG_MAX = 64;
const MARKS_RE = /\p{M}/gu;

/** The slug of `text`, uncached: NFKD, marks dropped, lowered, runs of non [a-z0-9] one "-", cut at 64. */
function slugifyRaw(text) {
  const plain = text.normalize('NFKD').replace(MARKS_RE, '');
  let out = '';
  let gap = false;
  for (const ch of plain) {
    let keep = null;
    if (ch >= 'A' && ch <= 'Z') keep = ch.toLowerCase();
    else if ((ch >= 'a' && ch <= 'z') || (ch >= '0' && ch <= '9')) keep = ch;
    if (keep === null) {
      gap = out.length > 0;
      continue;
    }
    if (gap) out += '-';
    gap = false;
    out += keep;
  }
  out = out.slice(0, SLUG_MAX).replace(/-+$/, '');
  return out === '' ? 'untitled' : out;
}

/** `slug` made unique against `taken` (and added to it): the first of slug, slug-2, slug-3 ... not taken. */
function uniqueSlug(slug, taken) {
  let out = slug;
  for (let n = 2; taken.has(out); n++) out = `${slug}-${n}`;
  taken.add(out);
  return out;
}

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

/** A YYYY-MM-DD date in words, from the string alone. */
function longDate(date) {
  const [y, m, d] = date.split('-');
  return `${Number(d)} ${MONTHS[Number(m) - 1]} ${y}`;
}

// The JavaScript \s class as a lookup table over UTF-16 code units, built once.
const WS_TABLE = new Uint8Array(65536);
for (let c = 9; c <= 13; c++) WS_TABLE[c] = 1;
WS_TABLE[32] = 1;
WS_TABLE[0xa0] = 1;
WS_TABLE[0x1680] = 1;
for (let c = 0x2000; c <= 0x200a; c++) WS_TABLE[c] = 1;
WS_TABLE[0x2028] = 1;
WS_TABLE[0x2029] = 1;
WS_TABLE[0x202f] = 1;
WS_TABLE[0x205f] = 1;
WS_TABLE[0x3000] = 1;
WS_TABLE[0xfeff] = 1;

/** Whether a UTF-16 code unit is JavaScript whitespace (the \s class), for word counting and link targets. */
function isWs(code) {
  return WS_TABLE[code] === 1;
}

/** The words of a body: its runs of characters other than whitespace (what /\S+/g would count). */
function wordsOf(text) {
  let n = 0;
  let inWord = false;
  for (let i = 0; i < text.length; i++) {
    const ws = WS_TABLE[text.charCodeAt(i)] === 1;
    if (!ws && !inWord) n++;
    inWord = !ws;
  }
  return n;
}

// ---------------------------------------------------------------- front matter

const FM_KEYS = new Set(['title', 'date', 'tags', 'draft', 'layout', 'slug', 'summary']);

/** The days of month `m` (1-12) of year `y`, by the Gregorian rule. */
function daysIn(y, m) {
  if (m === 2) return (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0 ? 29 : 28;
  return m === 4 || m === 6 || m === 9 || m === 11 ? 30 : 31;
}

/** A string value: "..." with \" and \\ its only escapes, or bare, the rest of the line (never opening on " or [). */
function stringOf(raw) {
  if (raw.startsWith('"')) {
    if (raw.length < 2 || !raw.endsWith('"')) return { error: 'a quoted string is not closed' };
    let out = '';
    for (let i = 1; i < raw.length - 1; i++) {
      const c = raw[i];
      if (c === '\\') {
        const n = raw[i + 1];
        if ((n !== '"' && n !== '\\') || i + 1 === raw.length - 1) return { error: 'a quoted string holds an escape other than \\" or \\\\' };
        out += n;
        i++;
      } else if (c === '"') return { error: 'a quoted string holds a stray quote' };
      else out += c;
    }
    return { value: out };
  }
  if (raw.startsWith('[')) return { error: 'a bare string opens on [' };
  return { value: raw };
}

function isDigit(ch) {
  return ch >= '0' && ch <= '9';
}

/** One key's value, or why it is refused. */
function valueOf(key, raw) {
  switch (key) {
    case 'title':
    case 'summary': {
      const s = stringOf(raw);
      return 'error' in s ? { error: `key "${key}": ${s.error}` } : s;
    }
    case 'date': {
      let ok = raw.length === 10 && raw[4] === '-' && raw[7] === '-';
      if (ok) {
        for (let i = 0; i < 10; i++) {
          if (i === 4 || i === 7) continue;
          if (!isDigit(raw[i])) {
            ok = false;
            break;
          }
        }
      }
      if (ok) {
        const y = Number(raw.slice(0, 4));
        const mo = Number(raw.slice(5, 7));
        const d = Number(raw.slice(8, 10));
        ok = y >= 1970 && y <= 2099 && mo >= 1 && mo <= 12 && d >= 1 && d <= daysIn(y, mo);
      }
      return ok ? { value: raw } : { error: 'key "date": not a date from 1970-01-01 to 2099-12-31 (YYYY-MM-DD)' };
    }
    case 'tags': {
      if (!raw.startsWith('[') || !raw.endsWith(']')) return { error: 'key "tags": not a list [a, b]' };
      const inner = raw.slice(1, -1);
      if (inner.trim() === '') return { value: [] };
      const tags = inner.split(',').map((t) => t.trim());
      for (const t of tags) {
        if (t === '' || t.includes('"') || t.includes('[') || t.includes(']')) return { error: 'key "tags": an empty tag, or one holding " [ or ]' };
      }
      return { value: tags };
    }
    case 'draft':
      return raw === 'true' ? { value: true } : raw === 'false' ? { value: false } : { error: 'key "draft": true or false' };
    case 'layout': {
      if (raw === '') return { error: 'key "layout": not a template name' };
      for (let i = 0; i < raw.length; i++) {
        const c = raw[i];
        if (!((c >= 'a' && c <= 'z') || isDigit(c) || c === '-')) return { error: 'key "layout": not a template name' };
      }
      return { value: raw };
    }
    case 'slug': {
      // ^[a-z0-9]+(?:-[a-z0-9]+)*$ and at most 64 characters.
      let ok = raw.length >= 1 && raw.length <= 64;
      if (ok) {
        let seg = 0;
        for (let i = 0; i <= raw.length; i++) {
          const c = raw[i];
          if (i === raw.length || c === '-') {
            if (seg === 0) {
              ok = false;
              break;
            }
            seg = 0;
          } else if ((c >= 'a' && c <= 'z') || isDigit(c)) seg++;
          else {
            ok = false;
            break;
          }
        }
      }
      return ok ? { value: raw } : { error: 'key "slug": not a slug' };
    }
    default:
      return { error: `unknown key "${key}"` };
  }
}

/** Whether `line` is blank: spaces and tabs only. */
function isBlankLine(line) {
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c !== ' ' && c !== '\t') return false;
  }
  return true;
}

/**
 * A "key: value" line split as the front-matter line grammar reads it: a key of a-z and "_", a colon, then either
 * the end of the line or one space and the value. Returns [key, rawValue] or null.
 */
function fmLine(line) {
  let i = 0;
  while (i < line.length) {
    const c = line[i];
    if ((c >= 'a' && c <= 'z') || c === '_') i++;
    else break;
  }
  if (i === 0 || line[i] !== ':') return null;
  const rest = line.slice(i + 1);
  if (rest === '') return [line.slice(0, i), ''];
  if (rest[0] !== ' ') return null;
  return [line.slice(0, i), rest.slice(1)];
}

/** Trailing spaces and tabs dropped. */
function rtrimSt(s) {
  let b = s.length;
  while (b > 0 && (s[b - 1] === ' ' || s[b - 1] === '\t')) b--;
  return b === s.length ? s : s.slice(0, b);
}

/**
 * A source's front matter and body: { data, body }, or { error } with the first reason it is refused. `text` has
 * "\n" line ends. Only the header is scanned line by line; the body is one slice, never split and rejoined. The
 * closing line is located before any line is judged, so "not closed" outranks a malformed line, as in the
 * reference.
 */
function parseFrontMatter(text) {
  const firstEnd = text.indexOf('\n');
  if ((firstEnd === -1 ? text : text.slice(0, firstEnd)) !== '---') return { error: 'no front matter' };
  if (firstEnd === -1) return { error: 'the front matter is not closed' };
  // The first later line that is exactly "---": its start offset and the offset just past its line end.
  let closeStart = -1;
  let bodyStart = -1;
  for (let pos = firstEnd + 1; ; ) {
    const end = text.indexOf('\n', pos);
    const line = end === -1 ? text.slice(pos) : text.slice(pos, end);
    if (line === '---') {
      closeStart = pos;
      bodyStart = end === -1 ? text.length : end + 1;
      break;
    }
    if (end === -1) break;
    pos = end + 1;
  }
  if (closeStart === -1) return { error: 'the front matter is not closed' };
  const data = {};
  let idx = 1; // the opening "---" is line 1 of the split-lines view; the first header line is index 1
  for (let pos = firstEnd + 1; pos < closeStart; ) {
    const end = text.indexOf('\n', pos);
    const line = text.slice(pos, end);
    idx++;
    pos = end + 1;
    if (isBlankLine(line) || line.startsWith('#')) continue;
    const m = fmLine(line);
    if (m === null) return { error: `line ${idx} is not "key: value"` };
    const key = m[0];
    const raw = rtrimSt(m[1]);
    if (!FM_KEYS.has(key)) return { error: `unknown key "${key}"` };
    if (Object.hasOwn(data, key)) return { error: `key "${key}" is given twice` };
    if (raw === '') return { error: `key "${key}" has no value` };
    const v = valueOf(key, raw);
    if ('error' in v) return v;
    data[key] = v.value;
  }
  if (!Object.hasOwn(data, 'title')) return { error: 'no title' };
  return { data, body: text.slice(bodyStart) };
}

// ---------------------------------------------------------------- markdown

/** A fence-opening line's language, or null: three backticks, language characters, then spaces or tabs only. */
function fenceOpen(line) {
  if (line.charCodeAt(0) !== 96 || line.charCodeAt(1) !== 96 || line.charCodeAt(2) !== 96) return null;
  let lang = '';
  let i = 3;
  while (i < line.length) {
    const c = line[i];
    if ((c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || isDigit(c) || c === '_' || c === '+' || c === '-') {
      lang += c;
      i++;
    } else break;
  }
  while (i < line.length) {
    const c = line[i];
    if (c === ' ' || c === '\t') i++;
    else return null;
  }
  return lang;
}

/** Whether `line` closes a fence: three backticks, then spaces or tabs only. */
function fenceClose(line) {
  if (line.charCodeAt(0) !== 96 || line.charCodeAt(1) !== 96 || line.charCodeAt(2) !== 96) return false;
  for (let i = 3; i < line.length; i++) {
    const c = line[i];
    if (c !== ' ' && c !== '\t') return false;
  }
  return true;
}

/** A heading line's level and text, or null (a heading's text is never empty). */
function headingOf(line) {
  let i = 0;
  while (line[i] === '#') i++;
  if (i === 0 || i > 6) return null;
  let j = i;
  while (j < line.length && (line[j] === ' ' || line[j] === '\t')) j++;
  if (j === i) return null; // at least one space or tab after the #s
  let end = line.length;
  while (end > j && (line[end - 1] === ' ' || line[end - 1] === '\t')) end--;
  if (end <= j) return null;
  return { depth: i, text: line.slice(j, end) };
}

/** Whether `line` is a thematic break: "---" or "***", then spaces or tabs only. */
function isHr(line) {
  const a = line[0];
  if ((a !== '-' && a !== '*') || line[1] !== a || line[2] !== a) return false;
  for (let i = 3; i < line.length; i++) {
    const c = line[i];
    if (c !== ' ' && c !== '\t') return false;
  }
  return true;
}

/** A bullet item's text (after "- " or "* "), or null. */
function bulletOf(line) {
  const c = line[0];
  return (c === '-' || c === '*') && line[1] === ' ' ? line.slice(2) : null;
}

/** An ordered item's number and text (after "N. "), or null. */
function orderedOf(line) {
  let i = 0;
  while (i < line.length && isDigit(line[i])) i++;
  if (i === 0 || i > 9) return null;
  if (line[i] !== '.' || line[i + 1] !== ' ') return null;
  return { num: Number(line.slice(0, i)), text: line.slice(i + 2) };
}

/** Whether `line` continues a list item: two or more spaces, then a non-space. */
function isContinued(line) {
  let i = 0;
  while (line[i] === ' ') i++;
  return i >= 2 && i < line.length && !isWs(line.charCodeAt(i));
}

/** A line trimmed of spaces and tabs at both ends. */
function trimLine(line) {
  let a = 0;
  let b = line.length;
  while (a < b && (line[a] === ' ' || line[a] === '\t')) a++;
  while (b > a && (line[b - 1] === ' ' || line[b - 1] === '\t')) b--;
  return a === 0 && b === line.length ? line : line.slice(a, b);
}

/** Whether `line` ends a paragraph: a blank line, a fence, a heading or a thematic break. */
function endsParagraph(line) {
  return isBlankLine(line) || fenceOpen(line) !== null || headingOf(line) !== null || isHr(line);
}

// The characters a backslash escapes, by char code.
const ESCAPABLE = new Uint8Array(128);
for (const c of ['\\', '`', '*', '_', '[', ']', '(', ')', '#', '+', '-', '.', '!', '>']) ESCAPABLE[c.charCodeAt(0)] = 1;

function isEscapable(ch) {
  const code = ch.charCodeAt(0);
  return code < 128 && ESCAPABLE[code] === 1;
}

/** The first index in [from, end) where s holds `what` outside a backslash escape, or -1. */
function findUnescaped(s, what, from, end) {
  const wlen = what.length;
  for (let j = from; j + wlen <= end; j++) {
    if (s[j] === '\\' && j + 1 < end && isEscapable(s[j + 1])) {
      j++;
      continue;
    }
    if (s.startsWith(what, j)) return j;
  }
  return -1;
}

/** The first single * in [from, end) (one whose run is not **), outside an escape, or -1. */
function findSingleStar(s, from, end) {
  for (let j = from; j < end; j++) {
    const c = s[j];
    if (c === '\\' && j + 1 < end && isEscapable(s[j + 1])) {
      j++;
      continue;
    }
    if (c !== '*') continue;
    if (j + 1 < end && s[j + 1] === '*') {
      j++;
      continue;
    }
    return j;
  }
  return -1;
}

/** Whether `s` holds a whitespace character (the \s class) anywhere. */
function hasWs(s) {
  for (let i = 0; i < s.length; i++) if (isWs(s.charCodeAt(i))) return true;
  return false;
}

/**
 * s[start, end) rendered inline into `out` (an array of pieces); `env.link(target)` is a link's href. Plain runs
 * are escaped in one batch; the special characters that render as themselves (a lone backtick, an unmatched *,
 * a [ that opens no link) simply stay in the run, exactly as the reference writes them.
 */
function inlineRange(s, start, end, env, out) {
  let i = start;
  let run = start;
  const flush = (to) => {
    if (to > run) out.push(escapeHtml(s.slice(run, to)));
  };
  while (i < end) {
    const c = s[i];
    if (c === '\\' && i + 1 < end && isEscapable(s[i + 1])) {
      flush(i);
      out.push(escapeHtml(s[i + 1]));
      i += 2;
      run = i;
      continue;
    }
    if (c === '`') {
      let j = s.indexOf('`', i + 1);
      if (j >= end) j = -1;
      if (j > i + 1) {
        flush(i);
        out.push('<code>', escapeHtml(s.slice(i + 1, j)), '</code>');
        i = j + 1;
        run = i;
      } else i++;
      continue;
    }
    if (c === '*') {
      if (i + 1 < end && s[i + 1] === '*') {
        const j = findUnescaped(s, '**', i + 2, end);
        if (j > i + 2) {
          flush(i);
          out.push('<strong>');
          inlineRange(s, i + 2, j, env, out);
          out.push('</strong>');
          i = j + 2;
          run = i;
        } else i += 2;
        continue;
      }
      const j = findSingleStar(s, i + 1, end);
      if (j > i + 1) {
        flush(i);
        out.push('<em>');
        inlineRange(s, i + 1, j, env, out);
        out.push('</em>');
        i = j + 1;
        run = i;
      } else i++;
      continue;
    }
    if (c === '[') {
      const k = findUnescaped(s, ']', i + 1, end);
      let m = -1;
      if (k !== -1 && k + 1 < end && s[k + 1] === '(') {
        m = s.indexOf(')', k + 2);
        if (m >= end) m = -1;
      }
      const target = m === -1 ? '' : s.slice(k + 2, m);
      if (target !== '' && !hasWs(target)) {
        flush(i);
        out.push('<a href="', escapeHtml(env.link(target)), '">');
        inlineRange(s, i + 1, k, env, out);
        out.push('</a>');
        i = m + 1;
        run = i;
        continue;
      }
      i++;
      continue;
    }
    i++;
  }
  flush(end);
}

/** `s` rendered inline; `env.link(target)` is a link's href. */
function inline(s, env) {
  const out = [];
  inlineRange(s, 0, s.length, env, out);
  return out.join('');
}

/**
 * `src` rendered: its HTML (each block followed by "\n"), its table of contents (every level 2 and 3 heading:
 * level, id and its inline HTML) and its excerpt (the first paragraph's inline HTML, or ""). `slug` is the build's
 * memoised slugifier.
 */
function renderMarkdown(src, env, slug) {
  const lines = src.split('\n');
  const ids = new Set();
  const blocks = [];
  const toc = [];
  let excerpt = null;
  let i = 0;
  const n = lines.length;
  while (i < n) {
    const line = lines[i];
    if (isBlankLine(line)) {
      i++;
      continue;
    }
    const lang = fenceOpen(line);
    if (lang !== null) {
      i++;
      let inner = '';
      while (i < n && !fenceClose(lines[i])) inner += `${escapeHtml(lines[i++])}\n`;
      i++;
      blocks.push(`<pre><code${lang === '' ? '' : ` class="language-${escapeHtml(lang)}"`}>${inner}</code></pre>`);
      continue;
    }
    const heading = headingOf(line);
    if (heading !== null) {
      const id = uniqueSlug(slug(heading.text), ids);
      const html = inline(heading.text, env);
      blocks.push(`<h${heading.depth} id="${id}">${html}</h${heading.depth}>`);
      if (heading.depth === 2 || heading.depth === 3) toc.push({ level: heading.depth, id, html });
      i++;
      continue;
    }
    if (isHr(line)) {
      blocks.push('<hr>');
      i++;
      continue;
    }
    if (line.charCodeAt(0) === 62) {
      const kept = [];
      while (i < n && lines[i].charCodeAt(0) === 62) {
        let s = lines[i].slice(1);
        if (s.charCodeAt(0) === 32) s = s.slice(1);
        const t = trimLine(s);
        if (t !== '') kept.push(t);
        i++;
      }
      blocks.push(kept.length === 0 ? '<blockquote>\n</blockquote>' : `<blockquote>\n<p>${inline(kept.join('\n'), env)}</p>\n</blockquote>`);
      continue;
    }
    const bullet = bulletOf(line);
    const ordered = bullet === null ? orderedOf(line) : null;
    if (bullet !== null || ordered !== null) {
      const isOrd = ordered !== null;
      const start = isOrd ? ordered.num : 1;
      const items = [];
      while (i < n) {
        const l = lines[i];
        const m = isOrd ? orderedOf(l) : bulletOf(l);
        if (m !== null) {
          items.push([trimLine(isOrd ? m.text : m)]);
          i++;
        } else if (isContinued(l)) {
          items[items.length - 1].push(trimLine(l));
          i++;
        } else break;
      }
      const tag = isOrd ? 'ol' : 'ul';
      let block = `${isOrd && start !== 1 ? `<ol start="${start}">` : `<${tag}>`}\n`;
      for (const parts of items) block += `<li>${inline(parts.join('\n'), env)}</li>\n`;
      blocks.push(block + `</${tag}>`);
      continue;
    }
    const body = [trimLine(line)];
    i++;
    while (i < n && !endsParagraph(lines[i])) body.push(trimLine(lines[i++]));
    const html = inline(body.join('\n'), env);
    if (excerpt === null) excerpt = html;
    blocks.push(`<p>${html}</p>`);
  }
  return { html: blocks.map((b) => `${b}\n`).join(''), toc, excerpt: excerpt ?? '' };
}

// ---------------------------------------------------------------- templates

const PATH_FIRST = /[A-Za-z_]/;
const PATH_REST = /[A-Za-z0-9_]/;

/** A dotted path ("site", "page.title") as its list of names, or null if `s` is not a path. */
function pathOf(s) {
  if (s === '') return null;
  const names = s.split('.');
  for (const name of names) {
    if (name === '' || !PATH_FIRST.test(name[0])) return null;
    for (let i = 1; i < name.length; i++) if (!PATH_REST.test(name[i])) return null;
  }
  return names;
}

const fail = (reason) => {
  throw new Error(reason);
};

/** A template source as nodes: text, var (escaped or raw), for, if and include. Throws Error with the reason. */
function lexTemplate(source) {
  const nodes = [];
  const stack = [{ nodes }];
  const cur = () => stack[stack.length - 1].nodes;
  let i = 0;
  const n = source.length;
  while (i < n) {
    const openVar = source.indexOf('{{', i);
    const openTag = source.indexOf('{%', i);
    const open = openVar === -1 ? openTag : openTag === -1 ? openVar : Math.min(openVar, openTag);
    if (open === -1) {
      cur().push({ type: 'text', text: source.slice(i) });
      break;
    }
    if (open > i) cur().push({ type: 'text', text: source.slice(i, open) });
    if (source.startsWith('{{{', open)) {
      const close = source.indexOf('}}}', open + 3);
      if (close === -1) fail('an unclosed {{{');
      const path = pathOf(source.slice(open + 3, close).trim());
      if (path === null) fail('{{{ }}} does not hold a path');
      cur().push({ type: 'var', path, raw: true });
      i = close + 3;
    } else if (source.startsWith('{{', open)) {
      const close = source.indexOf('}}', open + 2);
      if (close === -1) fail('an unclosed {{');
      const path = pathOf(source.slice(open + 2, close).trim());
      if (path === null) fail('{{ }} does not hold a path');
      cur().push({ type: 'var', path, raw: false });
      i = close + 2;
    } else {
      const close = source.indexOf('%}', open + 2);
      if (close === -1) fail('an unclosed {%');
      const body = source.slice(open + 2, close).trim();
      // A {% %} tag alone on its line (spaces and tabs only around it) takes the whole line, its "\n" too.
      let at = open;
      let alone = true;
      for (let k = open - 1; k >= 0 && source[k] !== '\n'; k--) {
        if (source[k] !== ' ' && source[k] !== '\t') {
          alone = false;
          break;
        } else at = k;
      }
      let end = close + 2;
      if (alone) {
        let e = end;
        while (e < n && (source[e] === ' ' || source[e] === '\t')) e++;
        if (e < n && source[e] === '\n') end = e + 1;
        else if (e !== n) alone = false;
        if (alone) {
          const last = cur()[cur().length - 1];
          if (last !== undefined && last.type === 'text') last.text = last.text.slice(0, last.text.length - (open - at));
        }
      }
      if (!alone) at = open;
      i = end;
      if (body === 'endfor') {
        const top = stack[stack.length - 1];
        if (stack.length === 1 || top.kind !== 'for') fail('{% endfor %} closes nothing');
        stack.pop();
      } else if (body === 'endif') {
        const top = stack[stack.length - 1];
        if (stack.length === 1 || top.kind !== 'if') fail('{% endif %} closes nothing');
        stack.pop();
      } else if (body === 'else') {
        const top = stack[stack.length - 1];
        if (stack.length === 1 || top.kind !== 'if' || top.node.else !== null) fail('{% else %} outside an {% if %}');
        top.node.else = [];
        top.nodes = top.node.else;
      } else if (body.startsWith('for ')) {
        const rest = body.slice(4).trim();
        const sp = rest.indexOf(' ');
        const varName = sp === -1 ? '' : rest.slice(0, sp);
        const tail = sp === -1 ? '' : rest.slice(sp).trim();
        const path = tail.startsWith('in ') ? pathOf(tail.slice(3).trim()) : null;
        if (path === null || pathOf(varName) === null || varName.includes('.')) fail('{% for %} is not "for name in path"');
        const node = { type: 'for', varName, path, body: [] };
        cur().push(node);
        stack.push({ kind: 'for', node, nodes: node.body });
      } else if (body.startsWith('if ')) {
        const rest = body.slice(3).trim();
        let neg = false;
        let p = rest;
        if (rest.startsWith('not ')) {
          neg = true;
          p = rest.slice(4).trim();
        }
        const path = pathOf(p);
        if (path === null) fail('{% if %} does not hold a path');
        const node = { type: 'if', path, neg, then: [], else: null };
        cur().push(node);
        stack.push({ kind: 'if', node, nodes: node.then });
      } else if (body.startsWith('include ')) {
        const rest = body.slice(8).trim();
        const s = rest.startsWith('"') ? stringOf(rest) : { error: 'x' };
        if ('error' in s) fail('{% include %} does not hold a quoted name');
        cur().push({ type: 'include', name: s.value });
      } else fail(`an unknown tag "{% ${body} %}"`);
    }
  }
  if (stack.length !== 1) fail(`an unclosed {% ${stack[stack.length - 1].kind} %}`);
  return nodes;
}

// ---------------------------------------------------------------- template runtime helpers

/** A value as template text: a string itself, a number its digits, true/false, an array joined ", ", else "". */
function textOf(value) {
  if (typeof value === 'string') return value;
  if (typeof value === 'number') return String(value);
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (Array.isArray(value)) return value.map(textOf).join(', ');
  return '';
}

/** Whether a value renders an {% if %}: undefined, null, false, "", 0 and [] are falsy. */
function truthy(value) {
  if (value === undefined || value === null || value === false || value === '' || value === 0) return false;
  return !(Array.isArray(value) && value.length === 0);
}

/** Names `path[1..]` read down from `value`, each an own property of an object, or undefined. */
function walk(value, path, from) {
  for (let k = from; k < path.length; k++) {
    if (typeof value !== 'object' || value === null || !Object.hasOwn(value, path[k])) return undefined;
    value = value[path[k]];
  }
  return value;
}

/**
 * A path's value against a scope chain: the first name from the innermost scope that owns it (a scope is
 * { v, p }), then each later name an own property of an object. Undefined when the path does not resolve.
 */
function lookup(scope, path) {
  let s = scope;
  let value;
  let found = false;
  while (s !== null) {
    if (Object.hasOwn(s.v, path[0])) {
      value = s.v[path[0]];
      found = true;
      break;
    }
    s = s.p;
  }
  if (!found) return undefined;
  return walk(value, path, 1);
}

// ---------------------------------------------------------------- template compilation

const INCLUDE_MAX = 8;

/** Whether `name` is statically bound by one of the enclosing compiled loops (an array of frames). */
function boundIn(frames, name) {
  for (let f = frames.length - 1; f >= 0; f--) if (frames[f].has(name)) return true;
  return false;
}

/**
 * The JS expression for a path: when its first name is a statically bound loop local, a direct walk from that
 * local (each loop variable lives in `L<depth><name>`); otherwise a lookup against the scope chain `S`.
 */
function pathExpr(path, frames, depth) {
  const first = path[0];
  if (boundIn(frames, first)) {
    const local = `L${depth[first]}${first}`;
    return path.length === 1 ? local : `H.W(${local},${JSON.stringify(path)},1)`;
  }
  return `H.K(S,${JSON.stringify(path)})`;
}

/**
 * Compile a template's nodes to a function (S, D, H) -> string, where S is the scope chain, D the include depth
 * and H the helper bundle { E: escapeHtml, T: textOf, Y: truthy, K: lookup, W: walk, I: include }. Paths whose
 * first segment is bound by an enclosing for in THIS template resolve to JS locals; everything else goes through
 * the dynamic scope, so includes and dynamic names behave exactly like the reference interpreter.
 */
function compileNodes(nodes) {
  const code = ['const O=[];'];
  let uid = 0;
  const gen = (list, frames, depth) => {
    for (const node of list) {
      if (node.type === 'text') {
        if (node.text !== '') code.push(`O.push(${JSON.stringify(node.text)});`);
      } else if (node.type === 'var') {
        const e = pathExpr(node.path, frames, depth);
        code.push(node.raw ? `O.push(H.T(${e}));` : `O.push(H.E(H.T(${e})));`);
      } else if (node.type === 'include') {
        // Materialise the static bindings visible here into a scope node, innermost frame on top.
        let scopeExpr = 'S';
        const merged = new Map();
        for (const frame of frames) for (const [name, d] of frame) merged.set(name, d);
        if (merged.size > 0) {
          const parts = [];
          for (const [name, d] of merged) parts.push(`${JSON.stringify(name)}:L${d}${name}`);
          scopeExpr = `{v:{${parts.join(',')}},p:S}`;
        }
        code.push(`if(D<${INCLUDE_MAX})O.push(H.I(${JSON.stringify(node.name)},${scopeExpr},D+1));`);
      } else if (node.type === 'if') {
        const e = pathExpr(node.path, frames, depth);
        const id = uid++;
        // {% if not path %} renders the then-branch when the value is falsy.
        code.push(`{const V${id}=${e};if(${node.neg ? '!' : ''}H.Y(V${id})){`);
        gen(node.then, frames, depth);
        if (node.else !== null) {
          code.push('}else{');
          gen(node.else, frames, depth);
        }
        code.push('}}');
      } else if (node.type === 'for') {
        const e = pathExpr(node.path, frames, depth);
        const id = uid++;
        const d = frames.length;
        const arr = `A${id}`;
        const idx = `J${id}`;
        const len = `N${id}`;
        code.push(`{const ${arr}=${e};if(Array.isArray(${arr})){const ${len}=${arr}.length;`);
        code.push(`let L${d}${node.varName};let L${d}loop;for(let ${idx}=0;${idx}<${len};${idx}++){L${d}${node.varName}=${arr}[${idx}];L${d}loop={index:${idx}+1,first:${idx}===0,last:${idx}===${len}-1,length:${len}};`);
        const frame = new Map([[node.varName, d], ['loop', d]]);
        frames.push(frame);
        const saved = { ...depth };
        depth[node.varName] = d;
        depth.loop = d;
        gen(node.body, frames, depth);
        frames.pop();
        for (const k of Object.keys(depth)) delete depth[k];
        Object.assign(depth, saved);
        code.push('}}}');
      }
    }
  };
  gen(nodes, [], {});
  code.push("return O.join('');");
  return new Function('S', 'D', 'H', code.join('\n'));
}

// ---------------------------------------------------------------- the build

const RESERVED = ['posts', 'tags', 'page'];
const byCodeUnits = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
const dirOf = (path) => (path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '');
const SCHEME_RE = /^[A-Za-z][A-Za-z0-9+.-]*:/;

/** `rel` (a link's path, "/"-separated) from the directory `dir` of a source, or null when it climbs out of the root. */
function resolvePath(dir, rel) {
  const parts = dir === '' ? [] : dir.split('/');
  for (const seg of rel.split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') {
      if (parts.length === 0) return null;
      parts.pop();
    } else parts.push(seg);
  }
  return parts.join('/');
}

/**
 * One site's output tree: path -> text. Reproduces makefun-site's build exactly: sources in path order, front
 * matter, permalinks, Markdown with links resolved, collections, tags, layouts, statics, and the build report.
 */
export function run(input) {
  // Slugs repeat heavily across a build (tag names, heading texts, titles); memoise them for this build only.
  const slugCache = new Map();
  const slug = (text) => {
    let s = slugCache.get(text);
    if (s === undefined) {
      s = slugifyRaw(text);
      slugCache.set(text, s);
    }
    return s;
  };

  // Templates, parsed in name order; a template that does not parse is reported and is no template at all.
  const report = [];
  const templates = new Map();
  const helpers = {
    E: escapeHtml,
    T: textOf,
    Y: truthy,
    K: lookup,
    W: walk,
    I: (name, scope, depth) => {
      const fn = templates.get(name);
      return fn === undefined ? '' : fn(scope, depth, helpers);
    },
  };
  for (const name of Object.keys(input.templates).sort(byCodeUnits)) {
    try {
      templates.set(name, compileNodes(lexTemplate(input.templates[name])));
    } catch (err) {
      report.push(`template "${name}": ${err.message}`);
    }
  }
  const render = (name, vars) => {
    const fn = templates.get(name);
    return fn === undefined ? null : fn({ v: vars, p: null }, 0, helpers);
  };

  const base = input.site.base_url.replace(/\/+$/, '');
  const files = [...input.files].sort((x, y) => byCodeUnits(x.path, y.path));
  const statics = [];
  const sources = [];
  for (const f of files) {
    if (f.path.endsWith('.md')) {
      sources.push({ path: f.path, text: f.content.includes('\r') ? f.content.replace(/\r\n?/g, '\n') : f.content });
    } else statics.push({ path: f.path, content: f.content });
  }

  // Front matter: a refused source is reported and dropped, and so is a draft.
  const kept = [];
  for (const s of sources) {
    const fm = parseFrontMatter(s.text);
    if ('error' in fm) {
      report.push(`refused ${s.path}: ${fm.error}`);
      continue;
    }
    s.data = fm.data;
    s.body = fm.body;
    s.post = s.path.startsWith('posts/');
    const own = s.path.startsWith('tags/') ? 'tags' : s.path.startsWith('page/') ? 'page' : undefined;
    if (own !== undefined) {
      report.push(`refused ${s.path}: ${own}/ is the generator's own`);
      continue;
    }
    if (s.post && !Object.hasOwn(s.data, 'date')) {
      report.push(`refused ${s.path}: a post needs a date`);
      continue;
    }
    const layout = s.data.layout ?? (s.post ? 'post' : 'page');
    if (!templates.has(layout)) {
      report.push(`refused ${s.path}: layout "${layout}" is no template that parses`);
      continue;
    }
    s.layout = layout;
    if (s.data.draft === true) {
      report.push(`draft ${s.path}`);
      continue;
    }
    kept.push(s);
  }

  // Permalinks: each page's slug made unique in its directory, in source order.
  const taken = new Map();
  const takenIn = (dir) => {
    let set = taken.get(dir);
    if (set === undefined) {
      set = new Set(dir === '' ? RESERVED : []);
      taken.set(dir, set);
    }
    return set;
  };
  const bySource = new Map();
  for (const s of kept) {
    const dir = s.post ? 'posts' : dirOf(s.path);
    const sl = uniqueSlug(s.data.slug ?? slug(s.data.title), takenIn(dir));
    s.slug = sl;
    s.outDir = dir === '' ? sl : `${dir}/${sl}`;
    s.url = `${base}/${s.outDir}/`;
    bySource.set(s.path, s);
  }

  // Markdown, its links resolved to the pages and static files they name. Resolutions repeat; cache them.
  const staticPaths = new Set(statics.map((f) => f.path));
  const broken = new Set();
  const linkCache = new Map();
  for (const s of kept) {
    const dir = dirOf(s.path);
    const env = {
      link: (target) => {
        const key = `${dir}\u0000${target}`;
        let hit = linkCache.get(key);
        if (hit === undefined) {
          let href = target;
          let isBroken = false;
          if (!SCHEME_RE.test(target) && !target.startsWith('/') && !target.startsWith('#')) {
            const hash = target.indexOf('#');
            const rel = hash === -1 ? target : target.slice(0, hash);
            const frag = hash === -1 ? '' : target.slice(hash);
            const path = rel === '' ? null : resolvePath(dir, rel);
            if (path !== null && bySource.has(path)) href = `${bySource.get(path).url}${frag}`;
            else if (path !== null && staticPaths.has(path)) href = `${base}/${path}${frag}`;
            else isBroken = true;
          }
          hit = { href, isBroken };
          linkCache.set(key, hit);
        }
        if (hit.isBroken) broken.add(`broken-link ${s.path} -> ${target}`);
        return hit.href;
      },
    };
    const md = renderMarkdown(s.body, env, slug);
    s.html = md.html;
    s.toc = md.toc;
    s.excerpt = md.excerpt;
  }

  // Collections: the posts, newest first and then by slug; each post's newer and older neighbours.
  const posts = kept.filter((s) => s.post);
  posts.sort((x, y) => byCodeUnits(y.data.date, x.data.date) || byCodeUnits(x.slug, y.slug));
  posts.forEach((p, k) => {
    p.newer = k === 0 ? null : posts[k - 1];
    p.older = k === posts.length - 1 ? null : posts[k + 1];
  });

  // Tags: grouped by slug, each named as first met in the posts' order, ordered by count and then slug.
  const bySlug = new Map();
  const ownTags = (s) => {
    const seen = new Set();
    const out = [];
    for (const name of s.data.tags ?? []) {
      const sl = slug(name);
      if (!seen.has(sl)) {
        seen.add(sl);
        out.push(name);
      }
    }
    return out;
  };
  for (const p of posts) {
    p.tagRefs = [];
    for (const name of ownTags(p)) {
      const sl = slug(name);
      let tag = bySlug.get(sl);
      if (tag === undefined) {
        tag = { name, slug: sl, url: `${base}/tags/${sl}/`, posts: [] };
        bySlug.set(sl, tag);
      }
      tag.posts.push(p);
      p.tagRefs.push(tag);
    }
  }
  for (const s of kept) {
    if (!s.post) {
      s.tagRefs = ownTags(s).map((name) => {
        const sl = slug(name);
        return bySlug.get(sl) ?? { name, slug: sl, url: '', posts: [] };
      });
    }
  }
  const tagList = [...bySlug.values()].sort((x, y) => y.posts.length - x.posts.length || byCodeUnits(x.slug, y.slug));

  const linkOf = (s) =>
    s === null ? null : { title: s.data.title, url: s.url, date: s.data.date ?? '', date_long: s.data.date === undefined ? '' : longDate(s.data.date) };
  const cardOf = (s) => ({
    title: s.data.title,
    url: s.url,
    date: s.data.date ?? '',
    date_long: s.data.date === undefined ? '' : longDate(s.data.date),
    summary: s.data.summary ?? '',
    excerpt: s.excerpt,
    reading_minutes: Math.max(1, Math.ceil(wordsOf(s.body) / 200)),
    tags: s.tagRefs.map((t) => ({ name: t.name, slug: t.slug, url: t.url })),
  });
  const cards = new Map(posts.map((p) => [p, cardOf(p)]));
  const pageOf = (s) => ({
    ...cardOf(s),
    slug: s.slug,
    content: s.html,
    toc: s.toc,
    newer: linkOf(s.newer ?? null),
    older: linkOf(s.older ?? null),
    is_post: s.post,
  });

  // Layouts: every page through its layout, the index pages and the tag pages through theirs.
  const output = {};
  const site = { title: input.site.title, base_url: base };
  const allTags = tagList.map((t) => ({ name: t.name, slug: t.slug, url: t.url, count: t.posts.length }));
  const recent = posts.slice(0, input.site.recent).map((p) => cards.get(p));
  const renderPage = (name, vars) => render(name, { site, tags: allTags, recent, ...vars });
  for (const s of kept) output[`${s.outDir}/index.html`] = renderPage(s.layout, { page: pageOf(s) });
  const per = input.site.per_page;
  const pageCount = Math.max(1, Math.ceil(posts.length / per));
  const indexUrl = (k) => (k === 1 ? `${base}/` : `${base}/page/${k}/`);
  for (let k = 1; k <= pageCount; k++) {
    const html = renderPage('index', {
      posts: posts.slice((k - 1) * per, k * per).map((p) => cards.get(p)),
      pager: { number: k, total: pageCount, url: indexUrl(k), newer_url: k === 1 ? '' : indexUrl(k - 1), older_url: k === pageCount ? '' : indexUrl(k + 1) },
    });
    if (html !== null) output[k === 1 ? 'index.html' : `page/${k}/index.html`] = html;
  }
  for (const t of tagList) {
    const html = renderPage('tag', { tag: { name: t.name, slug: t.slug, url: t.url, count: t.posts.length, posts: t.posts.map((p) => cards.get(p)) } });
    if (html !== null) output[`tags/${t.slug}/index.html`] = html;
  }
  const tagsHtml = renderPage('tags', {});
  if (tagsHtml !== null) output['tags/index.html'] = tagsHtml;
  for (const f of statics) {
    if (Object.hasOwn(output, f.path)) report.push(`shadowed ${f.path}: a built page has its path`);
    else output[f.path] = f.content;
  }

  // The report: every refusal, draft, broken link and template that did not parse, sorted, then the counts.
  const lines = [...report, ...broken].sort(byCodeUnits);
  const pageTotal = kept.reduce((n, s) => n + (s.post ? 0 : 1), 0);
  lines.push(`built ${pageTotal} pages, ${posts.length} posts, ${tagList.length} tags and ${statics.length} static files`);
  output['build-report.txt'] = `${lines.join('\n')}\n`;
  return output;
}
