"""The designs an HTML book is exported in: six templates over one page.

Every template shares the page :mod:`services.audiobook_html` builds — the
phrase being read highlighted, contents, text size, light/sepia/dark, the
justify toggle, print styles, keys, no network, every text escaped — and
brings its own look: palettes, fonts, metrics and a few layout rules. A book's
design is a template plus quick options (accent colour, body and heading
fonts, voice or character names, chapter numbering), resolved here into
concrete values with every unknown or missing choice falling back to the
template's own.

Pure: no I/O apart from :mod:`services.book_fonts` reading its manifest.
"""
from __future__ import annotations

import re
from dataclasses import dataclass
from typing import Optional

from services import book_fonts

NUMBERING = ("words", "numeral", "roman", "none")
THEMES = ("light", "sepia", "dark")
#: Accent colours the export dialog offers besides each template's own.
ACCENTS = ("#b3261e", "#c2410c", "#a16207", "#15803d", "#0f766e", "#1d4ed8", "#6d28d9",
           "#be185d", "#475569")
_HEX_RE = re.compile(r"^#[0-9a-fA-F]{6}$")

#: Voice and character colours, in the order the Stories editor and the
#: script editor give them out (sky, amber, emerald, fuchsia, orange, teal,
#: rose, indigo): darker shades on light paper, lighter ones on dark.
WHO_LIGHT = ("#0369a1", "#b45309", "#047857", "#a21caf", "#c2410c", "#0f766e", "#be123c",
             "#4338ca")
WHO_DARK = ("#38bdf8", "#fbbf24", "#34d399", "#e879f9", "#fb923c", "#2dd4bf", "#fb7185",
            "#a5b4fc")


@dataclass(frozen=True)
class Template:
    id: str
    body_font: str
    heading_font: str
    accent: str
    #: Text and surface colours per theme (``light``, ``sepia``, ``dark``):
    #: bg, paper, fg, muted, line, card, shadow, and any other token its CSS
    #: reads (phrase, dim, bright); every theme sets the same ones.
    palettes: dict
    css: str
    body_category: str = "serif"
    heading_category: str = "serif"
    #: The theme and alignment a reader starts with ("auto" follows the computer).
    theme: str = "auto"
    align: str = "justify"
    numbering: str = "words"
    show_names: bool = False
    #: The cover as a full-width hero above the page instead of a title block.
    hero: bool = False
    #: Each chapter's first phrase set as its standfirst.
    standfirst: bool = False
    #: A pull quote, the first sentence of a paragraph halfway in, per chapter.
    pull_quotes: bool = False
    #: Every paragraph with a voice or character is a turn: name, then text.
    turns: bool = False
    #: A big play button on the cover.
    cover_play: bool = False
    #: The fonts whose italics the template sets ("body", "heading"): only
    #: those italics are embedded.
    italic: tuple = ()
    #: How strongly the phrase being read is shaded (the accent's alpha).
    phrase_alpha: float = 0.13
    #: The template the export dialog offers first for Stories.
    for_stories: bool = False
    #: Labels (character names, chapter labels) in the body, heading or a mono font.
    label_font: str = "ui"


@dataclass(frozen=True)
class Design:
    template: Template
    accent: str
    body_font: str
    heading_font: str
    show_names: bool
    numbering: str

    @property
    def embedded(self) -> tuple:
        """The bundled families this design's page carries, body first, each
        once: ``(font id, whether its italic is set too)``."""
        italic = {}
        for role, font in (("body", self.body_font), ("heading", self.heading_font)):
            if book_fonts.family(font) is not None:
                italic[font] = italic.get(font, False) or role in self.template.italic
        return tuple(italic.items())


# ── Colour arithmetic (WCAG relative luminance) ─────────────────────────────

def _rgb(value: str) -> tuple:
    return tuple(int(value[i:i + 2], 16) / 255 for i in (1, 3, 5))


def _hex(rgb) -> str:
    return "#" + "".join(f"{round(max(0.0, min(1.0, c)) * 255):02x}" for c in rgb)


def _luminance(rgb) -> float:
    def channel(c: float) -> float:
        return c / 12.92 if c <= 0.04045 else ((c + 0.055) / 1.055) ** 2.4
    r, g, b = (channel(c) for c in rgb)
    return 0.2126 * r + 0.7152 * g + 0.0722 * b


