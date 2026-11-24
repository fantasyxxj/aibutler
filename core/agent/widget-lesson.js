// widget-lesson.js — after a broken control, the next few owner turns carry one line about it.
//
// 作者 11-15: the retry fixes that one reply, but what makes the assistant stop is being told again —
// "跟他说的多了，就不容易犯错". So the host reports the mistake (core/widget-gate.js found it) and the
// next LESSON_TURNS turns that carry a person's words open with a short reminder of what went wrong
// and how to write it. A new mistake restarts the count with the new wording.
'use strict';
const { cfg } = require('../host');
const { HAS_EXTERNAL_TEXT } = require('./util');

const LESSON_TURNS = 3;

class WidgetLesson {
  /** The host saw broken controls in a reply → remind the next few owner turns. */
  noteWidgetMistake(problems, turns = LESSON_TURNS) {
    if (!problems) return;
    // a hint (turns=1) never shortens a real mistake's reminder that is still running
    if (this._widgetLesson && this._widgetLesson.left > turns) return;
    this._widgetLesson = { problems: String(problems), left: turns };
  }

  _takeWidgetLesson(sourceKind) {
    const l = this._widgetLesson;
    if (!l || !HAS_EXTERNAL_TEXT(sourceKind)) return '';
    if (--l.left <= 0) this._widgetLesson = null;
    try {
      console.log(`[widget-lesson] ${this.name} reminder (${l.left} left)`);
      return cfg.render('main/widget_lesson', { problems: l.problems }) + '\n\n';
    } catch (_) { return ''; }
  }
}

module.exports = WidgetLesson;
