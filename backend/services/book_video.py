"""An MP4 video of a finished long-form book: its pictures as a slideshow, its
words as captions read along word by word, its audio as the sound track.

Everything comes from the book's rendered timeline (``<output>.timeline.json``,
:func:`services.audiobook.book_timeline`): when each sentence is heard, and
when each ``[image:]`` picture shows. Nothing is synthesized again.

The video is made in parts, one per picture (a *scene*), so a book of any
length holds at most two pictures in memory: each part is its picture with a
slow zoom that settles after :data:`MOTION_S` (then a still frame, which costs
almost nothing to encode), its last moments crossfading into the next picture,
and the captions of its stretch burned in (libass, timed by the book's clock).
The parts share one encoding, so they are joined without encoding again, and
the book's audio (and its chapter marks) is added last.

Captions use the app's bundled reading fonts, written out as TTF for libass
(which cannot read the bundled WOFF2): a font is never looked up on the
computer, so the video looks the same on every platform. Words are timed the
way the app's reader and the HTML book time them — each by its letters within
its sentence — so the three agree.
"""
from __future__ import annotations

import math
import os
import re
import unicodedata
from dataclasses import dataclass, field
from typing import Optional

FPS = 25
#: Length of a crossfade between two pictures.
CROSSFADE_S = 0.8
#: A picture zooms over at most this long, then holds still.
MOTION_S = 30.0
#: How far a picture zooms (6 %): enough to feel alive, never enough to lose the edges.
ZOOM = 0.06
#: Pictures are prepared this much larger than the frame so a slow zoom stays smooth.
SUPERSAMPLE = 1.5
#: A part holds still once its zoom settles only when the still stretch is at least this long.
HOLD_MIN_S = 4.0
ASPECTS = {"16:9": (16, 9), "9:16": (9, 16), "1:1": (1, 1)}
QUALITIES = (720, 1080)
#: Caption size, as a share of the frame's short side.
CAPTION_SIZES = {"s": 0.046, "m": 0.056, "l": 0.068}
#: Under ``auto``, a picture fills the frame when the two shapes are within this ratio.
AUTO_FILL_RATIO = 1.3
#: A caption shows at most this many lines (a tall frame is narrower: one more).
CAPTION_LINES = {"16:9": 2, "1:1": 2, "9:16": 3}
#: Space under the captions, as a share of the frame's height: a tall frame
#: keeps them above the controls short-video apps draw over its bottom.
CAPTION_LIFT = {"16:9": 0.075, "1:1": 0.09, "9:16": 0.17}
#: A caption stays up across a pause shorter than this, so it never blinks.
CAPTION_HOLD_S = 1.2
#: Chapter and book titles show this long.
TITLE_S = 3.5
DEFAULT_FONT = "be-vietnam-pro"
DEFAULT_ACCENT = "#ffd25a"
#: Rough bit rates (video + audio, kbit/s) used to check free disk space before a run.
EXPECTED_KBPS = {720: 700, 1080: 1300}

_HEX_RE = re.compile(r"^#[0-9a-fA-F]{6}$")


@dataclass(frozen=True)
class VideoOptions:
    aspect: str = "16:9"
    quality: int = 1080
    motion: bool = True
    transitions: bool = True
    captions: bool = True
    karaoke: bool = True
    font: Optional[str] = None
    size: str = "m"
    titles: bool = True
    accent: str = DEFAULT_ACCENT


def frame_size(aspect: str, quality: int) -> tuple[int, int]:
    """``(width, height)`` of the frame: ``quality`` is its short side; both even."""
    a, b = ASPECTS.get(aspect, ASPECTS["16:9"])
    if a >= b:
        return 2 * round(quality * a / b / 2), quality
    return quality, 2 * round(quality * b / a / 2)


# ── Scenes: which picture shows when ─────────────────────────────────────────

@dataclass(frozen=True)
class Scene:
    """From ``start`` (seconds) the picture ``name`` shows (``None``: the
    book's backdrop: its cover, or a plain one), meeting the frame by ``fit``."""
    start: float
    name: Optional[str]
    fit: str = "auto"


