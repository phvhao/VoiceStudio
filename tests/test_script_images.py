"""``[image: NAME]`` script tags: display only, never spoken, never a cache key.

The tag is taken out of the text before the parser reads it, so a script with
pictures parses (spans, joins, every cache key) exactly as it would without
them; the span read where a tag stood carries ``images`` for the rendered
timeline, which says when each picture shows (the slideshow and the video).
"""
import importlib

import pytest

SR = 1000


def _mod(name):
    return importlib.import_module(name)


@pytest.fixture(autouse=True)
def _cut_at_marks_only(monkeypatch):
    """Phrases cut at every mark, as the timeline tests pin them; joining short
    phrases is tested on its own in test_phrase_rendering.py."""
    from services import chunked_tts

    monkeypatch.setattr(chunked_tts, "PHRASE_MIN_CHARS", 0)


def _without_images(chapters):
    return [{**c, "spans": [{k: v for k, v in s.items() if k != "images"} for s in c["spans"]]}
            for c in chapters]


@pytest.mark.parametrize("script, bare", [
    ("# One\nA.\n[image: dawn.jpg]\nB.\n\nC [slow]d[/slow]\n## S [image: s.png]\ne",
     "# One\nA.\nB.\n\nC [slow]d[/slow]\n## S\ne"),
    ("[image: a.jpg]\n# One\n[voice:X]\n[image: b.jpg contain]\nHi. [pause 1s] [image: c.jpg] Bye.",
     "# One\n[voice:X]\nHi. [pause 1s] Bye."),
    ("Mid [image: m.jpg] sentence [[Nguyen|Win]].\n\n[image: none]\n\nNext.",
     "Mid sentence [[Nguyen|Win]].\n\n\nNext."),
])
def test_pictures_change_no_span_and_no_cache_key(script, bare):
    parser = _mod("services.longform_parser")
    ab = _mod("services.audiobook")
    router = _mod("api.routers.audiobook")
    for layout in (False, True):
        tagged = parser.parse_script_to_spans(script, default_voice="v", layout=layout)
        plain = parser.parse_script_to_spans(bare, default_voice="v", layout=layout)
        assert _without_images(tagged) == plain
        assert any("images" in s for c in tagged for s in c["spans"])
    tagged = ab.parse_audiobook_script(script, default_voice="v").chapters
    plain = ab.parse_audiobook_script(bare, default_voice="v").chapters
    for a, b in zip(tagged, plain):
        assert [router._span_key_tuple(router._spoken_span(s, None)) for s in a.spans] == \
            [router._span_key_tuple(router._spoken_span(s, None)) for s in b.spans]
    # Never spoken: no span text keeps any part of a tag.
    assert not any("image" in s.text for c in tagged for s in c.spans)


def test_pictures_survive_the_resume_manifest():
    ab = _mod("services.audiobook")
    spans = ab.parse_audiobook_script("# One\nA.\n[image: x.jpg contain]\nB.").chapters[0].spans
    assert spans[0].images == [{"at": 3, "name": "x.jpg", "fit": "contain"}]
    assert [ab.Span(**s.to_dict()) for s in spans] == spans
    assert "images" not in ab.Span(voice_id="v", text="A.").to_dict()


def test_story_plan_carries_pictures_of_silent_lines_and_takes_tags_out():
    router = _mod("api.routers.audiobook")
    chapter = router.LongformChapter(title="", spans=[
        {"voice_id": "v", "text": "", "pause_ms_after": 0,
         "images": [{"at": 0, "name": "dawn.jpg"}]},
        {"voice_id": "v", "text": "", "pause_ms_after": 400,
         "images": [{"at": 0, "name": "pause.jpg", "fit": "contain"}]},
        {"voice_id": "v", "text": "Once [image: left.png] upon.", "pause_ms_after": 0},
        {"voice_id": "v", "text": "", "pause_ms_after": 0, "images": [{"at": 0, "name": None}]},
    ])
    plan = router._story_chapter(chapter)
    texts = [s.text for s in plan.spans]
    assert texts == ["", "Once upon."]
    assert plan.spans[0].images is None  # a pause shows nothing of its own
    assert plan.spans[1].images == [
        {"at": 0, "name": "dawn.jpg", "fit": "auto"},
        {"at": 0, "name": "pause.jpg", "fit": "contain"},
        {"at": 5, "name": "left.png", "fit": "auto"},  # from "upon"
        {"at": 10, "name": None, "fit": "auto"},  # after everything: from its end
    ]