def contrast(a: str, b: str) -> float:
    la, lb = sorted((_luminance(_rgb(a)), _luminance(_rgb(b))), reverse=True)
    return (la + 0.05) / (lb + 0.05)


def readable(color: str, background: str, minimum: float = 4.5) -> str:
    """``color`` darkened (on a light background) or lightened (on a dark one)
    just enough to read at ``minimum`` contrast on ``background``."""
    if contrast(color, background) >= minimum:
        return color
    target = (0.0, 0.0, 0.0) if _luminance(_rgb(background)) > 0.18 else (1.0, 1.0, 1.0)
    rgb = _rgb(color)
    for step in range(1, 21):
        t = step / 20
        mixed = _hex(tuple(c * (1 - t) + o * t for c, o in zip(rgb, target)))
        if contrast(mixed, background) >= minimum:
            return mixed
    return _hex(target)


def on_color(color: str) -> str:
    """Text on a ``color`` fill: white where it reads, else near-black."""
    return "#ffffff" if contrast("#ffffff", color) >= 3.0 else "#111111"


def _alpha(color: str, alpha: float) -> str:
    r, g, b = (round(c * 255) for c in _rgb(color))
    return f"rgba({r},{g},{b},{alpha:g})"


# ── The templates ────────────────────────────────────────────────────────────

_CLASSIC_CSS = """
:root{--leading:1.72;--measure:34em}
.cover{flex-direction:column;align-items:center;text-align:center;gap:1.4rem;padding:3rem 0 3.25rem;
border:0;margin-bottom:2.5rem}
.cover img{width:10.5rem;max-width:45%;border-radius:2px;box-shadow:0 2px 4px var(--shadow),0 18px 40px -12px var(--shadow)}
.cover h1{font-size:2.6em;font-weight:500;letter-spacing:.005em;line-height:1.12}
.cover .author{font:400 1rem/1.4 var(--heading-font);letter-spacing:.18em;text-transform:uppercase;color:var(--fg)}
.cover p{font-family:var(--heading-font);font-size:1.05rem}
.cover-text::after,.opener::after{content:"";display:block;width:4.5rem;height:.55rem;margin:1.6rem auto 0;
background:linear-gradient(var(--accent),var(--accent)) center/100% 1px no-repeat,
radial-gradient(circle,var(--accent) 0 .2rem,transparent .22rem) center/.55rem .55rem no-repeat;opacity:.75}
.opener{text-align:center;margin:0 0 2.6rem}
.opener .label{color:var(--accent);font:500 .8rem/1.2 var(--heading-font);letter-spacing:.32em;
text-transform:uppercase;margin-bottom:.8rem}
.opener h2{font-size:2.05em;font-weight:500;line-height:1.2}
main h3{text-align:center;font-weight:500;font-size:1.2em;letter-spacing:.04em;margin:2.4em 0 1em}
main h4{text-align:center;font-weight:400;letter-spacing:.02em}
main p.lead::first-letter{float:left;font-family:var(--heading-font);font-size:3.55em;line-height:.8;
font-weight:500;margin:.06em .09em -.05em 0;color:var(--accent)}
#toc button{font-family:var(--heading-font);font-size:1.02rem}
@media (min-width:60.01rem){
main{background:var(--paper);padding:4rem clamp(3rem,6vw,5.5rem) 3.5rem;margin:2.5rem auto 0;
box-shadow:0 1px 2px var(--shadow),0 24px 60px -28px var(--shadow);border-radius:3px;max-width:calc(var(--measure) + 11rem)}
}
@media (max-width:36rem){.cover h1{font-size:2.1em}.opener h2{font-size:1.7em}}
@media print{main p.lead::first-letter{color:#000}.cover-text::after,.opener::after{opacity:1}}
"""

