// widget-gate.js — a reply's controls are checked before they reach the screen; a broken one is held
// back and the assistant is asked once to send that part again, written right.
//
// Why code and not the prompt: both editions teach the control syntax and both still get it wrong.
// 作者 11-15 named the four that keep coming back — controls wrapped in code, wrong params, buttons
// in more than one group, choices offered with no button — plus the older ones: a field without a
// button (industry 10-29), ```buttons / JSON "widget" blocks drawn as dead code (personal 11-08/09, 11-22).
// A wrong control format is something the program can see: catch it and send it back.
//
// Per text block (a block ends at each tool call and at the end of the turn):
//   - text streams as usual until something that may start a control appears (`{`, `<`, a backtick);
//     from there the rest of the block is held (an inline code span without a brace is let go at once)
//   - block ends → check the held part; clean → show it; broken → keep it off the screen
//   - at the turn's end the host asks once for the held part again (main/widget_retry)
// Choices asked in plain words with no button at all are only visible once the reply is complete:
// finalProblems() looks at the whole answer and the host asks for the buttons (main/widget_buttons_retry).
'use strict';

const FIELD = /\{\{(?:in|sel|pick|picks):/;
const BUTTON = /\{\{(?:btn|cmd):/;
const ANY_MARK = /\{\{(?:in|sel|pick|picks|btn|cmd|ui|pin|mark):/;
// Fenced blocks dressed up as controls: drawn as code, nothing in them is clickable.
const FAKE_FENCE = /^```[ \t]*(widgets?|buttons?|form|controls?|choices?|options?)\b/im;
// JSON objects describing controls, fenced or bare (personal 11-22: {"type":"buttons","options":[…]} in ```json).
const JSON_CONTROL = /\{\s*"(?:type|kind|widget)"\s*:\s*"(?:widgets?|buttons?|form|controls?|choices?|options?|select|input)"/i;
// Hand-written HTML controls are escaped by the renderer into one line of source.
const RAW_HTML = /<(input|button|select|textarea|form)\b/i;
// The same tags in a ```html / ```xml / bare fence: the renderer draws such a fence only when it is an
// <svg>, so a form in it shows as code (personal 11-23, three times in a day). Held back when the block
// has no real button beside it — that is the ask itself; next to real buttons it is probably code being shown.
const HTML_FENCE = /^```[ \t]*(?:html?|xml|svg)?[ \t]*\n([\s\S]*?)^```[ \t]*$/gim;
const fenceControls = (s) => {
  for (const m of String(s).matchAll(HTML_FENCE)) {
    if (!/^\s*<svg\b/i.test(m[1]) && RAW_HTML.test(m[1])) return m[1].match(RAW_HTML)[0];
  }
  return '';
};
const IN_TYPES = new Set(['text', 'number', 'tel', 'date', 'time', 'email', 'password', 'range', 'area']);
const FENCE = /^```[^\n]*\n[\s\S]*?^```[ \t]*$/gm;
const INLINE = /`[^`\n]*`/g;

const stripCode = (s) => String(s).replace(FENCE, '').replace(INLINE, '');
const codeParts = (s) => (String(s).match(FENCE) || []).concat(String(s).match(INLINE) || []);

function parseMarker(kind, spec) {
  const parts = String(spec).split('|').map((x) => x.trim());
  const head = parts.shift() || '';
  const kv = {}, plain = [];
  for (const p of parts) {
    const eq = p.indexOf('=');
    if (eq > 0 && /^[\w.-]+$/.test(p.slice(0, eq).trim())) kv[p.slice(0, eq).trim()] = p.slice(eq + 1).trim();
    else if (p) plain.push(p);
  }
  return { kind, head, kv, plain };
}

function paramProblem(m, opts) {
  const all = [m.head, ...m.plain, ...Object.values(m.kv)].join(' ');
  if (/[{}[\]]/.test(all)) return 'brackets or JSON inside a marker';
  if (['in', 'sel', 'pick', 'picks', 'btn'].includes(m.kind) && !m.head) return 'empty name';
  if (m.kind === 'in' && m.kv.type && !IN_TYPES.has(m.kv.type)) return `unknown input type "${m.kv.type}"`;
  if (['sel', 'pick', 'picks'].includes(m.kind) && !m.plain.length && !m.kv.src) return 'a choice with no options';
  if (m.kind === 'cmd' && typeof opts.commands === 'function') {
    const known = opts.commands();
    if (known && known.length && !known.includes(m.head)) return `unknown command "${m.head}"`;
  }
  // wf_go / wf_finish name a procedure; a made-up one passes the name check and fails only when pressed (11-20 dev: wf=store_setup)
  if (m.kind === 'cmd' && /^wf_(go|finish)$/.test(m.head) && typeof opts.workflows === 'function') {
    const wfs = opts.workflows();
    if (wfs && !wfs.includes(m.kv.wf)) return `unknown procedure "${m.kv.wf || ''}"`;
  }
  return '';
}

/**
 * Problems in a piece of reply text, [] when it is fine.
 * @param opts.kinds     marker kinds this edition draws
 * @param opts.spec      what may stand between `kind:` and `}}` (default: no newline; personal also no `}`)
 * @param opts.commands  optional () → command names a {{cmd:}} may run
 * @param opts.workflows optional () → procedure ids a {{cmd:wf_go|wf=…}} may name
 */
function check(text, opts = {}) {
  const out = [];
  const raw = String(text || '');
  const fake = FAKE_FENCE.exec(raw);
  if (fake) out.push({ code: 'fake_fence', sample: fake[0].trim() });
  const json = !fake && JSON_CONTROL.exec(raw);
  if (json) out.push({ code: 'json_control', sample: json[0] });
  const inCode = codeParts(raw).find((c) => ANY_MARK.test(c));
  if (inCode) out.push({ code: 'in_code', sample: inCode.slice(0, 60) });
  const s = stripCode(raw);
  if (RAW_HTML.test(s)) out.push({ code: 'raw_html', sample: (s.match(RAW_HTML) || [''])[0] });
  const fenced = fenceControls(raw);
  if (fenced) out.push({ code: BUTTON.test(s) ? 'html_fence_hint' : 'html_fence', sample: fenced });

  const good = new RegExp(`\\{\\{(${(opts.kinds || []).join('|')}):(${opts.spec || '[^\\n]*?'})\\}\\}`, 'g');
  const marks = [];
  let m;
  while ((m = good.exec(s))) marks.push({ at: m.index, end: m.index + m[0].length, text: m[0], ...parseMarker(m[1], m[2]) });
  const leftover = s.replace(good, '').match(/\{\{[^\n]{0,60}/);
  if (leftover) out.push({ code: 'malformed', sample: leftover[0] });
  for (const k of marks) {
    const why = paramProblem(k, opts);
    if (why) { out.push({ code: /^unknown command/.test(why) ? 'unknown_command' : /^unknown procedure/.test(why) ? 'unknown_workflow' : 'bad_params', sample: `${k.text}  (${why})` }); break; }
  }

  // Buttons belong together at the end: words between two buttons mean a second group.
  const btns = marks.filter((k) => k.kind === 'btn' || k.kind === 'cmd');
  for (let i = 1; i < btns.length; i++) {
    const between = s.slice(btns[i - 1].end, btns[i].at).replace(new RegExp(good.source, 'g'), '');
    if (between.replace(/[\s·|/、,，;；:：.。>\-–—*_]+/g, '')) {
      out.push({ code: 'button_groups', sample: `${btns[i - 1].text} … ${btns[i].text}` });
      break;
    }
  }
  if (marks.some((k) => FIELD.test(k.text)) && !btns.length) out.push({ code: 'no_button', sample: (s.match(FIELD) || [''])[0] });
  // A field next to a button that already names one of its values: change the field and the button
  // still says the old one — is it asking or not? (作者 11-16: {{in:time|value=21:00}} + 「用 21:00 最后一单」)
  const values = marks.filter((k) => FIELD.test(k.text))
    .flatMap((k) => [k.kv.value, k.kv.placeholder, ...(k.kind === 'in' ? [] : k.plain.join(',').split(/[,，](?![^(（]*[)）])/))])
    .map((v) => String(v || '').trim()).filter((v) => v.length >= 2);
  const fixed = btns.find((b) => values.some((v) => (b.kind === 'cmd' ? b.kv.label || '' : b.head).includes(v)));
  if (fixed) out.push({ code: 'button_fixes_value', sample: fixed.text });
  return out;
}

/**
 * The whole reply offers nothing to tap. 作者 11-15: almost every reply should end with controls —
 * so on a turn the person started, a reply without a single button or field asks for its next-step
 * buttons; the sample is the question in its last lines when there is one (the choices it lists sit
 * below it), else its last line.
 */
function finalProblems(text) {
  const s = stripCode(String(text || '')).trim();
  if (!s || BUTTON.test(s) || FIELD.test(s) || /\{\{(?:ui|pin):/.test(s)) return [];
  const tail = s.split('\n').map((l) => l.trim()).filter(Boolean).slice(-6);
  const q = tail.filter((l) => /[?？]/.test(l)).pop();
  return [{ code: q ? 'no_buttons_for_question' : 'no_buttons', sample: (q || tail[tail.length - 1] || '').slice(-80) }];
}

// What the assistant is told about each problem — English, the retry note is not shown to the person.
const HOW = {
  fake_fence: 'a code block used as controls — write controls as {{…}} markers in the text, never inside ```',
  in_code: 'a control marker inside code formatting (backticks or a fence) shows as plain text — if you meant it to be tapped, write it bare; if you were showing how it is written, that is fine',
  json_control: 'controls written as JSON — they show as source text; write one {{btn:…}} per button, bare in the text',
  raw_html: 'HTML form tags — they show as source text; use {{…}} markers',
  html_fence: 'a form or button inside a ```html block — a fence is drawn only when it holds an <svg>, so this shows as code; write one {{btn:…}} per button, bare in the text',
  html_fence_hint: 'a form or button inside a ```html block shows as code — if you meant it to be tapped, write {{btn:…}} bare; if you were showing HTML code, that is fine',
  malformed: 'a {{…}} marker the screen cannot draw — use only the kinds and the shape the Controls section gives',
  bad_params: 'a marker with wrong parameters — `name|A,B,C|key=value`, plain values, no JSON or brackets',
  unknown_command: 'a {{cmd:}} naming a command that does not exist — to open a panel call the plugin_open tool (it draws the panel itself, no button needed); {{cmd:}} only takes the `write:` line of a plugin_find entry',
  unknown_workflow: 'a {{cmd:wf_go}} naming a procedure that does not exist — wf_go only pages through a procedure whose button plugin_open already placed; a one-page panel (e.g. store-setup) opens with the plugin_open tool and the id plugin_find gives',
  button_groups: 'buttons in more than one group — put all buttons together once, at the end of the reply',
  button_fixes_value: 'a button that names a value the field beside it lets them change — to ask for a value keep the field and name the action on the button ("OK", "Save"); to offer a few values drop the field and give one button per value',
  no_button: 'a field with no button — fields never send by themselves; end with one button that sends them',
  no_buttons_for_question: 'a question with nothing to tap — every choice or answer gets buttons',
  buttons_in_panel_turn: 'buttons in a turn that opened a panel — the panel is the reply; they act in it and press its own Save, so write no buttons and no question beside it',
  no_buttons: 'a reply with nothing to tap — end every reply with buttons for the likely next steps',
};
// buttons and commands other than plugin_open (an open-panel button is the panel's own entry)
const TAP = /\{\{(?:btn:[^\n]*?|cmd:(?!plugin_open\b)[^\n]*?)\}\}/;
const TAP_ALL = new RegExp(TAP.source, 'g');
// Only a hint, never held back: the assistant may be talking about how controls are written (作者 11-15).
const SOFT = new Set(['in_code', 'html_fence_hint']);
const describe = (problems) => problems.map((p) => `- ${HOW[p.code] || p.code}: \`${p.sample}\``).join('\n');

function create(opts = {}) {
  let held = '';        // this block's text from the first possible control on
  let holding = false;
  let bad = '';         // broken parts kept off the screen this turn
  let problems = [];
  let soft = [];        // hints only (SOFT): shown as written, the next turn gets one line about it
  let redo = false;     // something held back still has to reach them (see needsRedo)
  let panel = false;    // plugin_open ran this turn: the panel is the reply, so no buttons (作者 11-20)
  const START = /[{<`]/;

  // An inline code span that closed without a brace or tag in it is plain text: let it go now,
  // so a long answer full of `names` keeps streaming instead of waiting for the block to end.
  function release() {
    let out = '';
    while (holding && held[0] === '`' && !held.startsWith('``')) {
      const close = held.indexOf('`', 1);
      if (close < 0) break;
      const span = held.slice(0, close + 1);
      if (/[{<]/.test(span)) break;
      out += span; held = held.slice(close + 1);
      const i = held.search(START);
      if (i < 0) { out += held; held = ''; holding = false; }
      else { out += held.slice(0, i); held = held.slice(i); }
    }
    return out;
  }

  return {
    /** A text chunk on its way to the screen → what may go on now. */
    text(chunk) {
      if (holding) { held += chunk; return release(); }
      const c = String(chunk);
      const i = c.search(START);
      if (i < 0) return c;
      holding = true; held = c.slice(i);
      return c.slice(0, i) + release();
    },
    /** The block ended → the held part if it may be shown, '' if it is broken. */
    blockDone() {
      let out = held; held = ''; holding = false;
      // the panel is what they act on next; a button beside it competes with its own Save (11-20 dev: 「已经填好了」)
      if (panel && TAP.test(out)) {
        soft.push({ code: 'buttons_in_panel_turn', sample: (out.match(TAP) || [''])[0] });
        out = out.replace(TAP_ALL, '').replace(/[ \t]+\n/g, '\n');
        if (!out.trim()) return '';
      }
      const p = check(out, opts), hard = p.filter((x) => !SOFT.has(x.code));
      soft = soft.concat(p.filter((x) => SOFT.has(x.code)));
      if (hard.length) {
        bad += out; problems = problems.concat(hard);
        // a block that was nothing but a call to a command that does not exist (11-15 dev: the panel was
        // already opened by plugin_open, then {{cmd:plugin_open}} written beside it) — dropping it loses nothing
        const onlyDeadCmd = hard.every((x) => x.code === 'unknown_command') && !out.replace(/\{\{cmd:[^\n]*?\}\}/g, '').trim();
        if (!onlyDeadCmd) redo = true;
        return '';
      }
      return out;
    },
    /** Broken parts kept off the screen this turn ('' if none) and what was wrong with them. */
    bad() { return bad; },
    problems() { return describe(problems); },
    /** Whether the held-back part has to be sent again (false: it was only a dead command — just drop it). */
    needsRedo() { return redo; },
    /** Hints from this turn ('' if none) — for a one-turn reminder, nothing is held. */
    hints() { return describe(soft); },
    /** The engine resends this step (cut stream): forget the block it was streaming. */
    discardBlock() { held = ''; holding = false; },
    /** Next turn. */
    reset() { held = ''; holding = false; bad = ''; problems = []; soft = []; redo = false; panel = false; },
    /** plugin_open ran in this turn: from here on buttons are taken off, and the turn is not asked for any. */
    panelOpened() { panel = true; },
    opened() { return panel; },
  };
}

/** The line already on their screen right above a held part — named in the rewrite request, because
 *  "the sentences before it are on screen" alone got the question written twice (11-16 dev). */
function shownBefore(finalText, held) {
  const t = String(finalText || ''), h = String(held || '').trim();
  const at = h ? t.indexOf(h) : -1;
  const line = (at > 0 ? t.slice(0, at) : '').split('\n').map((l) => l.trim()).filter(Boolean).pop() || '';
  return line ? `"${line.slice(-120)}"` : 'the sentences before it';
}

module.exports = { create, check, finalProblems, describe, shownBefore, SOFT, FIELD, BUTTON };
