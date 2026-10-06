"""A finished audiobook as a web page: ``index.html`` + its audio in a ZIP.

The page is ONE self-contained file — inline CSS and script, no web fonts, no
network request of any kind (local-first) — that plays ``audio/<book>.<ext>``
beside it and reads like an e-book: a title block, a contents sidebar (a
drawer on phones), chapters set in paragraphs, the phrase being read
highlighted and its word underlined, from the book's rendered timeline
(:func:`services.audiobook.book_timeline`). A book rendered without one gets
a timeline estimated from the script, chapter by chapter. Reading settings
(text size, theme, alignment, following the voice) stay in the browser.

Pure apart from :func:`write_export_zip`'s file I/O: no torch, no FastAPI.
"""
from __future__ import annotations

import html
import json
import os
import zipfile
from typing import Optional

#: The page's own words, in the app's language. The app sends them; these
#: English defaults fill any it leaves out.
DEFAULT_LABELS = {
    "play": "Play",
    "pause": "Pause",
    "back": "Back 10 seconds",
    "forward": "Forward 10 seconds",
    "seek": "Position",
    "speed": "Speed",
    "contents": "Contents",
    "narrated_by": "Narrated by",
    "player": "Player",
    "estimated": "Timing is estimated: the highlight may run ahead of or behind the voice.",
    "keys": "Space plays or pauses, the arrow keys go back or forward.",
    "keys_chapter": "Shift with an arrow key goes to the previous or next chapter.",
    # A chapter the script gave no title, ``{n}`` its number.
    "chapter_n": "Chapter {n}",
    # The text before the book's first chapter heading.
    "intro": "Opening",
    "prev_chapter": "Previous chapter",
    "next_chapter": "Next chapter",
    "settings": "Reading settings",
    "text_size": "Text size",
    "smaller": "Smaller text",
    "larger": "Larger text",
    "theme": "Theme",
    "theme_auto": "Auto",
    "theme_light": "Light",
    "theme_sepia": "Sepia",
    "theme_dark": "Dark",
    "align": "Alignment",
    "justify": "Justify",
    "align_start": "Align left",
    "follow": "Follow the voice",
    "back_to_current": "Back to current",
    "shortcuts": "Keyboard shortcuts",
    "close": "Close",
}
#: The longest label kept (a sentence, not a payload).
_LABEL_MAX = 300
SPEEDS = (0.75, 1, 1.25, 1.5, 1.75, 2)
_BREAKS = ("line", "paragraph")


def labels_for(given: Optional[dict]) -> dict:
    """The page's labels: ``given`` where it names a known label with text."""
    labels = dict(DEFAULT_LABELS)
    for key, value in (given or {}).items():
        if key in labels and isinstance(value, str) and value.strip():
            labels[key] = value.strip()[:_LABEL_MAX]
    return labels


def _script_json(value) -> str:
    """JSON safe inside ``<script type="application/json">``: no ``<``, ``>``
    or ``&`` (so no ``</script>`` or comment can close it early) and no line
    separators."""
    text = json.dumps(value, ensure_ascii=False, separators=(",", ":"))
    for char, escape in (("<", "\\u003c"), (">", "\\u003e"), ("&", "\\u0026"),
                         (" ", "\\u2028"), (" ", "\\u2029")):
        text = text.replace(char, escape)
    return text


def estimated_timeline(output: str, script: str, *,
                       chapter_durations: Optional[list] = None,
                       duration: Optional[float] = None) -> Optional[dict]:
    """A timeline for a book rendered without one, from the script it was
    rendered from: each chapter's text spread evenly over the chapter
    (:func:`services.audiobook.book_timeline` with nothing measured).

    ``chapter_durations`` gives each parsed chapter's length in seconds
    (``None`` for one that failed, so is not in the file); when it does not
    line up with the script, ``duration`` (the whole file) is shared by the
    chapters by their length in characters. ``None`` with neither."""
    from services.audiobook import book_timeline, parse_audiobook_script

    chapters = parse_audiobook_script(script).chapters
    if not chapters:
        return None
    if chapter_durations is not None and len(chapter_durations) == len(chapters):
        timed = [(c, max(0.0, float(d)), None)
                 for c, d in zip(chapters, chapter_durations) if d is not None]
    elif duration and duration > 0:
        sizes = [max(1, c.char_count) for c in chapters]
        timed = [(c, duration * size / sum(sizes), None) for c, size in zip(chapters, sizes)]
    else:
        return None
    return book_timeline(output, timed)


def chapter_title(chapter: dict, number: int, labels: dict) -> str:
    """A timeline chapter's title on the page: as written, or for a chapter
    the script left untitled, ``labels["chapter_n"]`` with its ``number``."""
    if chapter.get("untitled"):
        return labels["chapter_n"].replace("{n}", str(number))
    return str(chapter.get("title") or "")


def page_timeline(timeline: Optional[dict], labels: Optional[dict] = None,
                  book_title: str = "") -> dict:
    """What the page reads from a book timeline: chapters with their phrases
    (and where each starts a new line or paragraph) and sections, nothing
    else (cache keys stay home).

    The text before a book's first heading is its opening (``intro``): the
    page shows it without a heading, never as a made-up "Chapter 1", and the
    chapters after it are numbered from 1. A book with no heading at all has
    no opening: its one chapter is the book, without a heading either, and
    the player names it by ``book_title``. Such chapters are ``headless``; a
    title in the app's words (a label, not the book's text) is ``app_title``."""
    labels = labels_for(labels)
    found = [c for c in (timeline or {}).get("chapters") or [] if isinstance(c, dict)]
    opening = len(found) > 1 and bool(found[0].get("untitled")) and not any(
        c.get("untitled") for c in found[1:])
    lone = len(found) == 1 and bool(found[0].get("untitled"))
    chapters = []
    number = 0
    for index, chapter in enumerate(found):
        intro = opening and index == 0
        if not intro and not lone:
            number += 1
        if intro:
            title = labels["intro"]
        elif lone:
            title = book_title or chapter_title(chapter, 1, labels)
        else:
            title = chapter_title(chapter, number, labels)
        doc = {
            "title": title,
            "number": None if intro or lone else number,
            "start": chapter.get("start", 0),
            "end": chapter.get("end", 0),
            "precision": chapter.get("precision", "chapter"),
            "phrases": [_page_phrase(p) for p in chapter.get("phrases") or []
                        if isinstance(p, dict)],
            "sections": [{"title": str(s.get("title") or ""), "level": s.get("level", 2),
                          "start": s.get("start", 0), "phrase": s.get("phrase", 0)}
                         for s in chapter.get("sections") or [] if isinstance(s, dict)],
        }
        if chapter.get("untitled"):
            doc["untitled"] = True
        if intro:
            doc["intro"] = True
        if intro or lone:
            doc["headless"] = True
        if intro or (chapter.get("untitled") and not (lone and book_title)):
            doc["app_title"] = True
        chapters.append(doc)
    return {"chapters": chapters}