_MODERN_CSS = """
:root{--base:1.125rem;--base-phone:1.0625rem;--leading:1.8;--measure:64ch}
main{letter-spacing:-.003em}
.chapter>p+p{text-indent:0;margin-top:1.05em}
.cover{gap:2rem;padding:2rem;margin:0 0 3rem;border:1px solid var(--line);border-radius:1.25rem;
background:var(--card);box-shadow:0 1px 2px var(--shadow)}
.cover img{width:8.5rem;border-radius:.75rem}
.cover h1{font-size:2.3em;font-weight:700;letter-spacing:-.02em;line-height:1.1}
.opener{margin:0 0 2rem}
.opener .label{display:inline-block;padding:.32rem .7rem;border-radius:999px;background:var(--tint);
color:var(--accent);font:600 .75rem/1 var(--ui-font);letter-spacing:.08em;text-transform:uppercase;margin-bottom:1rem}
.opener h2{font-size:2em;font-weight:700;letter-spacing:-.02em;line-height:1.15}
main h3{font-weight:700;letter-spacing:-.01em}
main section{margin-bottom:5rem}
#toc{display:grid;gap:.55rem}
#toc>li>button{display:grid;grid-template-columns:minmax(0,1fr);gap:.15rem .75rem;align-items:center;
padding:.8rem .9rem;border:1px solid var(--line);border-radius:.9rem;background:var(--card);
box-shadow:0 1px 2px var(--shadow);border-inline-start-width:1px}
#toc>li>button:has(.num){grid-template-columns:2.1rem minmax(0,1fr)}
#toc>li>button .num{grid-row:span 2;display:grid;place-items:center;width:2.1rem;height:2.1rem;
border-radius:.6rem;background:var(--tint);color:var(--accent);font-weight:700;font-size:.85rem}
#toc>li>button .t{font-weight:600}
#toc>li>button .dur{display:block;color:var(--muted);font-size:.8rem;font-weight:400;font-variant-numeric:tabular-nums}
#toc>li>button[aria-current=true]{border-color:var(--accent);box-shadow:0 0 0 1px var(--accent)}
#toc>li>button[aria-current=true] .num{background:var(--accent);color:var(--on-accent)}
#toc ol{padding-inline-start:.5rem;margin:.35rem 0 .2rem}
@media (max-width:36rem){.cover{flex-direction:column;align-items:flex-start;padding:1.4rem;gap:1.2rem}
.cover h1{font-size:1.85em}.opener h2{font-size:1.65em}}
@media print{.cover{border:0;box-shadow:none;padding:0}}
"""

_MAGAZINE_CSS = """
:root{--leading:1.7;--measure:62ch}
.cover{flex-direction:column;align-items:flex-start;gap:1.5rem;border-bottom:3px solid var(--fg);padding-bottom:2.25rem}
.cover img{width:100%;max-width:100%;max-height:24rem;object-fit:cover;border-radius:0;box-shadow:none}
.cover h1{font-size:clamp(2.6em,6vw,4.2em);font-weight:800;line-height:1.08;letter-spacing:-.015em}
.cover .author{font:700 .85rem/1.3 var(--ui-font);letter-spacing:.14em;text-transform:uppercase;color:var(--accent)}
.opener{margin:0 0 1.6rem;padding-top:1.4rem;border-top:3px solid var(--fg)}
.opener .label{font:800 2.6rem/1 var(--heading-font);color:var(--accent);margin:0 0 .5rem;letter-spacing:-.01em}
.opener h2{font-size:clamp(2.1em,4.6vw,3.3em);font-weight:800;line-height:1.1;letter-spacing:-.015em}
main p.standfirst{font-family:var(--heading-font);font-size:1.38em;line-height:1.45;font-style:italic;
font-weight:500;text-align:start;margin:0 0 1.8rem;padding:0 0 1.5rem;border-bottom:1px solid var(--line);text-indent:0}
main p.standfirst+p{text-indent:0}
main p.initial::first-letter{font-family:var(--heading-font);font-weight:800;font-size:1.45em;color:var(--accent)}
main h3{font:800 .82rem/1.3 var(--ui-font);letter-spacing:.16em;text-transform:uppercase;color:var(--accent);margin:2.6em 0 1em}
main h4{font-family:var(--ui-font);font-size:.95em}
.pull{margin:2rem 0;padding:1rem 0;border-top:3px solid var(--accent);border-bottom:1px solid var(--line);
font:italic 600 1.32em/1.32 var(--heading-font);color:var(--fg);text-align:start}
.pull p{margin:0;text-align:start!important;text-indent:0!important}
.pull p::before{content:"\\201C";color:var(--accent)}
.pull p::after{content:"\\201D";color:var(--accent)}
@media (min-width:60.01rem){.pull{float:right;width:36%;margin:.4rem -4% 1rem 1.8rem}}
@media (max-width:36rem){.opener .label{font-size:2rem}.pull{font-size:1.3em}}
"""

