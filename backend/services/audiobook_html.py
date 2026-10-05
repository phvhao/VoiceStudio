"""A finished audiobook as a web page: ``index.html`` + its audio in a ZIP.

The page is ONE self-contained file — inline CSS and script, no fonts, no
network request of any kind (local-first) — that plays ``audio/<book>.<ext>``
beside it and shows the book's text with the phrase being read highlighted
and its word tinted, from the book's rendered timeline
(:func:`services.audiobook.book_timeline`). A book rendered without one gets
a timeline estimated from the script, chapter by chapter.

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
}
#: The longest label kept (a sentence, not a payload).
_LABEL_MAX = 300
SPEEDS = (0.75, 1, 1.25, 1.5, 1.75, 2)


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


def page_timeline(timeline: Optional[dict]) -> dict:
    """What the page reads from a book timeline: chapters with their phrases
    and sections, nothing else (cache keys stay home)."""
    chapters = []
    for chapter in (timeline or {}).get("chapters") or []:
        if not isinstance(chapter, dict):
            continue
        chapters.append({
            "title": str(chapter.get("title") or ""),
            "start": chapter.get("start", 0),
            "end": chapter.get("end", 0),
            "precision": chapter.get("precision", "chapter"),
            "phrases": [{"text": str(p.get("text") or ""), "start": p.get("start", 0),
                         "end": p.get("end", 0)}
                        for p in chapter.get("phrases") or [] if isinstance(p, dict)],
            "sections": [{"title": str(s.get("title") or ""), "level": s.get("level", 2),
                          "start": s.get("start", 0), "phrase": s.get("phrase", 0)}
                         for s in chapter.get("sections") or [] if isinstance(s, dict)],
        })
    return {"chapters": chapters}


_CSS = """
:root{--bg:#fbfaf7;--fg:#1d1d1f;--muted:#6b6b70;--line:#e3e1dc;--card:#ffffff;
--accent:#3b5bdb;--phrase:rgba(59,91,219,.12);--word:rgba(59,91,219,.32);color-scheme:light dark}
@media (prefers-color-scheme:dark){:root{--bg:#141416;--fg:#ececef;--muted:#9a9aa3;
--line:#2c2c31;--card:#1c1c20;--accent:#8ea2ff;--phrase:rgba(142,162,255,.16);
--word:rgba(142,162,255,.38)}}
*{box-sizing:border-box}
html{-webkit-text-size-adjust:100%}
body{margin:0;background:var(--bg);color:var(--fg);
font:17px/1.7 system-ui,-apple-system,"Segoe UI",Roboto,"Noto Sans",sans-serif;
padding-bottom:7rem}
.book{display:flex;gap:1.25rem;align-items:center;max-width:72rem;margin:0 auto;padding:2rem 1rem 1rem}
.book img{width:7.5rem;height:auto;border-radius:.5rem;box-shadow:0 2px 12px rgba(0,0,0,.18);flex:none}
.book h1{margin:0;font-size:1.75rem;line-height:1.25}
.book p{margin:.25rem 0 0;color:var(--muted)}
.layout{display:grid;grid-template-columns:16rem minmax(0,1fr);gap:2rem;max-width:72rem;margin:0 auto;padding:0 1rem}
nav{position:sticky;top:1rem;align-self:start;max-height:calc(100vh - 9rem);overflow:auto;font-size:.9rem}
nav h2{font-size:.8rem;text-transform:uppercase;letter-spacing:.06em;color:var(--muted);margin:0 0 .5rem}
nav ol{list-style:none;margin:0;padding:0}
nav ol ol{padding-left:.9rem}
nav button{all:unset;cursor:pointer;display:block;width:100%;padding:.2rem .4rem;border-radius:.35rem;line-height:1.4}
nav button:hover{background:var(--phrase)}
nav button:focus-visible{outline:2px solid var(--accent)}
nav button[aria-current=true]{color:var(--accent);font-weight:600}
nav .s3{padding-left:1.2rem}
main{max-width:42rem}
main section{margin-bottom:2.5rem}
main h2{font-size:1.4rem;line-height:1.3;margin:1.5rem 0 .75rem}
main h3{font-size:1.15rem;margin:1.25rem 0 .5rem}
main h4{font-size:1rem;margin:1rem 0 .5rem}
.ph{border-radius:.25rem;transition:background-color .15s}
.ph.on{background:var(--phrase)}
.w{cursor:pointer;border-radius:.2rem}
.w.on{background:var(--word)}
.note{color:var(--muted);font-size:.85rem;margin:0 0 1rem}
.player{position:fixed;left:0;right:0;bottom:0;background:var(--card);border-top:1px solid var(--line);
display:flex;flex-wrap:wrap;align-items:center;gap:.5rem 1rem;padding:.6rem 1rem calc(.6rem + env(safe-area-inset-bottom))}
.player button{display:inline-grid;place-items:center;width:2.5rem;height:2.5rem;border-radius:50%;
border:1px solid var(--line);background:transparent;color:var(--fg);cursor:pointer}
.player button#play{background:var(--accent);border-color:var(--accent);color:var(--card)}
.player button:focus-visible,.player select:focus-visible,.player input:focus-visible{outline:2px solid var(--accent);outline-offset:2px}
.player svg{width:1.1rem;height:1.1rem;fill:currentColor}
#seek{flex:1 1 12rem;accent-color:var(--accent);min-width:8rem}
#time{font-variant-numeric:tabular-nums;color:var(--muted);font-size:.9rem;white-space:nowrap}
.player label{font-size:.85rem;color:var(--muted);display:flex;gap:.4rem;align-items:center}
.player select{font:inherit;color:var(--fg);background:var(--bg);border:1px solid var(--line);border-radius:.35rem;padding:.15rem .3rem}
.keys{color:var(--muted);font-size:.8rem;max-width:72rem;margin:0 auto;padding:0 1rem}
@media (max-width:48rem){.layout{grid-template-columns:1fr;gap:1rem}
nav{position:static;max-height:none;border:1px solid var(--line);border-radius:.5rem;padding:.75rem}
.book{padding-top:1.25rem}.book img{width:5rem}.book h1{font-size:1.35rem}body{font-size:16px}}
"""

_JS = r"""
(function () {
  'use strict';
  var data = JSON.parse(document.getElementById('book-data').textContent);
  var L = data.labels;
  var audio = document.getElementById('audio');
  var playButton = document.getElementById('play');
  var seekBar = document.getElementById('seek');
  var timeText = document.getElementById('time');
  var main = document.getElementById('text');
  var toc = document.getElementById('toc');
  var WS = /\s+/;
  var LETTER;
  try { LETTER = new RegExp('[\\p{L}\\p{M}\\p{N}]', 'gu'); } catch (e) { LETTER = /[A-Za-z0-9]/g; }
  var words = [];
  var phraseEls = [];
  var chapterButtons = [];

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
  function play() {
    var started = audio.play();
    if (started && started.catch) started.catch(function () {});
  }
  function jump(t) {
    audio.currentTime = Math.max(0, t);
    if (audio.paused) play();
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
    if (host.childNodes.length) host.appendChild(document.createTextNode(' '));
    host.appendChild(span);
  }

  var estimated = false;
  data.chapters.forEach(function (chapter, c) {
    var even = chapter.precision === 'chapter';
    if (even) estimated = true;
    var section = el('section');
    section.id = 'chapter-' + (c + 1);
    section.appendChild(el('h2', null, chapter.title));
    var item = el('li');
    var button = el('button', null, chapter.title);
    button.type = 'button';
    button.addEventListener('click', function () { jump(chapter.start); });
    item.appendChild(button);
    chapterButtons.push({ start: chapter.start, el: button });
    var marks = (chapter.sections || []).slice().sort(function (a, b) { return a.phrase - b.phrase; });
    if (marks.length) item.appendChild(el('ol'));
    toc.appendChild(item);
    var phrases = chapter.phrases || [];
    var p = el('p');
    section.appendChild(p);
    var m = 0;
    for (var i = 0; i < phrases.length; i++) {
      if (m < marks.length && marks[m].phrase <= i) {
        var mark = marks[m++];
        var heading = el(mark.level === 3 ? 'h4' : 'h3');
        section.appendChild(heading);
        var sub = el('li');
        var subButton = el('button', mark.level === 3 ? 's3' : null, mark.title);
        subButton.type = 'button';
        subButton.addEventListener('click', (function (t) { return function () { jump(t); }; })(mark.start));
        sub.appendChild(subButton);
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
        p = el('p');
        section.appendChild(p);
        i--;
        continue;
      }
      addPhrase(p, phrases[i], even);
    }
    if (!p.childNodes.length) section.removeChild(p);
    main.appendChild(section);
  });
  if (estimated) {
    var note = el('p', 'note', L.estimated);
    main.insertBefore(note, main.firstChild);
  }

  var current = -1;
  var currentPhrase = -1;
  var currentChapter = -1;
  var lastUserScroll = 0;
  ['wheel', 'touchmove', 'keydown'].forEach(function (type) {
    window.addEventListener(type, function (event) {
      if (type !== 'keydown' || event.key === 'PageDown' || event.key === 'PageUp') lastUserScroll = Date.now();
    }, { passive: true });
  });
  function find(list, t) {
    if (!list.length || !(t >= list[0].start)) return -1;
    var lo = 0, hi = list.length - 1;
    while (lo < hi) {
      var mid = (lo + hi + 1) >> 1;
      if (list[mid].start <= t) lo = mid; else hi = mid - 1;
    }
    return lo;
  }
  function follow(node) {
    if (audio.paused || Date.now() - lastUserScroll < 4000) return;
    var box = node.getBoundingClientRect();
    var bottom = window.innerHeight - document.querySelector('.player').offsetHeight;
    if (box.top < 0 || box.bottom > bottom) node.scrollIntoView({ block: 'center', behavior: 'smooth' });
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
      if (phrase >= 0) { phraseEls[phrase].classList.add('on'); follow(phraseEls[phrase]); }
    }
    var chapter = find(chapterButtons, t);
    if (chapter !== currentChapter) {
      if (currentChapter >= 0) chapterButtons[currentChapter].el.removeAttribute('aria-current');
      currentChapter = chapter;
      if (chapter >= 0) chapterButtons[chapter].el.setAttribute('aria-current', 'true');
    }
    if (!seeking) seekBar.value = String(t);
    timeText.textContent = clock(t) + ' / ' + clock(audio.duration || data.duration || 0);
  }
  var frame = 0;
  function loop() { paint(); frame = audio.paused ? 0 : requestAnimationFrame(loop); }
  function setPlaying(playing) {
    playButton.setAttribute('aria-label', playing ? L.pause : L.play);
    playButton.title = playing ? L.pause : L.play;
    playButton.querySelector('.i-play').style.display = playing ? 'none' : '';
    playButton.querySelector('.i-pause').style.display = playing ? '' : 'none';
  }
  audio.addEventListener('play', function () { setPlaying(true); if (!frame) frame = requestAnimationFrame(loop); });
  audio.addEventListener('pause', function () { setPlaying(false); paint(); });
  audio.addEventListener('timeupdate', function () { if (!frame) paint(); });
  audio.addEventListener('loadedmetadata', function () { seekBar.max = String(audio.duration || 0); paint(); });
  var seeking = false;
  seekBar.max = String(data.duration || 0);
  seekBar.addEventListener('input', function () { seeking = true; audio.currentTime = Number(seekBar.value); paint(); });
  seekBar.addEventListener('change', function () { seeking = false; });
  playButton.addEventListener('click', function () { if (audio.paused) play(); else audio.pause(); });
  document.getElementById('back').addEventListener('click', function () { audio.currentTime = Math.max(0, audio.currentTime - 10); });
  document.getElementById('forward').addEventListener('click', function () { audio.currentTime = audio.currentTime + 10; });
  document.getElementById('speed').addEventListener('change', function (event) { audio.playbackRate = Number(event.target.value) || 1; });
  main.addEventListener('click', function (event) {
    var target = event.target;
    if (target && target.dataset && target.dataset.i !== undefined) jump(words[Number(target.dataset.i)].start);
  });
  document.addEventListener('keydown', function (event) {
    if (event.altKey || event.ctrlKey || event.metaKey) return;
    var tag = (event.target && event.target.tagName) || '';
    if (/^(INPUT|SELECT|TEXTAREA|BUTTON)$/.test(tag)) return;
    if (event.key === ' ' || event.key === 'Spacebar') {
      event.preventDefault();
      if (audio.paused) play(); else audio.pause();
    } else if (event.key === 'ArrowLeft') {
      event.preventDefault();
      audio.currentTime = Math.max(0, audio.currentTime - 5);
    } else if (event.key === 'ArrowRight') {
      event.preventDefault();
      audio.currentTime = audio.currentTime + 5;
    }
  });
  setPlaying(false);
  paint();
})();
"""

_ICONS = {
    "back": '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 5V2L7 6l5 4V7a6 6 0 1 1-6 6H4a8 8 0 1 0 8-8z"/></svg>',
    "forward": '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 5V2l5 4-5 4V7a6 6 0 1 0 6 6h2a8 8 0 1 1-8-8z"/></svg>',
    "play": '<svg class="i-play" viewBox="0 0 24 24" aria-hidden="true"><path d="M8 5v14l11-7z"/></svg>',
    "pause": '<svg class="i-pause" viewBox="0 0 24 24" aria-hidden="true"><path d="M6 5h4v14H6zm8 0h4v14h-4z"/></svg>',
}


def render_page(*, title: str, timeline: Optional[dict], audio_src: str,
                labels: Optional[dict] = None, author: str = "", narrator: str = "",
                cover_src: Optional[str] = None, lang: str = "en",
                duration: float = 0.0) -> str:
    """The book's ``index.html``. Every text from the book goes through
    :func:`html.escape` or :func:`_script_json`; the page builds its text
    with ``textContent`` only."""
    labels = labels_for(labels)
    esc = html.escape
    byline = ""
    if author:
        byline += f"<p>{esc(author)}</p>"
    if narrator:
        byline += f"<p>{esc(labels['narrated_by'])} {esc(narrator)}</p>"
    cover = f'<img src="{esc(cover_src)}" alt="">' if cover_src else ""
    data = {**page_timeline(timeline), "labels": labels, "duration": float(duration or 0)}
    speeds = "".join(
        f'<option value="{s}"{" selected" if s == 1 else ""}>{s}×</option>' for s in SPEEDS)
    return f"""<!doctype html>