def scenes_of(timeline: dict) -> list[Scene]:
    """The pictures of a timeline in the order they show, the backdrop first.

    Two pictures at one moment: the later one in the script shows. The same
    picture again right after itself is not a new scene."""
    found = [Scene(0.0, None)]
    for chapter in timeline.get("chapters") or []:
        if not isinstance(chapter, dict):
            continue
        for image in chapter.get("images") or []:
            try:
                start = max(0.0, float(image["start"]))
            except (KeyError, TypeError, ValueError):
                continue
            name = image.get("name") if isinstance(image.get("name"), str) else None
            fit = image.get("fit") if image.get("fit") in ("auto", "cover", "contain") else "auto"
            found.append(Scene(start, name or None, fit))
    found.sort(key=lambda scene: scene.start)
    out: list[Scene] = []
    for scene in found:
        if out and abs(scene.start - out[-1].start) < 1e-6:
            out[-1] = scene
        elif not out or (scene.name, scene.fit) != (out[-1].name, out[-1].fit):
            out.append(scene)
    # The same picture on both sides of one that was dropped is one scene.
    merged: list[Scene] = []
    for scene in out:
        if merged and (scene.name, scene.fit) == (merged[-1].name, merged[-1].fit):
            continue
        merged.append(scene)
    return merged


@dataclass
class Part:
    """One encoded part: ``frames`` frames from frame ``first``, showing
    ``scene``; ``fade_in`` / ``fade_out`` say whether it is entered from /
    leaves into its neighbour by a crossfade (the crossfade is drawn at the
    end of the part it leaves)."""
    first: int
    frames: int
    scene: Scene
    index: int = 0
    fade_in: bool = False
    fade_out: bool = False


def plan_parts(scenes: list[Scene], duration: float, *, transitions: bool = True,
               fps: int = FPS) -> list[Part]:
    """The parts of a video ``duration`` seconds long, frame-exact: they add up
    to ``round(duration * fps)`` frames and each starts on the frame its
    picture's time falls on. A crossfade joins two parts when both are long
    enough for it to read as a change of picture rather than a flicker."""
    total = max(1, round(duration * fps))
    starts: list[tuple[int, Scene]] = []
    for scene in scenes:
        frame = min(total, max(0, round(scene.start * fps)))
        if starts and frame <= starts[-1][0]:
            starts[-1] = (starts[-1][0], scene)
            continue
        if frame >= total:
            break
        starts.append((frame, scene))
    if not starts or starts[0][0] != 0:
        starts.insert(0, (0, scenes[0] if scenes else Scene(0.0, None)))
    parts = []
    for k, (first, scene) in enumerate(starts):
        end = starts[k + 1][0] if k + 1 < len(starts) else total
        parts.append(Part(first=first, frames=end - first, scene=scene, index=k))
    fade = round(CROSSFADE_S * fps)
    if transitions:
        for left, right in zip(parts, parts[1:]):
            if left.frames > 2 * fade and right.frames > fade:
                left.fade_out = right.fade_in = True
    return parts


def crossfade_frames(fps: int = FPS) -> int:
    return round(CROSSFADE_S * fps)


# ── Captions ────────────────────────────────────────────────────────────────

def _weight(word: str) -> int:
    """A word's share of its sentence: its letters, marks and digits (the
    reader's ``[\\p{L}\\p{M}\\p{N}]``), so punctuation takes no time."""
    return sum(1 for ch in word if unicodedata.category(ch)[0] in "LMN")


def time_words(words: list[str], start: float, end: float, *, even: bool = False) -> list[tuple]:
    """``[(word, start, end), …]``: each word of a sentence heard over
    ``[start, end]`` timed by its letters (``even``: equally), as the app's
    reader and the HTML book time them."""
    weights = [_weight(w) for w in words]
    total = sum(weights)
    if even or not total:
        weights, total = [1] * len(words), len(words)
    per = max(0.0, end - start) / (total or 1)
    out, at = [], 0
    for word, weight in zip(words, weights):
        begin = start + at * per
        at += weight
        out.append((word, begin, start + at * per))
    return out


def _chunks(words: list[str], limit: int) -> list[list[int]]:
    """The word indices of each caption a sentence is shown as: at most
    ``limit`` characters each, about equal, a break after punctuation
    preferred when one is near."""
    if not words:
        return []
    length = len(" ".join(words))
    if length <= limit:
        return [list(range(len(words)))]
    count = math.ceil(length / limit)
    target = length / count
    out, current, size = [], [], 0
    for i, word in enumerate(words):
        add = len(word) + (1 if current else 0)
        full = size + add > limit
        # Near the even share: break where it is passed, or after punctuation.
        due = (size >= target * 0.85 and len(out) < count - 1
               and (size + add > target * 1.15 or words[i - 1][-1:] in ",;:"))
        if current and (full or due):
            out.append(current)
            current, size, add = [], 0, len(word)
        current.append(i)
        size += add
    if current:
        out.append(current)
    return out