_CINEMATIC_CSS = """
:root{--base:1.25rem;--base-phone:1.125rem;--leading:1.85;--measure:60ch}
main{padding-top:3.5rem}
.chapter>p+p{text-indent:0;margin-top:1.15em}
.hero{position:relative;isolation:isolate;overflow:hidden;display:flex;align-items:flex-end;min-height:min(78vh,46rem);
padding:7rem clamp(1.25rem,6vw,5rem) 3.5rem;margin:calc(-1 * var(--bar-h)) 0 0;
background:radial-gradient(120% 90% at 20% 0%,color-mix(in srgb,var(--accent) 30%,transparent),transparent 60%),
radial-gradient(90% 80% at 100% 100%,color-mix(in srgb,var(--accent) 16%,transparent),transparent 70%),var(--bg)}
.hero-bg{position:absolute;inset:-8%;z-index:-2;width:116%;height:116%;object-fit:cover;filter:blur(30px) saturate(1.2) brightness(.55)}
.hero::after{content:"";position:absolute;inset:0;z-index:-1;background:linear-gradient(to bottom,transparent 35%,var(--bg))}
.hero-inner{display:flex;align-items:flex-end;gap:2.5rem;width:100%;max-width:76rem;margin:0 auto}
.hero-poster{width:13rem;max-width:34%;border-radius:.5rem;box-shadow:0 30px 60px -20px rgba(0,0,0,.8),0 0 0 1px rgba(255,255,255,.08)}
.hero h1{margin:0;font:800 clamp(2.4rem,6.2vw,4.8rem)/1.02 var(--heading-font);letter-spacing:-.01em;color:var(--fg);
text-wrap:balance;overflow-wrap:break-word}
.hero .author{margin:.9rem 0 0;color:var(--accent);font:700 .9rem/1.3 var(--ui-font);letter-spacing:.2em;text-transform:uppercase}
.hero p{margin:.5rem 0 0;color:var(--muted);font:500 1rem/1.4 var(--ui-font)}
.opener{text-align:center;margin:0 0 2.5rem}
.opener .label{color:var(--accent);font:700 .78rem/1.2 var(--ui-font);letter-spacing:.32em;text-transform:uppercase;margin-bottom:.9rem}
.opener h2{font-size:2.2em;font-weight:800;letter-spacing:-.005em;line-height:1.12}
main h3{font-weight:700;color:var(--fg)}
.ph{transition:background-color .25s,color .25s,box-shadow .25s}
.ph.on{background:var(--phrase);color:var(--bright);box-shadow:0 0 0 .2em var(--phrase),0 0 28px var(--phrase)}
body.playing main .ph:not(.on){color:var(--dim)}
.w.on{color:var(--word);text-decoration-thickness:.12em}
@media (max-width:36rem){.hero{min-height:62vh;padding:6rem 1.1rem 2.25rem}.hero-inner{flex-direction:column;align-items:flex-start;gap:1.4rem}
.hero-poster{width:9rem;max-width:50%}.opener h2{font-size:1.75em}}
@media print{.hero{min-height:0;padding:0 0 2rem;margin:0;background:none;break-after:page}.hero-bg,.hero::after{display:none}
.hero h1{color:#000}body.playing main .ph:not(.on){color:inherit}}
"""