def _page_phrase(phrase: dict) -> dict:
    doc = {"text": str(phrase.get("text") or ""), "start": phrase.get("start", 0),
           "end": phrase.get("end", 0)}
    if phrase.get("break") in _BREAKS:
        doc["break"] = phrase["break"]
    return doc


_CSS = """
:root{--bg:#fbfaf7;--fg:#211f1b;--muted:#6d675e;--line:#e7e2d9;--card:#ffffff;
--accent:#2d58cf;--word:#1d43ad;--phrase:rgba(45,88,207,.10);--shadow:rgba(30,25,15,.12);
--scale:1;--bar-h:3.25rem;--player-h:7rem;color-scheme:light}
@media (prefers-color-scheme:dark){:root:not([data-theme]){--bg:#151517;--fg:#e8e6e1;
--muted:#9c978e;--line:#2c2b30;--card:#1d1d22;--accent:#91a9ff;--word:#b8c8ff;
--phrase:rgba(145,169,255,.16);--shadow:rgba(0,0,0,.45);color-scheme:dark}}
:root[data-theme=dark]{--bg:#151517;--fg:#e8e6e1;--muted:#9c978e;--line:#2c2b30;--card:#1d1d22;
--accent:#91a9ff;--word:#b8c8ff;--phrase:rgba(145,169,255,.16);--shadow:rgba(0,0,0,.45);color-scheme:dark}
:root[data-theme=sepia]{--bg:#f4ecd8;--fg:#3a2f23;--muted:#7b6b56;--line:#e0d3b6;--card:#faf3e2;
--accent:#9a5a12;--word:#7a4207;--phrase:rgba(154,90,18,.13);--shadow:rgba(80,55,20,.15);color-scheme:light}
*{box-sizing:border-box}
html{-webkit-text-size-adjust:100%;scroll-padding-top:calc(var(--bar-h) + 1rem)}
body{margin:0;background:var(--bg);color:var(--fg);
font:16px/1.5 system-ui,-apple-system,"Segoe UI",Roboto,"Noto Sans",sans-serif;
padding-bottom:calc(var(--player-h) + 2rem)}
button{font:inherit;color:inherit}
:focus-visible{outline:2px solid var(--accent);outline-offset:2px}
[hidden]{display:none!important}
.icon{display:inline-grid;place-items:center;min-width:2.5rem;height:2.5rem;padding:0 .5rem;border-radius:.6rem;
border:1px solid transparent;background:transparent;cursor:pointer;line-height:1}
.icon:hover{background:var(--phrase)}
.icon svg{width:1.25rem;height:1.25rem;fill:currentColor}
.icon:disabled{opacity:.4;cursor:default;background:transparent}
.bar{position:sticky;top:0;z-index:20;height:var(--bar-h);display:flex;align-items:center;gap:.5rem;
padding:0 .75rem;background:color-mix(in srgb,var(--bg) 92%,transparent);border-bottom:1px solid var(--line);
-webkit-backdrop-filter:blur(8px);backdrop-filter:blur(8px)}
.bar-title{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-weight:600;
font-size:.95rem;opacity:0;transition:opacity .2s}
.bar.titled .bar-title{opacity:1}
.aa{font-family:Georgia,"Times New Roman",serif;font-size:1.05rem;font-weight:600}
.menu{position:absolute;z-index:30;background:var(--card);color:var(--fg);border:1px solid var(--line);
border-radius:.9rem;box-shadow:0 12px 32px var(--shadow);padding:.9rem;font-size:.9rem}
#settings{top:calc(var(--bar-h) - .25rem);inset-inline-end:.75rem;width:min(20rem,calc(100vw - 1.5rem))}
.menu fieldset{border:0;margin:0 0 .85rem;padding:0;min-width:0}
.menu legend,.menu .caption{display:block;padding:0;margin:0 0 .4rem;color:var(--muted);font-size:.78rem;
font-weight:600;letter-spacing:.04em;text-transform:uppercase}
.seg{display:flex;gap:.25rem;padding:.2rem;border-radius:.65rem;background:var(--bg);border:1px solid var(--line)}
.seg button{flex:1;min-height:2.1rem;border:0;border-radius:.5rem;background:transparent;cursor:pointer;padding:0 .4rem}
.seg button[aria-pressed=true]{background:var(--card);color:var(--accent);font-weight:600;box-shadow:0 1px 3px var(--shadow)}
.seg button:disabled{opacity:.4;cursor:default}
.seg output{display:grid;place-items:center;min-width:3.5rem;font-variant-numeric:tabular-nums}
.switch{display:flex;align-items:center;justify-content:space-between;gap:1rem;cursor:pointer}
.switch input{width:1.1rem;height:1.1rem;accent-color:var(--accent)}
.shell{display:grid;grid-template-columns:17rem minmax(0,1fr);gap:3rem;max-width:76rem;margin:0 auto;padding:0 1.5rem}
.no-toc .shell{grid-template-columns:minmax(0,1fr)}
.no-toc .toc,.no-toc #toc-toggle{display:none}
.toc{position:sticky;top:var(--bar-h);align-self:start;max-height:calc(100vh - var(--bar-h) - var(--player-h));
overflow-x:hidden;overflow-y:auto;padding:1.5rem .25rem 1rem 0;font-size:.9rem;overscroll-behavior:contain}
.toc-head{display:flex;align-items:center;justify-content:space-between;margin:0 0 .5rem}
.toc h2{margin:0;font-size:.78rem;font-weight:600;letter-spacing:.06em;text-transform:uppercase;color:var(--muted)}
#toc,#toc ol{list-style:none;margin:0;padding:0}
#toc ol{margin:.1rem 0 .3rem;padding-inline-start:2.1rem}
#toc button{display:flex;gap:.6rem;align-items:baseline;width:100%;text-align:start;padding:.35rem .5rem;border:0;
border-radius:.5rem;background:transparent;cursor:pointer;line-height:1.35;overflow-wrap:anywhere;
border-inline-start:2px solid transparent}
#toc button:hover{background:var(--phrase)}
#toc .num{flex:none;min-width:1.2rem;color:var(--muted);font-variant-numeric:tabular-nums;font-size:.85em}
#toc .t{min-width:0}
#toc button[aria-current=true]{color:var(--accent);font-weight:600;border-inline-start-color:var(--accent);
background:var(--phrase)}
#toc button[aria-current=true] .num{color:var(--accent)}
#toc .s3{padding-inline-start:1.25rem}
#toc ol button{color:var(--muted);font-size:.95em;padding-block:.25rem}
.scrim{position:fixed;inset:0;z-index:39;background:rgba(0,0,0,.35)}
main{min-width:0;max-width:66ch;width:100%;margin:0 auto;padding:2.5rem 0 0;
font-family:"Noto Serif","Source Serif 4","Source Serif Pro",Cambria,Georgia,"Times New Roman",serif;
font-size:calc(1.1875rem * var(--scale));line-height:1.75;font-kerning:normal}
/* Georgia lacks the Vietnamese letters: they would come apart into marks. */
main:lang(vi){font-family:"Noto Serif","Source Serif 4","Source Serif Pro",Cambria,"Times New Roman",serif}
.cover{display:flex;gap:1.5rem;align-items:center;margin:0 0 3rem;padding-bottom:2.5rem;border-bottom:1px solid var(--line)}
.cover img{width:9rem;max-width:35%;height:auto;border-radius:.4rem;box-shadow:0 8px 28px var(--shadow);flex:none}
.cover h1{margin:0;font-size:2.1em;line-height:1.15;font-weight:600;text-wrap:balance;overflow-wrap:break-word}
.cover p{margin:.6rem 0 0;text-indent:0;color:var(--muted);font-family:system-ui,-apple-system,"Segoe UI",Roboto,"Noto Sans",sans-serif;
font-size:.95rem;line-height:1.4}
.cover .author{font-size:1.05rem;color:var(--fg)}
.note{margin:0 0 2rem;padding:.6rem .9rem;border-radius:.6rem;background:var(--phrase);color:var(--muted);
font:.85rem/1.45 system-ui,-apple-system,"Segoe UI",Roboto,"Noto Sans",sans-serif}
main section{padding-top:1rem;margin-bottom:4rem}
.opener{margin:0 0 2rem;text-align:start}
.opener .label{margin:0 0 .5rem;color:var(--accent);font:600 .78rem/1.2 system-ui,-apple-system,"Segoe UI",Roboto,"Noto Sans",sans-serif;
letter-spacing:.14em;text-transform:uppercase}
.opener h2{margin:0;font-size:1.75em;line-height:1.25;font-weight:600;text-wrap:balance;overflow-wrap:break-word}
main h3,main h4{text-align:start;line-height:1.35;font-weight:600;margin:2.2em 0 .8em;break-after:avoid}
main h3{font-size:1.25em}
main h4{font-size:1.08em;color:var(--muted)}
main p{margin:0;text-align:justify;text-justify:inter-word;text-align-last:start;
-webkit-hyphens:manual;hyphens:manual;overflow-wrap:break-word}
:root[data-align=start] main p{text-align:start}
main p+p{text-indent:1.5em}
main p.lead::first-letter{font-size:1.6em;line-height:1;font-weight:600;color:var(--accent)}
.ph{border-radius:.2em;-webkit-box-decoration-break:clone;box-decoration-break:clone;transition:background-color .2s}
.ph.on{background:var(--phrase)}
.w{cursor:pointer}
.w:hover{text-decoration:underline dotted;text-underline-offset:.22em}
.w.on{color:var(--word);text-decoration:underline;text-decoration-color:var(--accent);
text-decoration-thickness:.09em;text-underline-offset:.22em}
.pill{position:fixed;z-index:25;left:50%;bottom:calc(var(--player-h) + .9rem);transform:translateX(-50%);
padding:.55rem 1rem;border:0;border-radius:999px;background:var(--accent);color:var(--card);font-size:.9rem;
font-weight:600;box-shadow:0 6px 20px var(--shadow);cursor:pointer}
.player{position:fixed;left:0;right:0;bottom:0;z-index:20;background:var(--card);border-top:1px solid var(--line);
box-shadow:0 -6px 24px var(--shadow);padding:.5rem 1rem calc(.6rem + env(safe-area-inset-bottom))}
.seek-row,.controls{display:flex;align-items:center;gap:.75rem;max-width:76rem;margin:0 auto}
.seek{position:relative;flex:1;min-width:6rem;height:1.75rem;display:flex;align-items:center}
#seek{position:relative;z-index:1;width:100%;margin:0;accent-color:var(--accent);background:transparent}
#ticks{position:absolute;inset-inline:.5rem;top:50%;height:.8rem;transform:translateY(-50%);pointer-events:none}
#ticks span{position:absolute;top:0;width:2px;height:100%;margin-inline-start:-1px;border-radius:1px;background:var(--muted);opacity:.55}
#time{font-variant-numeric:tabular-nums;color:var(--muted);font-size:.85rem;white-space:nowrap}
.now{flex:1 1 0;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:.9rem;font-weight:600}
.buttons{display:flex;align-items:center;gap:.15rem}
#play{width:3rem;height:3rem;border-radius:50%;background:var(--accent);color:var(--card);margin:0 .25rem}
#play:hover{background:var(--accent);filter:brightness(1.08)}
.extras{flex:1 1 0;display:flex;justify-content:flex-end;align-items:center;gap:.5rem;position:relative}
.extras label{font-size:.85rem;color:var(--muted);display:flex;gap:.4rem;align-items:center}
.extras select{font:inherit;color:var(--fg);background:var(--bg);border:1px solid var(--line);border-radius:.45rem;padding:.2rem .35rem}
#keys{bottom:calc(100% + .5rem);inset-inline-end:0;width:min(18rem,calc(100vw - 2rem))}
#keys p{margin:0 0 .5rem;line-height:1.45}
#keys p:last-child{margin:0}
@media (max-width:60rem){
.shell{grid-template-columns:minmax(0,1fr);padding:0 1.1rem}
.toc{position:fixed;z-index:40;top:0;bottom:0;inset-inline-start:0;width:min(21rem,86vw);max-height:none;
align-self:stretch;
padding:1rem;background:var(--card);border-inline-end:1px solid var(--line);box-shadow:0 0 40px var(--shadow);
transform:translateX(-105%);visibility:hidden;transition:transform .25s ease,visibility .25s}
[dir=rtl] .toc{transform:translateX(105%)}
.toc.open{transform:none;visibility:visible}
main{padding-top:1.5rem;font-size:calc(1.0625rem * var(--scale))}
.cover{flex-direction:column;align-items:flex-start;gap:1rem;margin-bottom:2rem;padding-bottom:1.75rem}
.cover img{width:7rem}
.cover h1{font-size:1.75em}
}
/* Wide (a tablet turned too): the contents are the sidebar, never a drawer. */
@media (min-width:60.01rem){.only-narrow,.scrim{display:none!important}}
@media (max-width:36rem){
.controls{flex-wrap:wrap;gap:.1rem .5rem}
.now{order:-2}
.extras{order:-1;flex:none}
.controls .buttons{flex-basis:100%;justify-content:center}
.opener h2{font-size:1.5em}
.extras label span{display:none}
}
@media (prefers-reduced-motion:reduce){*{transition:none!important;scroll-behavior:auto!important}}
@media print{
@page{margin:2cm}
/* As specific as the theme rules (a theme picked, or Auto in a dark OS): paper stays light. */
:root,:root[data-theme],:root:not([data-theme]){--bg:#fff;--fg:#000;--muted:#444;--line:#bbb;
--card:#fff;--accent:#000;--word:#000;--phrase:transparent;--shadow:transparent;color-scheme:light}
body{background:#fff;color:#000;padding:0}
.bar,.player,.toc,.pill,.scrim,.note,#settings,#keys{display:none!important}
.shell{display:block;max-width:none;padding:0}
main{max-width:none;padding:0;font-size:11.5pt;line-height:1.55}
.cover{break-after:page;border:0}
main section{break-before:page;margin:0}
.opener,main h3,main h4{break-after:avoid}
main p{orphans:3;widows:3}
.ph.on{background:none}
.w.on{color:inherit;text-decoration:none}
.opener .label,main p.lead::first-letter{color:#000}
}
"""