<html lang="{esc(lang or 'en')}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light dark">
<title>{esc(title)}</title>
<style>{_CSS}</style>
</head>
<body>
<header class="book">{cover}<div><h1>{esc(title)}</h1>{byline}</div></header>
<div class="layout">
<nav aria-labelledby="contents"><h2 id="contents">{esc(labels['contents'])}</h2><ol id="toc"></ol></nav>
<main id="text"></main>
</div>
<p class="keys">{esc(labels['keys'])}</p>
<div class="player" role="region" aria-label="{esc(labels['player'])}">
<audio id="audio" preload="metadata" src="{esc(audio_src)}"></audio>
<button type="button" id="back" aria-label="{esc(labels['back'])}" title="{esc(labels['back'])}">{_ICONS['back']}</button>
<button type="button" id="play" aria-label="{esc(labels['play'])}">{_ICONS['play']}{_ICONS['pause']}</button>
<button type="button" id="forward" aria-label="{esc(labels['forward'])}" title="{esc(labels['forward'])}">{_ICONS['forward']}</button>
<input id="seek" type="range" min="0" step="0.1" value="0" aria-label="{esc(labels['seek'])}">
<span id="time">0:00</span>
<label>{esc(labels['speed'])} <select id="speed">{speeds}</select></label>
</div>
<script type="application/json" id="book-data">{_script_json(data)}</script>
<script>{_JS}</script>
</body>
</html>
"""


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