_KIDS_CSS = """
:root{--base:1.4rem;--base-phone:1.25rem;--leading:1.9;--measure:52ch}
main{word-spacing:.04em}
.chapter>p+p{text-indent:0;margin-top:1em}
.cover{flex-direction:column;align-items:center;text-align:center;gap:1.2rem;padding:2.5rem 1.5rem 2.75rem;
border:0;border-radius:2rem;margin:0 0 3rem;
background:radial-gradient(circle at 1.6rem 1.6rem,color-mix(in srgb,var(--who-1) 55%,transparent) 0 .55rem,transparent .6rem),
radial-gradient(circle at 3.4rem 1.2rem,color-mix(in srgb,var(--who-0) 50%,transparent) 0 .3rem,transparent .35rem),
radial-gradient(circle at calc(100% - 1.8rem) 2rem,color-mix(in srgb,var(--who-2) 55%,transparent) 0 .7rem,transparent .75rem),
radial-gradient(circle at calc(100% - 3.6rem) 1.3rem,color-mix(in srgb,var(--who-3) 45%,transparent) 0 .3rem,transparent .35rem),
radial-gradient(circle at 2rem calc(100% - 1.8rem),color-mix(in srgb,var(--who-2) 45%,transparent) 0 .4rem,transparent .45rem),
radial-gradient(circle at calc(100% - 2.2rem) calc(100% - 2rem),color-mix(in srgb,var(--who-1) 50%,transparent) 0 .55rem,transparent .6rem),
var(--card);
box-shadow:0 10px 0 -2px color-mix(in srgb,var(--accent) 18%,transparent)}
.cover img{width:11rem;max-width:60%;border-radius:1.5rem;box-shadow:0 8px 0 color-mix(in srgb,var(--fg) 12%,transparent)}
.cover h1{font-size:2.5em;font-weight:800;line-height:1.1;color:var(--accent)}
.cover .author{font-weight:700}
.cover-play{display:inline-flex;align-items:center;gap:.6rem;margin-top:.6rem;padding:.9rem 1.8rem .9rem 1.3rem;border:0;border-radius:999px;
background:var(--accent);color:var(--on-accent);font:800 1.35rem/1 var(--heading-font);cursor:pointer;
box-shadow:0 6px 0 color-mix(in srgb,var(--accent) 55%,#000);transition:transform .15s}
.cover-play:hover{transform:translateY(-2px)}
.cover-play:active{transform:translateY(3px);box-shadow:0 2px 0 color-mix(in srgb,var(--accent) 55%,#000)}
.cover-play svg{width:2rem;height:2rem;fill:currentColor}
.opener{text-align:center;margin:0 0 2rem}
.opener .label{display:inline-block;padding:.45rem 1.1rem;border-radius:999px;background:var(--who-0);color:var(--on-who-0);
font:800 .95rem/1 var(--heading-font);margin:0 0 .8rem}
section:nth-of-type(4n+2) .opener .label{background:var(--who-1);color:var(--on-who-1)}
section:nth-of-type(4n+3) .opener .label{background:var(--who-2);color:var(--on-who-2)}
section:nth-of-type(4n+4) .opener .label{background:var(--who-3);color:var(--on-who-3)}
.opener h2{font-size:2em;font-weight:800;line-height:1.15;color:var(--fg)}
main h3{font-weight:800;color:var(--accent)}
.ph{border-radius:.45em}
.ph.on{background:var(--phrase)}
/* Marked without changing its width, so the line never re-wraps as it moves. */
.w.on{color:var(--word);text-decoration-thickness:.16em;text-underline-offset:.2em;text-decoration-skip-ink:none}
#play{width:4.4rem;height:4.4rem;box-shadow:0 5px 0 color-mix(in srgb,var(--accent) 55%,#000)}
#play svg{width:2.1rem;height:2.1rem}
.player{border-radius:1.5rem 1.5rem 0 0}
@media (max-width:36rem){.cover h1{font-size:2em}.opener h2{font-size:1.6em}#play{width:3.9rem;height:3.9rem}}
@media print{.cover{background:none;box-shadow:none}.cover-play{display:none}}
"""

_SCRIPT_CSS = """
:root{--base:1.0625rem;--base-phone:1rem;--leading:1.7;--measure:62ch}
.turns main{max-width:calc(var(--measure) + 11rem)}
.chapter>p+p{text-indent:0}
.chapter>p{margin:0 0 1.15rem}
.cover{gap:1.75rem;border-bottom:2px solid var(--fg)}
.cover h1{font-size:2.2em;font-weight:700;text-transform:uppercase;letter-spacing:.02em}
.cover .author{font-family:var(--label-font);font-size:.9rem;letter-spacing:.04em}
.opener{margin:0 0 2rem;padding:.9rem 1rem;border:1px solid var(--line);border-inline-start:4px solid var(--accent);
border-radius:.4rem;background:var(--card)}
.opener .label{font:700 .78rem/1.2 var(--label-font);color:var(--accent);letter-spacing:.12em;text-transform:uppercase;margin:0 0 .35rem}
.opener h2{font:700 1.25em/1.3 var(--heading-font);text-transform:uppercase;letter-spacing:.03em}
main h3{font:700 .95em/1.35 var(--heading-font);text-transform:uppercase;letter-spacing:.06em}
p.turn{display:grid;grid-template-columns:minmax(0,9.5rem) minmax(0,1fr);gap:.2rem 1.4rem;align-items:baseline}
p.turn .who{text-align:end;text-align-last:auto;font:700 .78rem/1.5 var(--label-font);letter-spacing:.08em;text-transform:uppercase;
color:var(--who,var(--accent));overflow-wrap:anywhere;padding-top:.1em}
p.turn .said{padding-inline-start:1rem;border-inline-start:3px solid color-mix(in srgb,var(--who,var(--accent)) 55%,transparent)}
.turns section.chapter>p:not(.turn){padding-inline-start:calc(9.5rem + 1.4rem + 1rem + 3px)}
@media (max-width:36rem){
p.turn{grid-template-columns:minmax(0,1fr);gap:.2rem}
p.turn .who{text-align:start}
.turns section.chapter>p:not(.turn){padding-inline-start:0;font-style:italic;color:var(--muted)}
}
@media print{p.turn .said{border-color:#999}}
"""