_JS = r"""
(function () {
  'use strict';
  var data = JSON.parse(document.getElementById('book-data').textContent);
  var L = data.labels;
  var root = document.documentElement;
  var body = document.body;
  var audio = document.getElementById('audio');
  var playButton = document.getElementById('play');
  var seekBar = document.getElementById('seek');
  var ticks = document.getElementById('ticks');
  var timeText = document.getElementById('time');
  var nowTitle = document.getElementById('now');
  var main = document.getElementById('text');
  var toc = document.getElementById('toc');
  var tocPanel = document.getElementById('toc-panel');
  var bookLang = main.getAttribute('lang') || '';
  var tocToggle = document.getElementById('toc-toggle');
  var scrim = document.getElementById('scrim');
  var bar = document.getElementById('bar');
  var player = document.getElementById('player');
  var pill = document.getElementById('back-to-current');
  var WS = /\s+/;
  var LETTER;
  try { LETTER = new RegExp('[\\p{L}\\p{M}\\p{N}]', 'gu'); } catch (e) { LETTER = /[A-Za-z0-9]/g; }
  var words = [];
  var phraseEls = [];
  var chapters = [];

  // ---- Reading settings: kept in this browser only.
  var STORE = 'voicestudio-book-reader';
  var SCALES = [0.8, 0.9, 1, 1.1, 1.2, 1.3, 1.4, 1.5, 1.6];
  var prefs = { scale: 2, theme: 'auto', align: 'justify', follow: true };
  try {
    var saved = JSON.parse(window.localStorage.getItem(STORE) || 'null');
    if (saved && typeof saved === 'object') {
      if (typeof saved.scale === 'number' && SCALES[saved.scale] !== undefined) prefs.scale = saved.scale;
      if (/^(auto|light|sepia|dark)$/.test(saved.theme)) prefs.theme = saved.theme;
      if (saved.align === 'justify' || saved.align === 'start') prefs.align = saved.align;
      if (typeof saved.follow === 'boolean') prefs.follow = saved.follow;
    }
  } catch (e) { /* storage off: defaults */ }
  function savePrefs() {
    try { window.localStorage.setItem(STORE, JSON.stringify(prefs)); } catch (e) { /* not kept */ }
  }
  var fontDown = document.getElementById('font-down');
  var fontUp = document.getElementById('font-up');
  var fontSize = document.getElementById('font-size');
  var followBox = document.getElementById('follow');
  var choices = Array.prototype.slice.call(document.querySelectorAll('[data-pref]'));
  function applyPrefs() {
    root.style.setProperty('--scale', String(SCALES[prefs.scale]));
    if (prefs.theme === 'auto') root.removeAttribute('data-theme');
    else root.setAttribute('data-theme', prefs.theme);
    root.setAttribute('data-align', prefs.align);
    fontSize.textContent = Math.round(SCALES[prefs.scale] * 100) + '%';
    fontDown.disabled = prefs.scale === 0;
    fontUp.disabled = prefs.scale === SCALES.length - 1;
    followBox.checked = prefs.follow;
    choices.forEach(function (button) {
      button.setAttribute('aria-pressed', String(prefs[button.dataset.pref] === button.dataset.value));
    });
  }
  function setPref(key, value) { prefs[key] = value; applyPrefs(); savePrefs(); }
  fontDown.addEventListener('click', function () { setPref('scale', Math.max(0, prefs.scale - 1)); });
  fontUp.addEventListener('click', function () { setPref('scale', Math.min(SCALES.length - 1, prefs.scale + 1)); });
  followBox.addEventListener('change', function () {
    setPref('follow', followBox.checked);
    if (followBox.checked) { suspended = false; reveal(false); }
    updatePill();
  });
  choices.forEach(function (button) {
    button.addEventListener('click', function () { setPref(button.dataset.pref, button.dataset.value); });
  });
  applyPrefs();

  // ---- The text.
  function tokens(text) { return String(text || '').trim().split(WS).filter(Boolean); }
  // Words of a phrase over [start, end]: by their letters, or evenly when
  // only the chapter is timed (the app's reader does the same).
  function timeWords(list, start, end, even) {
    var weights = list.map(function (w) { var m = w.match(LETTER); return m ? m.length : 0; });
    var total = weights.reduce(function (a, b) { return a + b; }, 0);
    if (even || !total) { weights = list.map(function () { return 1; }); total = list.length; }
    var per = Math.max(0, end - start) / (total || 1);
    var at = 0;
    return list.map(function (w, i) {
      var item = { text: w, start: start + at * per };
      at += weights[i];
      return item;
    });
  }
  function squash(text) { return String(text || '').replace(/\s+/g, ' ').trim(); }
  function clock(t) {
    t = Math.max(0, Math.floor(t || 0));
    var h = Math.floor(t / 3600), m = Math.floor(t % 3600 / 60), s = t % 60;
    var mm = h ? String(m).padStart(2, '0') : String(m);
    return (h ? h + ':' : '') + mm + ':' + String(s).padStart(2, '0');
  }
  function el(tag, cls, text) {
    var node = document.createElement(tag);
    if (cls) node.className = cls;
    if (text != null) node.textContent = text;
    return node;
  }
  function addPhrase(host, phrase, even) {
    var span = el('span', 'ph');
    var index = phraseEls.length;
    phraseEls.push(span);
    timeWords(tokens(phrase.text), phrase.start, phrase.end, even).forEach(function (w, k) {
      if (k) span.appendChild(document.createTextNode(' '));
      var word = el('span', 'w', w.text);
      word.dataset.i = String(words.length);
      words.push({ start: w.start, el: word, phrase: index });
      span.appendChild(word);
    });
    if (host.childNodes.length && host.lastChild.nodeName !== 'BR') host.appendChild(document.createTextNode(' '));
    host.appendChild(span);
  }
  // The chapter-number label above a title, unless the title already says it
  // ("Chapter 3: …" under "Chapter 3").
  function numberLabel(chapter) {
    if (chapter.headless || chapter.untitled || chapter.number == null) return '';
    var label = L.chapter_n.replace('{n}', String(chapter.number));
    var lead = squash(L.chapter_n.split('{n}')[0]).toLowerCase();
    if (lead && squash(chapter.title).toLowerCase().indexOf(lead) === 0) return '';
    return label;
  }
  // Words in the app's language (labels) inside the book's text, which
  // carries the book's own: read out and set in the app's language.
  function appWords(node) {
    node.lang = root.lang;
    node.dir = root.dir || 'ltr';
    return node;
  }
  function tocButton(number, title, onClick, cls) {
    var button = el('button', cls || null);
    button.type = 'button';
    if (number !== null) button.appendChild(el('span', 'num', number));
    button.appendChild(el('span', 't', title));
    button.addEventListener('click', onClick);
    return button;
  }

  var estimated = false;
  var hasSections = false;
  data.chapters.forEach(function (chapter, c) {
    var even = chapter.precision === 'chapter';
    if (even) estimated = true;
    var section = el('section');
    section.id = 'chapter-' + (c + 1);
    var label = numberLabel(chapter);
    if (!chapter.headless) {
      var opener = el('header', 'opener');
      if (label) opener.appendChild(appWords(el('p', 'label', label)));
      var openerTitle = opener.appendChild(el('h2', null, chapter.title));
      if (chapter.app_title) appWords(openerTitle);
      section.appendChild(opener);
    }
    var item = el('li');
    var button = tocButton(label ? String(chapter.number) : null, chapter.title,
      function () { seekTo(chapter.start, section); closeDrawer(); });
    if (chapter.app_title) appWords(button.lastChild);
    item.appendChild(button);
    chapters.push({ start: chapter.start, el: button, section: section, title: chapter.title,
      appTitle: !!chapter.app_title });
    var marks = (chapter.sections || []).slice().sort(function (a, b) { return a.phrase - b.phrase; });
    if (marks.length) { item.appendChild(el('ol')); hasSections = true; }
    toc.appendChild(item);
    var phrases = chapter.phrases || [];
    var p = null;
    var lead = true;
    var m = 0;
    for (var i = 0; i < phrases.length; i++) {
      if (m < marks.length && marks[m].phrase <= i) {
        var mark = marks[m++];
        var heading = el(mark.level === 3 ? 'h4' : 'h3');
        section.appendChild(heading);
        var sub = el('li');
        sub.appendChild(tocButton(null, mark.title, (function (t, target) {
          return function () { seekTo(t, target); closeDrawer(); };
        })(mark.start, heading), mark.level === 3 ? 's3' : null));
        item.lastChild.appendChild(sub);
        // The heading is read aloud: its phrases are the heading itself.
        var said = '';
        var k = i;
        while (k < phrases.length && squash(said).length < squash(mark.title).length) {
          said += ' ' + phrases[k].text;
          k++;
        }
        if (squash(said) === squash(mark.title)) {
          for (; i < k; i++) addPhrase(heading, phrases[i], even);
        } else {
          heading.textContent = mark.title;
        }
        p = null;
        lead = false;
        i--;
        continue;
      }
      var brk = phrases[i]['break'];
      if (!p || brk === 'paragraph') {
        p = el('p', lead ? 'lead' : null);
        lead = false;
        section.appendChild(p);
      } else if (brk === 'line') {
        p.appendChild(el('br'));
      }
      addPhrase(p, phrases[i], even);
    }
    main.appendChild(section);
  });
  if (estimated) {
    var note = appWords(el('p', 'note', L.estimated));
    var cover = main.querySelector('.cover');
    main.insertBefore(note, cover ? cover.nextSibling : main.firstChild);
  }
  if (chapters.length < 2 && !hasSections) body.classList.add('no-toc');

  // ---- Playback.
  function total() {
    return isFinite(audio.duration) && audio.duration > 0 ? audio.duration : (data.duration || 0);
  }
  function play() {
    var started = audio.play();
    if (started && started.catch) started.catch(function () {});
  }
  function jump(t) {
    audio.currentTime = Math.max(0, t);
    suspended = false;
    if (audio.paused) play();
  }
  // Move to `t` and show `target` (a chapter or section) or the phrase there.
  function seekTo(t, target) {
    audio.currentTime = Math.max(0, t);
    suspended = false;
    paint();
    if (target) scrollToEl(target, 0);
    else reveal(true);
  }
  function chapterAt(t) { return find(chapters, t); }
  function previousChapter() {
    var t = audio.currentTime;
    var i = chapterAt(t);
    if (i < 0) return seekTo(0);
    if (t - chapters[i].start > 3 || i === 0) return seekTo(chapters[i].start, chapters[i].section);
    seekTo(chapters[i - 1].start, chapters[i - 1].section);
  }
  function nextChapter() {
    var i = chapterAt(audio.currentTime);
    if (i + 1 < chapters.length) seekTo(chapters[i + 1].start, chapters[i + 1].section);
  }
  function drawTicks() {
    var length = total();
    ticks.textContent = '';
    if (!length) return;
    chapters.forEach(function (chapter, i) {
      if (!i || chapter.start <= 0 || chapter.start >= length) return;
      var tick = el('span');
      tick.style.insetInlineStart = (100 * chapter.start / length) + '%';
      ticks.appendChild(tick);
    });
  }

  // ---- Following the voice.
  var suspended = false;
  function band() {
    var top = bar.offsetHeight;
    var bottom = window.innerHeight - player.offsetHeight;
    return { top: top, bottom: bottom, height: Math.max(1, bottom - top) };
  }
  function motion() {
    return window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth';
  }
  function scrollToEl(node, share) {
    var view = band();
    var box = node.getBoundingClientRect();
    window.scrollTo({ top: window.pageYOffset + box.top - view.top - view.height * share, behavior: motion() });
  }
  // Keep the phrase being read in the upper third of the page.
  function reveal(force) {
    if (currentPhrase < 0) return;
    var node = phraseEls[currentPhrase];
    var view = band();
    var box = node.getBoundingClientRect();
    if (force || box.top < view.top + 8 || box.top > view.top + view.height * 0.5) scrollToEl(node, 0.2);
  }
  function follow() {
    if (!prefs.follow || suspended || audio.paused) return;
    reveal(false);
  }
  function offscreen(node) {
    var view = band();
    var box = node.getBoundingClientRect();
    return box.bottom < view.top || box.top > view.bottom;
  }
  function updatePill() {
    var show = currentPhrase >= 0 && !audio.paused && (suspended || !prefs.follow) &&
      offscreen(phraseEls[currentPhrase]);
    pill.hidden = !show;
  }
  function userScrolled() {
    if (audio.paused || !prefs.follow) return;
    suspended = true;
    updatePill();
  }
  // What scrolls (or takes the keys) on its own, not the page: the contents
  // panel, a menu, and for the keys a field such as the speed list.
  function ownScroll(target, keys) {
    if (!target || target.nodeType !== 1) return false;
    return tocPanel.contains(target) || !!target.closest('.menu') ||
      (keys && /^(INPUT|SELECT|TEXTAREA)$/.test(target.tagName));
  }
  window.addEventListener('wheel', function (event) {
    if (!ownScroll(event.target, false)) userScrolled();
  }, { passive: true });
  window.addEventListener('touchmove', function (event) {
    if (!ownScroll(event.target, false)) userScrolled();
  }, { passive: true });
  window.addEventListener('keydown', function (event) {
    if (event.defaultPrevented || ownScroll(event.target, true)) return;
    if (/^(PageUp|PageDown|ArrowUp|ArrowDown|Home|End)$/.test(event.key)) userScrolled();
  });
  var pillFrame = 0;
  window.addEventListener('scroll', function () {
    if (pillFrame) return;
    pillFrame = requestAnimationFrame(function () { pillFrame = 0; updatePill(); });
  }, { passive: true });
  pill.addEventListener('click', function () { suspended = false; reveal(true); pill.hidden = true; });

  var current = -1;
  var currentPhrase = -1;
  var currentChapter = -1;
  var shownSecond = -1;
  var shownSeek = -1;
  function find(list, t) {
    if (!list.length || !(t >= list[0].start)) return -1;
    var lo = 0, hi = list.length - 1;
    while (lo < hi) {
      var mid = (lo + hi + 1) >> 1;
      if (list[mid].start <= t) lo = mid; else hi = mid - 1;
    }
    return lo;
  }
  function showChapterInContents(button) {
    // Skipped only where the contents are not drawn: the phone drawer is
    // fixed (so it has no offsetParent) but drawn, open or not.
    if (!tocPanel.getClientRects().length || body.classList.contains('no-toc')) return;
    var top = button.getBoundingClientRect().top - tocPanel.getBoundingClientRect().top +
      tocPanel.scrollTop;
    if (top < tocPanel.scrollTop || top + button.offsetHeight > tocPanel.scrollTop + tocPanel.clientHeight) {
      tocPanel.scrollTop = Math.max(0, top - tocPanel.clientHeight / 3);
    }
  }
  function paint() {
    var t = audio.currentTime;
    var index = find(words, t);
    if (index !== current) {
      if (current >= 0) words[current].el.classList.remove('on');
      current = index;
      if (index >= 0) words[index].el.classList.add('on');
    }
    var phrase = index >= 0 ? words[index].phrase : -1;
    if (phrase !== currentPhrase) {
      if (currentPhrase >= 0) phraseEls[currentPhrase].classList.remove('on');
      currentPhrase = phrase;
      if (phrase >= 0) { phraseEls[phrase].classList.add('on'); follow(); }
      updatePill();
    }
    var chapter = find(chapters, t);
    if (chapter !== currentChapter) {
      if (currentChapter >= 0) chapters[currentChapter].el.removeAttribute('aria-current');
      currentChapter = chapter;
      var shown = chapters[Math.max(0, chapter)];
      nowTitle.textContent = shown ? shown.title : '';
      nowTitle.lang = shown && shown.appTitle ? root.lang : bookLang;
      nowTitle.dir = shown && shown.appTitle ? (root.dir || 'ltr') : 'auto';
      if (chapter >= 0) {
        chapters[chapter].el.setAttribute('aria-current', 'true');
        showChapterInContents(chapters[chapter].el);
      }
    }
    var length = total();
    // The seek bar moves on by a visible step, the clock by a second.
    if (!seeking && Math.abs(t - shownSeek) >= Math.max(0.25, length / 1000)) {
      shownSeek = t;
      seekBar.value = String(t);
    }
    var second = Math.floor(t);
    if (second !== shownSecond) {
      shownSecond = second;
      var time = clock(t) + ' / ' + clock(length);
      timeText.textContent = time;
      seekBar.setAttribute('aria-valuetext', time);
    }
  }
  var frame = 0;
  function loop() { paint(); frame = audio.paused ? 0 : requestAnimationFrame(loop); }
  function setPlaying(playing) {
    playButton.setAttribute('aria-label', playing ? L.pause : L.play);
    playButton.title = playing ? L.pause : L.play;
    playButton.querySelector('.i-play').style.display = playing ? 'none' : '';
    playButton.querySelector('.i-pause').style.display = playing ? '' : 'none';
  }
  audio.addEventListener('play', function () {
    setPlaying(true);
    suspended = false;
    if (!frame) frame = requestAnimationFrame(loop);
  });
  audio.addEventListener('pause', function () { setPlaying(false); paint(); updatePill(); });
  audio.addEventListener('timeupdate', function () { if (!frame) paint(); });
  audio.addEventListener('loadedmetadata', function () {
    seekBar.max = String(total());
    shownSecond = -1;
    drawTicks();
    paint();
  });
  var seeking = false;
  seekBar.max = String(total());
  seekBar.addEventListener('input', function () {
    seeking = true;
    audio.currentTime = Number(seekBar.value);
    shownSeek = audio.currentTime;
    paint();
  });
  seekBar.addEventListener('change', function () { seeking = false; suspended = false; reveal(false); });
  playButton.addEventListener('click', function () { if (audio.paused) play(); else audio.pause(); });
  document.getElementById('back').addEventListener('click', function () { audio.currentTime = Math.max(0, audio.currentTime - 10); });
  document.getElementById('forward').addEventListener('click', function () { audio.currentTime = audio.currentTime + 10; });
  document.getElementById('prev-chapter').addEventListener('click', previousChapter);
  document.getElementById('next-chapter').addEventListener('click', nextChapter);
  document.getElementById('speed').addEventListener('change', function (event) { audio.playbackRate = Number(event.target.value) || 1; });
  main.addEventListener('click', function (event) {
    var selection = window.getSelection && window.getSelection();
    if (selection && !selection.isCollapsed) return;
    var target = event.target;
    if (target && target.dataset && target.dataset.i !== undefined) jump(words[Number(target.dataset.i)].start);
  });

  // ---- Menus and the contents drawer.
  var openMenu = null;
  function setMenu(menu, button, open) {
    if (open && openMenu && openMenu.menu !== menu) setMenu(openMenu.menu, openMenu.button, false);
    menu.hidden = !open;
    button.setAttribute('aria-expanded', String(open));
    if (open) {
      openMenu = { menu: menu, button: button };
      var first = menu.querySelector('button:not(:disabled), input, select');
      if (first) first.focus({ preventScroll: true });
    } else if (openMenu && openMenu.menu === menu) {
      openMenu = null;
    }
  }
  [['settings', 'settings-toggle'], ['keys', 'keys-toggle']].forEach(function (pair) {
    var menu = document.getElementById(pair[0]);
    var button = document.getElementById(pair[1]);
    button.addEventListener('click', function () { setMenu(menu, button, menu.hidden); });
  });
  document.addEventListener('click', function (event) {
    if (openMenu && !openMenu.menu.contains(event.target) && !openMenu.button.contains(event.target)) {
      setMenu(openMenu.menu, openMenu.button, false);
    }
  });
  function setDrawer(open) {
    tocPanel.classList.toggle('open', open);
    scrim.hidden = !open;
    tocToggle.setAttribute('aria-expanded', String(open));
    if (open) {
      var currentEntry = toc.querySelector('[aria-current=true]');
      // The chapter being read is in view in the drawer, not only focused.
      if (currentEntry) showChapterInContents(currentEntry);
      var focus = currentEntry || toc.querySelector('button');
      if (focus) focus.focus({ preventScroll: true });
    }
  }
  function closeDrawer() {
    if (!tocPanel.classList.contains('open')) return;
    setDrawer(false);
    tocToggle.focus({ preventScroll: true });
  }
  tocToggle.addEventListener('click', function () { setDrawer(!tocPanel.classList.contains('open')); });
  document.getElementById('toc-close').addEventListener('click', closeDrawer);
  scrim.addEventListener('click', closeDrawer);
  // Wide again (a tablet turned): the contents are the sidebar, so an open
  // drawer closes; its scrim and expanded toggle would stay behind.
  var wideQuery = window.matchMedia ? window.matchMedia('(min-width:60.01rem)') : null;
  function leaveDrawer() {
    if (wideQuery.matches && tocPanel.classList.contains('open')) setDrawer(false);
  }
  if (wideQuery && wideQuery.addEventListener) wideQuery.addEventListener('change', leaveDrawer);
  else if (wideQuery && wideQuery.addListener) wideQuery.addListener(leaveDrawer);

  document.addEventListener('keydown', function (event) {
    if (event.key === 'Escape') {
      if (openMenu) {
        var button = openMenu.button;
        setMenu(openMenu.menu, button, false);
        button.focus({ preventScroll: true });
      } else {
        closeDrawer();
      }
      return;
    }
    if (event.altKey || event.ctrlKey || event.metaKey) return;
    var tag = (event.target && event.target.tagName) || '';
    if (/^(INPUT|SELECT|TEXTAREA|BUTTON)$/.test(tag)) return;
    if (event.key === ' ' || event.key === 'Spacebar') {
      event.preventDefault();
      if (audio.paused) play(); else audio.pause();
    } else if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
      event.preventDefault();
      var back = event.key === 'ArrowLeft';
      if (event.shiftKey) {
        if (back) previousChapter(); else nextChapter();
      } else {
        audio.currentTime = Math.max(0, audio.currentTime + (back ? -5 : 5));
      }
    }
  });

  // The title shows in the top bar once the title block has scrolled away.
  var h1 = main.querySelector('.cover h1');
  if (h1 && window.IntersectionObserver) {
    new IntersectionObserver(function (entries) {
      bar.classList.toggle('titled', !entries[0].isIntersecting);
    }, { rootMargin: '-48px 0px 0px 0px' }).observe(h1);
  } else {
    bar.classList.add('titled');
  }
  function measure() {
    root.style.setProperty('--bar-h', bar.offsetHeight + 'px');
    root.style.setProperty('--player-h', player.offsetHeight + 'px');
  }
  window.addEventListener('resize', measure);
  measure();
  drawTicks();
  setPlaying(false);
  paint();
})();
"""