def test_timeline_says_when_each_picture_shows():
    ab = _mod("services.audiobook")
    Chapter, Span = ab.Chapter, ab.Span
    split = ab.ExpressiveOptions(punctuation_pauses=tuple(sorted(
        {"sentence": 300, "comma": 120, "semicolon": 250, "colon": 250, "dash": 200,
         "ellipsis": 500}.items())))
    ch1 = Chapter(title="One", spans=[
        Span(voice_id="v", text="Hello there. Bye.", images=[
            {"at": 0, "name": "a.jpg", "fit": "cover"},
            {"at": 8, "name": "b.jpg", "fit": "contain"},   # inside "there"
            {"at": 13, "name": "c.jpg", "fit": "cover"},    # "Bye." starts
        ]),
        Span(voice_id="v", text="Hi there.", images=[
            {"at": 9, "name": "late.jpg", "fit": "cover"},  # its end: the next chapter's
        ]),
    ])
    ch2 = Chapter(title="Two", spans=[
        Span(voice_id="v", text="Old chapter."),
        Span(voice_id="v", text="More.", break_before="paragraph",
             images=[{"at": 0, "name": None, "fit": "cover"}]),
    ])
    ch3 = Chapter(title="Three", spans=[Span(voice_id="v", text="Plain.")])
    doc1 = {"version": 1, "sample_rate": SR, "samples": 3000, "phrases": True, "spans": [
        {"span": 0, "start": 0, "end": 1500, "units": [[0, 41, 700], [1, 1000, 1500]]},
        {"span": 1, "start": 1800, "end": 3000, "units": [[0, 1800, 2950]]},
    ]}
    tl = ab.book_timeline("audiobook_x.m4b", [(ch1, 3.0, doc1), (ch2, 2.5, None),
                                              (ch3, 1.0, None)], opts=split)
    one, two, three = tl["chapters"]
    assert one["images"] == [
        {"phrase": 0, "start": 0.041, "name": "a.jpg", "fit": "cover"},
        # 7 of the 11 characters of "Hello there." are before it.
        {"phrase": 0, "start": round(0.041 + (0.7 - 0.041) * 7 / 11, 3), "name": "b.jpg",
         "fit": "contain"},
        {"phrase": 1, "start": 1.0, "name": "c.jpg", "fit": "cover"},
    ]
    # Untimed chapter: the carried picture from its first entry, the other from
    # the entry its span is read in.
    assert [(i["name"], i["phrase"], i["start"]) for i in two["images"]] == [
        ("late.jpg", 0, 3.0), (None, 1, two["phrases"][1]["start"])]
    # A chapter without pictures says nothing about them (the dict is as before).
    assert "images" not in three


def test_laid_out_moves_picture_entries_with_the_phrases():
    ab = _mod("services.audiobook")
    old = {"version": 1, "output": "a.m4b", "duration": 2.0, "chapters": [{
        "title": "One", "start": 0, "end": 2.0, "precision": "phrase", "sections": [],
        "phrases": [{"text": "A. B.", "start": 0.0, "end": 1.0, "voice": None},
                    {"text": "C.", "start": 1.0, "end": 2.0, "voice": None}],
        "images": [{"phrase": 1, "start": 1.0, "name": "x.jpg", "fit": "cover"}]}]}
    laid = ab.timeline_with_layout(old, "A.\nB.\nC.")
    phrases = laid["chapters"][0]["phrases"]
    assert [p["text"] for p in phrases] == ["A.", "B.", "C."]
    assert laid["chapters"][0]["images"][0]["phrase"] == 2