@dataclass
class Cue:
    start: float
    end: float
    words: list = field(default_factory=list)  # [(word, start, end)]


def caption_cues(timeline: dict, limit: int) -> list[Cue]:
    """The book's sentences as captions of at most ``limit`` characters,
    words timed within each, each kept up across a short pause (never
    overlapping the next: a caption stack would jump)."""
    cues: list[Cue] = []
    for chapter in timeline.get("chapters") or []:
        if not isinstance(chapter, dict):
            continue
        even = chapter.get("precision") == "chapter"
        for phrase in chapter.get("phrases") or []:
            try:
                text, start, end = str(phrase["text"]), float(phrase["start"]), float(phrase["end"])
            except (KeyError, TypeError, ValueError):
                continue
            words = text.split()
            if not words or end <= start:
                continue
            timed = time_words(words, start, end, even=even)
            for group in _chunks(words, limit):
                first, last = timed[group[0]], timed[group[-1]]
                cues.append(Cue(first[1], last[2], [timed[i] for i in group]))
    cues.sort(key=lambda cue: cue.start)
    for cue, following in zip(cues, cues[1:]):
        gap = following.start - cue.end
        cue.end = following.start if gap < CAPTION_HOLD_S else cue.end + 0.3
        cue.end = min(cue.end, following.start)
    if cues:
        cues[-1].end += 0.3
    return [cue for cue in cues if cue.end > cue.start]


def caption_limit(options: VideoOptions) -> int:
    """How many characters fit one caption of this frame and size."""
    width, height = frame_size(options.aspect, options.quality)
    size = CAPTION_SIZES.get(options.size, CAPTION_SIZES["m"]) * min(width, height)
    margin = _caption_margin(width)
    per_line = max(12, int((width - 2 * margin) / (0.56 * size)))
    return int(per_line * CAPTION_LINES.get(options.aspect, 2) * 0.92)


def _caption_margin(width: int) -> int:
    return round(width * 0.07)


def _ass_time(seconds: float) -> str:
    cs = max(0, round(seconds * 100))
    return f"{cs // 360000}:{cs // 6000 % 60:02d}:{cs // 100 % 60:02d}.{cs % 100:02d}"


def _ass_text(text: str) -> str:
    """``text`` as plain ASS dialogue text: braces escaped, a backslash shown
    as itself (never read as ``\\N``/``\\h``), lines as spaces."""
    text = re.sub(r"\s+", " ", text)
    return text.replace("\\", "⧵").replace("{", "\\{").replace("}", "\\}")


def _ass_colour(hex_colour: str, alpha: int = 0) -> str:
    """``#rrggbb`` as ASS ``&HAABBGGRR``."""
    value = hex_colour if _HEX_RE.fullmatch(hex_colour or "") else DEFAULT_ACCENT
    r, g, b = value[1:3], value[3:5], value[5:7]
    return f"&H{alpha:02X}{b}{g}{r}".upper()


def karaoke_text(cue: Cue, *, karaoke: bool = True) -> str:
    """A caption's dialogue text: each word filled as it is heard (``\\kf``,
    centiseconds measured from the caption's start so rounding never drifts),
    or the plain words."""
    if not karaoke:
        return _ass_text(" ".join(word for word, _, _ in cue.words))
    parts = []
    lead = round((cue.words[0][1] - cue.start) * 100)
    for n, (word, begin, end) in enumerate(cue.words):
        a = round((begin - cue.start) * 100)
        b = round((end - cue.start) * 100)
        if n + 1 < len(cue.words):
            b = max(b, round((cue.words[n + 1][1] - cue.start) * 100))
        parts.append(f"{{\\kf{max(0, b - a)}}}{_ass_text(word)}")
    # A wait before the first word belongs to it: no space of its own.
    return (f"{{\\k{lead}}}" if lead > 0 else "") + " ".join(parts)


def title_events(timeline: dict, *, book_title: Optional[str], author: Optional[str]) -> list:
    """``[(start, end, text)]``: the book's title (and author) as the video
    opens, and each titled chapter's title as it begins (an untitled one, or
    one whose title is the book's, shows none)."""
    out = []
    book = (book_title or "").strip()
    if book:
        out.append((0.0, TITLE_S, book, (author or "").strip()))
    for chapter in timeline.get("chapters") or []:
        if not isinstance(chapter, dict) or chapter.get("untitled"):
            continue
        title = str(chapter.get("title") or "").strip()
        try:
            start = float(chapter.get("start") or 0.0)
        except (TypeError, ValueError):
            continue
        if not title or title == book or (book and start < TITLE_S):
            continue
        out.append((start, start + TITLE_S, title, ""))
    return out