_ICONS = {
    "back": '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 5V2L7 6l5 4V7a6 6 0 1 1-6 6H4a8 8 0 1 0 8-8z"/></svg>',
    "forward": '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 5V2l5 4-5 4V7a6 6 0 1 0 6 6h2a8 8 0 1 1-8-8z"/></svg>',
    "play": '<svg class="i-play" viewBox="0 0 24 24" aria-hidden="true"><path d="M8 5v14l11-7z"/></svg>',
    "pause": '<svg class="i-pause" viewBox="0 0 24 24" aria-hidden="true"><path d="M6 5h4v14H6zm8 0h4v14h-4z"/></svg>',
    "prev": '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6h2v12H6zm3.5 6 8.5 6V6z"/></svg>',
    "next": '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M16 6h2v12h-2zM6 18l8.5-6L6 6z"/></svg>',
    "menu": '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 6h18v2H3zm0 5h18v2H3zm0 5h18v2H3z"/></svg>',
    "close": '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6.4 5 5 6.4 10.6 12 5 17.6 6.4 19l5.6-5.6 5.6 5.6 1.4-1.4-5.6-5.6L19 6.4 17.6 5 12 10.6z"/></svg>',
}


def render_page(*, title: str, timeline: Optional[dict], audio_src: str,
                labels: Optional[dict] = None, author: str = "", narrator: str = "",
                cover_src: Optional[str] = None, lang: str = "en", direction: str = "ltr",
                book_lang: str = "", duration: float = 0.0) -> str:
    """The book's ``index.html``. Every text from the book goes through
    :func:`html.escape` or :func:`_script_json`; the page builds its text
    with ``textContent`` only.

    ``lang`` and ``direction`` are the app's, whose words the page's own
    labels are in; ``book_lang`` is the language of the book's text (its
    title, contents and chapters), ``""`` when it is not known. The book's
    text runs in its own direction (``dir="auto"``)."""
    labels = labels_for(labels)
    esc = html.escape

    def label(key: str) -> str:
        return esc(labels[key])

    byline = ""
    if author:
        byline += f'<p class="author"{_text_lang(book_lang)}>{esc(author)}</p>'
    if narrator:
        # "Narrated by" is the app's words, inside the book's text.
        byline += (f'<p lang="{esc(lang or "en")}" dir="{"rtl" if direction == "rtl" else "ltr"}">'
                   f"{label('narrated_by')} <bdi>{esc(narrator)}</bdi></p>")
    cover = f'<img src="{esc(cover_src)}" alt="">' if cover_src else ""
    data = {**page_timeline(timeline, labels, book_title=title), "labels": labels,
            "duration": float(duration or 0)}
    text_lang = _text_lang(book_lang)
    speeds = "".join(
        f'<option value="{s}"{" selected" if s == 1 else ""}>{s}×</option>' for s in SPEEDS)

    def choice(pref: str, value: str, key: str) -> str:
        return (f'<button type="button" data-pref="{pref}" data-value="{value}" '
                f'aria-pressed="false">{label(key)}</button>')

    themes = "".join(choice("theme", v, f"theme_{v}") for v in ("auto", "light", "sepia", "dark"))
    aligns = choice("align", "justify", "justify") + choice("align", "start", "align_start")
    return f"""<!doctype html>
<html lang="{esc(lang or 'en')}" dir="{'rtl' if direction == 'rtl' else 'ltr'}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light dark">
<title>{esc(title)}</title>
<style>{_CSS}</style>
</head>
<body>
<header class="bar" id="bar">
<button type="button" class="icon only-narrow" id="toc-toggle" aria-label="{label('contents')}" title="{label('contents')}" aria-expanded="false" aria-controls="toc-panel">{_ICONS['menu']}</button>
<span class="bar-title"{text_lang}>{esc(title)}</span>
<button type="button" class="icon aa" id="settings-toggle" aria-label="{label('settings')}" title="{label('settings')}" aria-expanded="false" aria-controls="settings">Aa</button>
<div class="menu" id="settings" role="dialog" aria-label="{label('settings')}" hidden>
<fieldset><legend>{label('text_size')}</legend><div class="seg">
<button type="button" id="font-down" aria-label="{label('smaller')}" title="{label('smaller')}">A−</button>
<output id="font-size" aria-live="polite">100%</output>
<button type="button" id="font-up" aria-label="{label('larger')}" title="{label('larger')}">A+</button>
</div></fieldset>
<fieldset><legend>{label('theme')}</legend><div class="seg">{themes}</div></fieldset>
<fieldset><legend>{label('align')}</legend><div class="seg">{aligns}</div></fieldset>
<label class="switch"><span>{label('follow')}</span><input type="checkbox" id="follow" checked></label>
</div>
</header>
<div class="shell">
<nav class="toc" id="toc-panel" aria-labelledby="contents">
<div class="toc-head"><h2 id="contents">{label('contents')}</h2><button type="button" class="icon only-narrow" id="toc-close" aria-label="{label('close')}" title="{label('close')}">{_ICONS['close']}</button></div>
<ol id="toc"{text_lang}></ol>
</nav>
<div class="scrim" id="scrim" hidden></div>
<main id="text"{text_lang}>
<header class="cover">{cover}<div><h1>{esc(title)}</h1>{byline}</div></header>
</main>
</div>
<button type="button" class="pill" id="back-to-current" hidden>{label('back_to_current')}</button>
<div class="player" id="player" role="region" aria-label="{label('player')}">
<audio id="audio" preload="metadata" src="{esc(audio_src)}"></audio>
<div class="seek-row">
<div class="seek"><div id="ticks" aria-hidden="true"></div><input id="seek" type="range" min="0" step="0.1" value="0" aria-label="{label('seek')}"></div>
<span id="time">0:00</span>
</div>
<div class="controls">
<div class="now" id="now"{text_lang}></div>
<div class="buttons">
<button type="button" class="icon" id="prev-chapter" aria-label="{label('prev_chapter')}" title="{label('prev_chapter')}">{_ICONS['prev']}</button>
<button type="button" class="icon" id="back" aria-label="{label('back')}" title="{label('back')}">{_ICONS['back']}</button>
<button type="button" class="icon" id="play" aria-label="{label('play')}">{_ICONS['play']}{_ICONS['pause']}</button>
<button type="button" class="icon" id="forward" aria-label="{label('forward')}" title="{label('forward')}">{_ICONS['forward']}</button>
<button type="button" class="icon" id="next-chapter" aria-label="{label('next_chapter')}" title="{label('next_chapter')}">{_ICONS['next']}</button>
</div>
<div class="extras">
<label><span>{label('speed')}</span> <select id="speed" aria-label="{label('speed')}">{speeds}</select></label>
<button type="button" class="icon" id="keys-toggle" aria-label="{label('shortcuts')}" title="{label('shortcuts')}" aria-expanded="false" aria-controls="keys">?</button>
<div class="menu" id="keys" role="dialog" aria-label="{label('shortcuts')}" hidden><p>{label('keys')}</p><p>{label('keys_chapter')}</p></div>
</div>
</div>
</div>
<script type="application/json" id="book-data">{_script_json(data)}</script>
<script>{_JS}</script>
</body>
</html>
"""