_LIGHT = {"bg": "#fbfaf7", "paper": "#fbfaf7", "fg": "#211f1b", "muted": "#6d675e", "line": "#e7e2d9",
          "card": "#ffffff", "shadow": "rgba(30,25,15,.12)"}
_SEPIA = {"bg": "#f4ecd8", "paper": "#f8f0dd", "fg": "#3a2f23", "muted": "#7b6b56", "line": "#e0d3b6",
          "card": "#faf3e2", "shadow": "rgba(80,55,20,.15)"}
_DARK = {"bg": "#151517", "paper": "#1a1a1d", "fg": "#e8e6e1", "muted": "#9c978e", "line": "#2c2b30",
         "card": "#1d1d22", "shadow": "rgba(0,0,0,.45)"}

TEMPLATES = {t.id: t for t in (
    Template(
        id="classic", body_font="literata", heading_font="eb-garamond", accent="#8a2f1b",
        palettes={
            "light": {"bg": "#f3eee3", "paper": "#fcf9f2", "fg": "#2b2620", "muted": "#73685a",
                      "line": "#e3dac8", "card": "#fffdf8", "shadow": "rgba(70,50,20,.16)"},
            "sepia": {"bg": "#ece0c3", "paper": "#f7eedb", "fg": "#3a2e21", "muted": "#776550",
                      "line": "#d9c7a2", "card": "#fbf4e4", "shadow": "rgba(80,55,20,.18)"},
            "dark": {"bg": "#161412", "paper": "#1f1c18", "fg": "#ebe4d8", "muted": "#a4988a",
                     "line": "#3a332b", "card": "#25211c", "shadow": "rgba(0,0,0,.5)"},
        },
        css=_CLASSIC_CSS, label_font="heading",
    ),
    Template(
        id="modern", body_font="inter", heading_font="be-vietnam-pro", accent="#2459e0",
        body_category="sans", heading_category="sans", align="start",
        palettes={
            "light": {"bg": "#ffffff", "paper": "#ffffff", "fg": "#1b1e24", "muted": "#5d6470",
                      "line": "#e7e9ee", "card": "#f8f9fb", "shadow": "rgba(16,24,40,.07)"},
            "sepia": {"bg": "#f6efe1", "paper": "#f6efe1", "fg": "#33291d", "muted": "#776650",
                      "line": "#e4d6b9", "card": "#fbf6ea", "shadow": "rgba(80,55,20,.10)"},
            "dark": {"bg": "#0f1115", "paper": "#0f1115", "fg": "#e8eaef", "muted": "#9aa1ad",
                     "line": "#262a32", "card": "#171a20", "shadow": "rgba(0,0,0,.4)"},
        },
        css=_MODERN_CSS, phrase_alpha=0.12,
    ),
    Template(
        id="magazine", body_font="source-serif-4", heading_font="playfair-display",
        accent="#c8102e", heading_category="display", numbering="numeral",
        palettes={
            "light": {"bg": "#fbfbf8", "paper": "#fbfbf8", "fg": "#141414", "muted": "#5a5a5a",
                      "line": "#e1e1db", "card": "#ffffff", "shadow": "rgba(0,0,0,.08)"},
            "sepia": {"bg": "#f3e9d5", "paper": "#f3e9d5", "fg": "#2e2418", "muted": "#74624a",
                      "line": "#dccbaa", "card": "#f9f1e1", "shadow": "rgba(80,55,20,.12)"},
            "dark": {"bg": "#111111", "paper": "#111111", "fg": "#efefef", "muted": "#a3a3a3",
                     "line": "#2b2b2b", "card": "#1a1a1a", "shadow": "rgba(0,0,0,.5)"},
        },
        css=_MAGAZINE_CSS, standfirst=True, pull_quotes=True, italic=("heading",),
    ),
    Template(
        id="cinematic", body_font="lora", heading_font="montserrat", accent="#ffb547",
        heading_category="sans", theme="dark", align="start",
        palettes={
            "light": {"bg": "#f3f1ec", "paper": "#f3f1ec", "fg": "#17181c", "muted": "#5c5f69",
                      "line": "#dedbd3", "card": "#ffffff", "shadow": "rgba(0,0,0,.12)",
                      "dim": "#6b6e78", "bright": "#000000"},
            "sepia": {"bg": "#efe4cb", "paper": "#efe4cb", "fg": "#2f2519", "muted": "#74624a",
                      "line": "#d8c6a0", "card": "#f8efdc", "shadow": "rgba(80,55,20,.15)",
                      "dim": "#8a7860", "bright": "#1a120a"},
            "dark": {"bg": "#07080c", "paper": "#07080c", "fg": "#f5f2ea", "muted": "#a9abb6",
                     "line": "#23262f", "card": "#11131a", "shadow": "rgba(0,0,0,.6)",
                     "dim": "#8d8f99", "bright": "#ffffff"},
        },
        css=_CINEMATIC_CSS, hero=True, phrase_alpha=0.26,
    ),
    Template(
        id="kids", body_font="nunito", heading_font="baloo-2", accent="#f0542d",
        body_category="rounded", heading_category="rounded", align="start",
        palettes={
            "light": {"bg": "#fff7ea", "paper": "#fff7ea", "fg": "#2b2446", "muted": "#6a6287",
                      "line": "#f2dfc0", "card": "#ffffff", "shadow": "rgba(120,80,20,.12)",
                      "phrase": "#ffe27a"},
            "sepia": {"bg": "#f7e9cc", "paper": "#f7e9cc", "fg": "#3a2d1c", "muted": "#7a654a",
                      "line": "#e5cf9f", "card": "#fdf5e3", "shadow": "rgba(80,55,20,.15)",
                      "phrase": "#ffd96a"},
            "dark": {"bg": "#1c1830", "paper": "#1c1830", "fg": "#f6f2ff", "muted": "#b5aed1",
                     "line": "#342e52", "card": "#252041", "shadow": "rgba(0,0,0,.45)",
                     "phrase": "rgba(255,214,64,.28)"},
        },
        css=_KIDS_CSS, cover_play=True,
    ),
    Template(
        id="script", body_font="be-vietnam-pro", heading_font="jetbrains-mono", accent="#0f766e",
        body_category="sans", heading_category="mono", align="start", show_names=True,
        palettes={
            "light": {"bg": "#fbfbfa", "paper": "#fbfbfa", "fg": "#1d1d20", "muted": "#64646c",
                      "line": "#e4e4e7", "card": "#ffffff", "shadow": "rgba(0,0,0,.07)"},
            "sepia": {"bg": "#f4ecd8", "paper": "#f4ecd8", "fg": "#33291d", "muted": "#766450",
                      "line": "#e0d3b6", "card": "#faf3e2", "shadow": "rgba(80,55,20,.12)"},
            "dark": {"bg": "#131316", "paper": "#131316", "fg": "#e9e9ec", "muted": "#9d9da6",
                     "line": "#2a2a30", "card": "#1b1b1f", "shadow": "rgba(0,0,0,.45)"},
        },
        css=_SCRIPT_CSS, turns=True, for_stories=True, label_font="heading", phrase_alpha=0.12,
        # Narration is set in italic on a phone.
        italic=("body",),
    ),
)}