def build_ass(timeline: dict, options: VideoOptions, *, font_family: str,
              book_title: Optional[str] = None, author: Optional[str] = None) -> str:
    """The video's subtitle script: its captions (when ``options.captions``)
    and its titles (when ``options.titles``), styled for the frame."""
    width, height = frame_size(options.aspect, options.quality)
    short = min(width, height)
    size = round(CAPTION_SIZES.get(options.size, CAPTION_SIZES["m"]) * short)
    margin = _caption_margin(width)
    outline = max(2, round(size * 0.07))
    shadow = max(1, round(size * 0.035))
    accent = _ass_colour(options.accent)
    white = "&H00FFFFFF"
    sung, unsung = (accent, white) if options.karaoke else (white, white)
    font = font_family.replace(",", " ")
    lines = [
        "[Script Info]",
        "ScriptType: v4.00+",
        f"PlayResX: {width}",
        f"PlayResY: {height}",
        "WrapStyle: 0",
        "ScaledBorderAndShadow: yes",
        "YCbCr Matrix: TV.709",
        "",
        "[V4+ Styles]",
        "Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, "
        "BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, "
        "BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding",
        f"Style: Caption,{font},{size},{sung},{unsung},&H00141414,&H80000000,-1,0,0,0,"
        f"100,100,0,0,1,{outline},{shadow},2,{margin},{margin},"
        f"{round(height * CAPTION_LIFT.get(options.aspect, 0.075))},1",
        f"Style: Title,{font},{round(size * 1.8)},{white},{white},&H00141414,&H80000000,-1,0,0,0,"
        f"100,100,0,0,1,{round(outline * 1.3)},{shadow},5,{margin},{margin},0,1",
        "",
        "[Events]",
        "Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text",
    ]
    if options.titles:
        for start, end, title, byline in title_events(timeline, book_title=book_title,
                                                       author=author):
            text = _ass_text(title)
            if byline:
                text += f"\\N{{\\fs{round(size * 0.9)}\\b0}}{_ass_text(byline)}"
            lines.append(f"Dialogue: 1,{_ass_time(start)},{_ass_time(end)},Title,,0,0,0,,"
                         f"{{\\fad(400,500)}}{text}")
    if options.captions:
        for cue in caption_cues(timeline, caption_limit(options)):
            lines.append(f"Dialogue: 0,{_ass_time(cue.start)},{_ass_time(cue.end)},Caption,,0,0,0,,"
                         f"{karaoke_text(cue, karaoke=options.karaoke)}")
    return "\n".join(lines) + "\n"


# ── Pictures ────────────────────────────────────────────────────────────────

def _cover_fit(image, size):
    from PIL import Image, ImageOps

    return ImageOps.fit(image, size, Image.LANCZOS)