def _text_lang(book_lang: str) -> str:
    """The attributes of an element holding the book's own text."""
    return f' lang="{html.escape(book_lang)}" dir="auto"'


def audio_name(output: str) -> str:
    """The book's file inside the export: an ``.m4b`` travels as ``.m4a`` (the
    same MP4 audio), which every browser plays."""
    stem, ext = os.path.splitext(os.path.basename(output))
    return f"{stem}{'.mp3' if ext.lower() == '.mp3' else '.m4a'}"


def write_export_zip(zip_path: str, *, page: str, audio_path: str, audio_entry: str,
                     cover_path: Optional[str] = None,
                     cover_entry: Optional[str] = None) -> int:
    """Write the export atomically (a temp file, then a rename): ``index.html``
    compressed, the audio and cover stored as they are. Returns its size."""
    partial = f"{zip_path}.part"
    try:
        with zipfile.ZipFile(partial, "w") as archive:
            archive.writestr("index.html", page.encode("utf-8"), zipfile.ZIP_DEFLATED)
            archive.write(audio_path, audio_entry, zipfile.ZIP_STORED)
            if cover_path and cover_entry:
                archive.write(cover_path, cover_entry, zipfile.ZIP_STORED)
        os.replace(partial, zip_path)
    finally:
        if os.path.exists(partial):
            os.remove(partial)
    return os.path.getsize(zip_path)
