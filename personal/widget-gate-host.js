// widget-gate-host.js — the personal screen's control check: core/widget-gate.js with the kinds
// personal/renderer/md.js:333 draws, wired into one session's stream.
//
// A broken control (garbled marker, a field without a button, a ```buttons block, hand-written HTML)
// never reaches the screen; at the turn's end the persona is asked once to send that part again.
// Its own file because main.js is far over the 500-line gate; main.js only calls the four hooks.
'use strict';
const widgetGate = require('../core/widget-gate');

// personal/renderer/md.js: /\{\{(cmd|in|sel|btn|ui|pin|mark|picks|pick):([^}\n]*)\}\}/
const OPTS = { kinds: ['cmd', 'in', 'sel', 'btn', 'ui', 'pin', 'mark', 'picks', 'pick'], spec: '[^}\\n]*' };

/**
 * @param butler  the session's agent (submit · _turnMetas)
 * @param render  (key, vars) → text, the config loader's render
 */
function attach(butler, render) {
  const gate = widgetGate.create(OPTS);
  return {
    // Turns that came in from Telegram / LINE / the hub answer out there: those channels are not ours
    // and may not draw controls at all — whatever they need is the user's call (作者 11-15). Pass through.
    text: (chunk) => (butler._turnSourceKind === 'inbox' ? chunk : gate.text(chunk)),
    blockDone: () => (butler._turnSourceKind === 'inbox' ? '' : gate.blockDone()),
    discardBlock: () => gate.discardBlock(),
    /** plugin_open ran: the panel is this turn's reply — buttons beside it come off, none are asked for (作者 11-20). */
    panelOpened: () => gate.panelOpened(),
    /** Turn result → the text to keep in history (broken parts taken out); asks once for a rewrite. */
    settle(finalText, { interrupted, screen } = {}) {
      const bad = gate.bad(), problems = gate.problems(), hints = gate.hints(), redo = gate.needsRedo(), panel = gate.opened();
      gate.reset();
      if (butler._turnSourceKind === 'inbox') return finalText;
      const retried = (butler._turnMetas || []).some((m) => m && m.widgetRetry);
      const ask = (prompt, tag) => {
        if (retried || interrupted) return;
        console.log(`[widget-gate] ${butler.name}: ${tag}`);
        butler.submit(prompt, undefined, { sourceKind: 'auto', turnMeta: { widgetRetry: true } })
          .catch((e) => console.error('[widget-gate] rewrite request failed:', e && e.message));
      };
      if (bad) {
        butler.noteWidgetMistake(problems);   // the next few turns are reminded (core/agent/widget-lesson.js)
        if (redo) ask(render('main/widget_retry', { form: bad.trim(), problems, shown: widgetGate.shownBefore(finalText, bad) }), `held back → rewrite request: ${problems.replace(/\n/g, ' ')}`);
        return String(finalText || '').replace(bad, '').trim();
      }
      if (hints) butler.noteWidgetMistake(hints, 1);   // markers inside code: a hint, not a rewrite
      // A reply with nothing to tap: only on turns typed on this screen (buttons do not exist on
      // Telegram / LINE, and reminders or wake-ups are not answers to anyone). Same rule as the shop (作者 11-15 17:30).
      const q = screen && !panel ? widgetGate.finalProblems(finalText) : [];
      if (q.length) {
        butler.noteWidgetMistake(widgetGate.describe(q));
        ask(render('main/widget_buttons_retry', { question: q[0].sample }), `${q[0].code} → asking for buttons: ${q[0].sample}`);
      }
      return finalText;
    },
  };
}

module.exports = { attach, OPTS };