DEFAULT = "classic"
DEFAULT_STORIES = "script"


def template_for(template_id: Optional[str], *, story: bool = False) -> Template:
    return TEMPLATES.get(template_id or "") or TEMPLATES[DEFAULT_STORIES if story else DEFAULT]


def _font_choice(value: Optional[str], default: str) -> str:
    if value == book_fonts.SYSTEM or book_fonts.family(value) is not None:
        return value  # type: ignore[return-value]
    return default


def resolve(template_id: Optional[str] = None, *, accent: Optional[str] = None,
            body_font: Optional[str] = None, heading_font: Optional[str] = None,
            show_names: Optional[bool] = None, numbering: Optional[str] = None,
            story: bool = False) -> Design:
    """A book's design from what was asked: each choice that is missing or not
    one this app knows (a template, colour, font or numbering) is the
    template's own. A bundled font that is not installed falls back to the
    computer's fonts."""
    template = template_for(template_id, story=story)
    return Design(
        template=template,
        accent=accent.lower() if isinstance(accent, str) and _HEX_RE.fullmatch(accent)
        else template.accent,
        body_font=_font_choice(body_font, template.body_font),
        heading_font=_font_choice(heading_font, template.heading_font),
        show_names=template.show_names if show_names is None else bool(show_names),
        numbering=numbering if numbering in NUMBERING else template.numbering,
    )