def _contained(image, size):
    """All of ``image`` centred on a blurred, darkened copy of itself
    filling ``size``."""
    from PIL import Image, ImageEnhance, ImageFilter, ImageOps

    width, height = size
    small = ImageOps.fit(image, (max(1, width // 8), max(1, height // 8)), Image.BILINEAR)
    backdrop = small.filter(ImageFilter.GaussianBlur(max(2, width // 160)))
    backdrop = ImageEnhance.Brightness(backdrop.resize(size, Image.BILINEAR)).enhance(0.62)
    front = ImageOps.contain(image, size, Image.LANCZOS)
    backdrop.paste(front, ((width - front.width) // 2, (height - front.height) // 2))
    return backdrop


def _plain_backdrop(size, accent: str):
    """The backdrop of a book with no cover: a deep gradient warmed by its accent."""
    import numpy as np
    from PIL import Image

    width, height = size
    value = accent if _HEX_RE.fullmatch(accent or "") else DEFAULT_ACCENT
    tint = np.array([int(value[i:i + 2], 16) for i in (1, 3, 5)], dtype=np.float32)
    top = np.array([24, 26, 36], dtype=np.float32)
    bottom = np.array([10, 11, 16], dtype=np.float32)
    y = np.linspace(0.0, 1.0, height, dtype=np.float32)[:, None, None]
    x = np.linspace(-1.0, 1.0, width, dtype=np.float32)[None, :, None]
    base = top * (1 - y) + bottom * y
    glow = np.exp(-((x * 0.9) ** 2 + ((y - 0.38) * 2.2) ** 2) * 1.6) * 0.16
    pixels = base * (1 - glow) + tint * glow
    return Image.fromarray(np.clip(pixels, 0, 255).astype(np.uint8), "RGB")


def prepare_picture(source: Optional[str], fit: str, size: tuple[int, int], target: str,
                    *, accent: str = DEFAULT_ACCENT) -> None:
    """Write the frame-ready picture of a scene to ``target`` (PNG, ``size``):
    ``source`` filling the frame or whole on a blurred copy (``fit``; ``auto``
    by how close the shapes are), or the plain backdrop when there is none."""
    from PIL import Image, ImageOps

    if source is None:
        picture = _plain_backdrop(size, accent)
    else:
        with Image.open(source) as opened:
            image = ImageOps.exif_transpose(opened)
            if image.mode in ("RGBA", "LA", "PA", "P"):
                image = image.convert("RGBA")
                flat = Image.new("RGB", image.size, (16, 17, 22))
                flat.paste(image, mask=image.getchannel("A"))
                image = flat
            else:
                image = image.convert("RGB")
            if fit == "auto":
                shape = (image.width / max(1, image.height)) / (size[0] / size[1])
                fit = "cover" if 1 / AUTO_FILL_RATIO <= shape <= AUTO_FILL_RATIO else "contain"
            picture = _contained(image, size) if fit == "contain" else _cover_fit(image, size)
    picture.save(target, "PNG", compress_level=1)


def caption_shade(size: tuple[int, int], target: str) -> None:
    """A transparent PNG darkening the bottom of the frame behind the captions."""
    import numpy as np
    from PIL import Image

    width, height = size
    alpha = np.zeros((height, 1), dtype=np.float32)
    top = int(height * 0.55)
    ramp = np.linspace(0.0, 1.0, height - top, dtype=np.float32) ** 1.6
    alpha[top:, 0] = ramp * 150
    rgba = np.zeros((height, width, 4), dtype=np.uint8)
    rgba[:, :, 3] = np.repeat(alpha, width, axis=1).astype(np.uint8)
    Image.fromarray(rgba, "RGBA").save(target, "PNG", compress_level=1)


def write_fonts(font_id: Optional[str], folder: str) -> str:
    """Write the caption font's faces into ``folder`` as TTF (libass cannot
    read WOFF2) and return its family name — the bundled default when
    ``font_id`` names no bundled family. A font that cannot be written (say
    fontTools or brotli is missing from an environment not synced since they
    were added) leaves the captions to the computer's own sans-serif font
    instead of failing the video."""
    import logging

    from services import book_fonts

    family = book_fonts.family(font_id) or book_fonts.family(DEFAULT_FONT)
    if family is None:
        return "Sans"
    os.makedirs(folder, exist_ok=True)
    try:
        from fontTools.ttLib import TTFont

        for face in family.faces(italic=False):
            path = book_fonts.file_path(family.id, face.name)
            if path is None:
                continue
            font = TTFont(path)
            font.flavor = None
            font.save(os.path.join(folder, os.path.splitext(face.name)[0] + ".ttf"))
    except Exception:  # noqa: BLE001 - any font failure costs the look, never the video
        logging.getLogger("omnivoice.book_video").warning(
            "video: caption font %s could not be written; the system font stands in",
            family.id, exc_info=True)
        return "Sans"
    return family.family


# ── ffmpeg ──────────────────────────────────────────────────────────────────

def _zoom(index: int, offset: int, span: int) -> str:
    """The zoom of a scene's picture ``n`` frames after it first shows
    (``on + offset``): in on even scenes, out on odd ones, settling at ``span``."""
    progress = f"min(on+{offset},{span})/{span}"
    if index % 2 == 0:
        return f"1+{ZOOM}*{progress}"
    return f"{1 + ZOOM}-{ZOOM}*{progress}"


def _zoom_at(index: int, n: int, span: int) -> float:
    progress = min(n, span) / span
    return 1 + ZOOM * progress if index % 2 == 0 else 1 + ZOOM - ZOOM * progress


def _zoompan(z: str, frames: int, size: tuple[int, int], fps: int) -> str:
    return (f"zoompan=z='{z}':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':d={frames}"
            f":s={size[0]}x{size[1]}:fps={fps}")


def _still(frames: int, fps: int) -> str:
    return f"loop=loop={max(0, frames - 1)}:size=1:start=0,setpts=N/{fps}/TB"


def _settle(part: Part, fps: int) -> int:
    """Frames over which a part's picture zooms: from the moment it first
    shows (its crossfade in) until :data:`MOTION_S` or the part ends."""
    shown = part.frames + (crossfade_frames(fps) if part.fade_in else 0)
    return max(1, min(round(MOTION_S * fps), shown))


def part_graph(part: Part, *, size: tuple[int, int], motion: bool, shade: bool,
               subtitles: Optional[str], fonts: str, next_part: Optional[Part] = None,
               fps: int = FPS) -> str:
    """The filter graph of one part. Inputs: ``0`` its picture, ``1`` the next
    scene's (when it fades out into ``next_part``), then the caption shade
    (when ``shade``).
    Output ``[out]``: exactly ``part.frames`` frames, the captions of its
    stretch burned in by the book's clock (``subtitles``: the ASS file)."""
    fade = crossfade_frames(fps)
    offset = fade if part.fade_in else 0
    steps = []
    if motion:
        settle = _settle(part, fps)
        moving = max(0, settle - offset)  # its own frames still zooming
        if part.frames - moving >= HOLD_MIN_S * fps and moving > 0:
            hold = part.frames - moving
            final = _zoom_at(part.index, moving - 1 + offset, settle)
            steps += [
                "[0:v]split=2[p0][p1]",
                f"[p0]{_zoompan(_zoom(part.index, offset, settle), moving, size, fps)},setsar=1[m0]",
                f"[p1]{_zoompan(f'{final:.6f}', 1, size, fps)},{_still(hold, fps)},setsar=1[m1]",
                f"[m0][m1]concat=n=2:v=1:a=0,fps={fps}[a]",
            ]
        elif moving > 0:
            steps.append(f"[0:v]{_zoompan(_zoom(part.index, offset, settle), part.frames, size, fps)}"
                         ",setsar=1[a]")
        else:
            final = _zoom_at(part.index, settle, settle)
            steps.append(f"[0:v]{_zoompan(f'{final:.6f}', 1, size, fps)},{_still(part.frames, fps)}"
                         f",fps={fps},setsar=1[a]")
    else:
        steps.append(f"[0:v]{_still(part.frames, fps)},fps={fps},setsar=1[a]")
    current = "[a]"
    shade_input = 1
    if part.fade_out:
        shade_input = 2
        if motion:
            # The next picture starts its zoom here, as its own part goes on with it.
            following = next_part or Part(first=0, frames=fade + 1, scene=part.scene,
                                          index=part.index + 1, fade_in=True)
            incoming = _zoompan(_zoom(following.index, 0, _settle(following, fps)),
                                fade, size, fps)
            steps.append(f"[1:v]{incoming},setsar=1[b]")
        else:
            steps.append(f"[1:v]{_still(fade, fps)},fps={fps},setsar=1[b]")
        steps.append(f"{current}[b]xfade=transition=fade:duration={fade / fps:.6f}"
                     f":offset={(part.frames - fade) / fps:.6f}[c]")
        current = "[c]"
    if shade:
        steps.append(f"{current}[{shade_input}:v]overlay=0:0[d]")
        current = "[d]"
    tail = (f"{current}format=yuv420p,trim=end_frame={part.frames},"
            f"setpts=PTS-STARTPTS+{part.first}/{fps}/TB")
    if subtitles:
        tail += f",ass=filename={subtitles}:fontsdir={fonts}"
    steps.append(tail + ",setpts=PTS-STARTPTS[out]")
    return ";\n".join(steps)


#: The video encoding every part shares, so they join without encoding again.
VIDEO_CODEC_ARGS = ["-c:v", "libx264", "-preset", "veryfast", "-tune", "stillimage",
                    "-crf", "23", "-pix_fmt", "yuv420p", "-profile:v", "high"]


def part_cmd(ffmpeg: str, part: Part, *, picture: str, next_picture: Optional[str],
             shade: Optional[str], graph_file: str, output: str, progress: str,
             fps: int = FPS) -> list[str]:
    """The argv encoding one part (paths relative to the run's folder)."""
    from services.ffmpeg_utils import local_inputs_only

    cmd = [ffmpeg, "-hide_banner", "-nostdin", "-loglevel", "error", "-y", "-i", picture]
    if part.fade_out and next_picture:
        cmd += ["-i", next_picture]
    if shade:
        cmd += ["-i", shade]
    cmd += ["-filter_complex_script", graph_file, "-map", "[out]", *VIDEO_CODEC_ARGS,
            "-r", str(fps), "-g", str(fps * 10), "-an", "-progress", progress, "-nostats", output]
    return local_inputs_only(cmd, tool="ffmpeg")


def mux_cmd(ffmpeg: str, *, parts_list: str, audio: str, output: str,
            title: Optional[str] = None) -> list[str]:
    """The argv joining the parts (no new encoding) with the book's audio and
    its chapter marks. AAC audio (``.m4b``/``.m4a``) is copied; anything else
    is encoded to AAC."""
    from services.ffmpeg_utils import local_inputs_only

    copy = os.path.splitext(audio)[1].lower() in (".m4b", ".m4a", ".aac")
    cmd = [ffmpeg, "-hide_banner", "-nostdin", "-loglevel", "error", "-y",
           "-f", "concat", "-safe", "0", "-i", parts_list, "-i", audio,
           "-map", "0:v:0", "-map", "1:a:0", "-map_chapters", "1", "-c:v", "copy"]
    cmd += ["-c:a", "copy"] if copy else ["-c:a", "aac", "-b:a", "192k"]
    if title:
        cmd += ["-metadata", f"title={title[:300]}"]
    cmd += ["-shortest", "-movflags", "+faststart", output]
    return local_inputs_only(cmd, tool="ffmpeg")


def read_progress_frame(path: str) -> int:
    """The last ``frame=`` an ffmpeg ``-progress`` file reports (0 when none yet)."""
    try:
        with open(path, "rb") as fh:
            fh.seek(0, os.SEEK_END)
            size = fh.tell()
            fh.seek(max(0, size - 4096))
            tail = fh.read().decode("ascii", "ignore")
    except OSError:
        return 0
    found = re.findall(r"(?m)^frame=(\d+)\s*$", tail)
    return int(found[-1]) if found else 0


# ── A run ───────────────────────────────────────────────────────────────────

class VideoFailed(RuntimeError):
    """A video that could not be made; ``code`` names why for the app."""

    def __init__(self, code: str, message: str):
        super().__init__(message)
        self.code = code


#: Seconds between two progress events while a part encodes.
PROGRESS_EVERY_S = 0.5


async def render_video(*, ffmpeg: str, audio: str, timeline: dict, options: VideoOptions,
                       workdir: str, output: str, picture_path, cover: Optional[str] = None,
                       book_title: Optional[str] = None, author: Optional[str] = None,
                       job_id: Optional[str] = None, runner=None):
    """Make the video of a book, yielding what it is doing.

    Events: ``{"type": "start", "frames", "parts", "missing"}`` (``missing``:
    pictures the script names that the library no longer has — the picture
    before each shows on), then ``{"type": "progress", "frame", "frames",
    "percent"}`` as parts encode, then ``{"type": "finishing"}`` while the
    parts are joined with the audio. Raises :class:`VideoFailed`.

    ``picture_path(name)`` finds a library picture (``None`` when gone);
    ``cover`` is the book's cover, the backdrop when there is one. ``runner``
    (tests) stands in for :func:`services.ffmpeg_utils.run_ffmpeg`. Everything
    is made in ``workdir`` (which the caller creates and removes)."""
    import asyncio

    if runner is None:
        from services.ffmpeg_utils import run_ffmpeg as runner

    size = frame_size(options.aspect, options.quality)
    duration = float(timeline.get("duration") or 0.0)
    if duration <= 0:
        raise VideoFailed("video_empty_book", "The book has no audio to make a video of.")
    scenes, missing = [], []
    for scene in scenes_of(timeline):
        if scene.name is not None and picture_path(scene.name) is None:
            if scene.name not in missing:
                missing.append(scene.name)
            continue  # the picture before it shows on
        scenes.append(scene)
    parts = plan_parts(scenes, duration, transitions=options.transitions)
    frames = sum(part.frames for part in parts)
    yield {"type": "start", "frames": frames, "parts": len(parts), "missing": missing}

    scale = SUPERSAMPLE if options.motion else 1.0
    picture_size = (2 * round(size[0] * scale / 2), 2 * round(size[1] * scale / 2))
    pictures: dict = {}

    def picture_for(scene: Scene) -> str:
        key = (scene.name, scene.fit)
        if key not in pictures:
            name = f"picture-{len(pictures)}.png"
            source = picture_path(scene.name) if scene.name else cover
            prepare_picture(source, scene.fit, picture_size, os.path.join(workdir, name),
                            accent=options.accent)
            pictures[key] = name
        return pictures[key]

    subtitles = None
    fonts = "fonts"
    if options.captions or options.titles:
        family = await asyncio.to_thread(write_fonts, options.font, os.path.join(workdir, fonts))
        script = build_ass(timeline, options, font_family=family, book_title=book_title,
                           author=author)
        if "\nDialogue:" in script:
            subtitles = "captions.ass"
            with open(os.path.join(workdir, subtitles), "w", encoding="utf-8") as fh:
                fh.write(script)
    shade = None
    if options.captions and subtitles:
        shade = "shade.png"
        await asyncio.to_thread(caption_shade, size, os.path.join(workdir, shade))

    done = 0
    names = []
    for k, part in enumerate(parts):
        following = parts[k + 1] if k + 1 < len(parts) else None
        picture = await asyncio.to_thread(picture_for, part.scene)
        next_picture = (await asyncio.to_thread(picture_for, following.scene)
                        if part.fade_out and following else None)
        graph = part_graph(part, size=size, motion=options.motion, shade=bool(shade),
                           subtitles=subtitles, fonts=fonts, next_part=following)
        graph_file = f"part-{k}.graph"
        progress = f"part-{k}.progress"
        name = f"part-{k}.mp4"
        with open(os.path.join(workdir, graph_file), "w", encoding="utf-8") as fh:
            fh.write(graph)
        cmd = part_cmd(ffmpeg, part, picture=picture, next_picture=next_picture, shade=shade,
                       graph_file=graph_file, output=name, progress=progress)
        task = asyncio.ensure_future(runner(cmd, timeout=max(600.0, part.frames / FPS * 20),
                                            capture=False, job_id=job_id, cwd=workdir))
        try:
            while True:
                finished, _ = await asyncio.wait({task}, timeout=PROGRESS_EVERY_S)
                frame = min(part.frames, read_progress_frame(os.path.join(workdir, progress)))
                yield {"type": "progress", "frame": done + frame, "frames": frames,
                       "percent": round(100 * (done + frame) / frames, 1)}
                if finished:
                    break
        finally:
            if not task.done():
                task.cancel()
                await asyncio.gather(task, return_exceptions=True)
        rc, _, err = task.result()
        if rc != 0:
            _log_ffmpeg_error("part", err)
            raise VideoFailed("video_encode_failed",
                              "ffmpeg could not encode the video. The backend log says why.")
        done += part.frames
        names.append(name)
        # A part's picture files are not needed once it and the next are made.
    with open(os.path.join(workdir, "parts.txt"), "w", encoding="utf-8") as fh:
        fh.write("".join(f"file '{name}'\n" for name in names))
    yield {"type": "finishing"}
    rc, _, err = await runner(mux_cmd(ffmpeg, parts_list="parts.txt", audio=audio, output=output,
                                      title=book_title),
                              timeout=max(600.0, duration), capture=False, job_id=job_id,
                              cwd=workdir)
    if rc != 0:
        _log_ffmpeg_error("join", err)
        raise VideoFailed("video_mux_failed",
                          "ffmpeg could not add the audio to the video. The backend log says why.")


def _log_ffmpeg_error(step: str, err) -> None:
    """ffmpeg's own words go to the log only: they can hold local paths."""
    import logging

    text = err.decode("utf-8", "replace") if isinstance(err, (bytes, bytearray)) else str(err or "")
    lines = [line.strip() for line in text.splitlines() if line.strip()]
    logging.getLogger("omnivoice.book_video").warning(
        "video %s: ffmpeg failed: %s", step, " | ".join(lines[-4:])[:800] or "(no output)")


def missing_tools(ffmpeg: str) -> Optional[list[str]]:
    """What this ffmpeg lacks for a video: ``libx264`` (the H.264 encoder),
    ``ass`` (burning captions with libass), ``zoompan`` and ``xfade``. Empty
    when it has them all; None when it could not be asked (it would not run,
    took too long, or listed nothing) — no reason to refuse a video, and no
    answer to keep."""
    import subprocess

    lacking = []
    try:
        encoders = subprocess.run([ffmpeg, "-hide_banner", "-encoders"], capture_output=True,
                                  text=True, timeout=30).stdout
        filters = subprocess.run([ffmpeg, "-hide_banner", "-filters"], capture_output=True,
                                 text=True, timeout=30).stdout
    except (OSError, subprocess.SubprocessError):
        return None
    if not encoders.strip() or not filters.strip():
        return None
    if not re.search(r"(?m)^\s*V\S*\s+libx264\s", encoders):
        lacking.append("libx264")
    for name in ("ass", "zoompan", "xfade"):
        if not re.search(rf"(?m)^\s*\S+\s+{name}\s", filters):
            lacking.append(name)
    return lacking


def expected_bytes(duration: float, quality: int) -> int:
    """About how large the video will be (for the free-space check)."""
    return int(duration * EXPECTED_KBPS.get(quality, EXPECTED_KBPS[1080]) * 1000 / 8)