def _tokens(design: Design, theme: str) -> dict:
    template = design.template
    palette = template.palettes[theme]
    background = palette["paper"]
    accent = readable(design.accent, background, 4.5)
    tokens = {k: v for k, v in palette.items()}
    tokens["accent"] = accent
    tokens["on-accent"] = on_color(accent)
    tokens["word"] = readable(accent, background, 6.0)
    tokens.setdefault("phrase", _alpha(design.accent, template.phrase_alpha * (1.6 if theme == "dark" else 1)))
    # Selected and hovered things — the chapter playing in the contents, a
    # note — in a lighter shade than the phrase being read.
    tokens["tint"] = _alpha(accent, 0.16 if theme == "dark" else 0.1)
    for i, color in enumerate(WHO_DARK if theme == "dark" else WHO_LIGHT):
        tokens[f"who-{i}"] = color
        # Text on that colour as a fill (Kids' chapter pills).
        tokens[f"on-who-{i}"] = on_color(color)
    return tokens


def _declarations(tokens: dict) -> str:
    return ";".join(f"--{k}:{v}" for k, v in tokens.items())


def theme_css(design: Design) -> str:
    """The design's colours for every theme: light on ``:root``, dark for a
    dark computer on Auto and when picked, sepia when picked. Every theme
    sets the same tokens, so :func:`print_css` can reset each of them."""
    light, sepia, dark = (_declarations(_tokens(design, t)) for t in THEMES)
    return (f":root{{{light};color-scheme:light}}"
            f"@media (prefers-color-scheme:dark){{:root:not([data-theme]){{{dark};color-scheme:dark}}}}"
            f":root[data-theme=dark]{{{dark};color-scheme:dark}}"
            f":root[data-theme=sepia]{{{sepia};color-scheme:light}}"
            f":root[data-theme=light]{{{light};color-scheme:light}}")


def print_css(design: Design) -> str:
    """Paper is white whatever the theme: every colour token reset, as
    specific as each theme rule (``:root[data-theme]`` and Auto in a dark OS)."""
    tokens = {k: "#000" for theme in THEMES for k in _tokens(design, theme)}
    tokens.update({"bg": "#fff", "paper": "#fff", "card": "#fff", "muted": "#444", "line": "#bbb",
                   "phrase": "transparent", "tint": "transparent", "shadow": "transparent",
                   "on-accent": "#fff",
                   "dim": "#000", "bright": "#000"})
    return (":root,:root[data-theme],:root:not([data-theme])"
            f"{{{_declarations(tokens)};color-scheme:light}}")


def font_css(design: Design) -> str:
    """The font families of the design as CSS custom properties."""
    template = design.template
    body = book_fonts.stack(None if design.body_font == book_fonts.SYSTEM else design.body_font,
                            template.body_category)
    heading = book_fonts.stack(
        None if design.heading_font == book_fonts.SYSTEM else design.heading_font,
        template.heading_category)
    label = {"heading": "var(--heading-font)", "body": "var(--body-font)"}.get(
        template.label_font, "var(--ui-font)")
    return (f":root{{--body-font:{body};--heading-font:{heading};--label-font:{label};"
            f"--ui-font:{book_fonts.SYSTEM_STACKS['sans']}}}")


def listing() -> list:
    """The templates as the export dialog lists them: id, what it starts with,
    and a swatch (light paper, text and accent) for its card."""
    out = []
    for t in TEMPLATES.values():
        start = t.palettes["dark" if t.theme == "dark" else "light"]
        out.append({
            "id": t.id,
            "stories": t.for_stories,
            # Whose italics the page carries too ("body", "heading").
            "italic": list(t.italic),
            "defaults": {"accent": t.accent, "body_font": t.body_font,
                         "heading_font": t.heading_font, "show_names": t.show_names,
                         "numbering": t.numbering},
            "swatch": {"bg": start["paper"], "fg": start["fg"], "accent": t.accent,
                       "line": start["line"]},
        })
    return out
