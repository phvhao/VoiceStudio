"""Phrase-by-phrase long-form rendering and the opt-in speech check.

A masked, non-autoregressive engine renders a long take with near-identical
clauses by copying one clause into another's slot and dropping a third (a
user's four-seasons paragraph came back as Summer, Summer, Winter). These pin
the fix: each sentence/clause is its own take joined with a chosen silence per
punctuation mark, and an opt-in check retakes phrases whose transcript does
not match the script.
"""
from __future__ import annotations

import pytest

torch = pytest.importorskip("torch")

from services.audiobook import (  # noqa: E402
    ExpressiveOptions,
    Span,
    parse_audiobook_script,
    synthesize_chapter,
)
from services.chunked_tts import (  # noqa: E402
    DEFAULT_PUNCTUATION_PAUSES,
    join_phrases,
    split_into_phrases,
)
from services.speech_verify import SpeechVerifier, comparable, match_score  # noqa: E402

SEASONS = (
    "Ẩn dụ trung tâm là bốn mùa: MÙA XUÂN là cơ hội gieo hạt (hành động, học tập); "
    "MÙA HẠ là thời gian bảo vệ, chống lại sâu bọ; MÙA THU là vụ thu hoạch — tấm "
    "gương trung thực; MÙA ĐÔNG là nghịch cảnh chắc chắn sẽ tới."
)


def test_each_clause_of_a_parallel_list_is_its_own_take():
    phrases = split_into_phrases(SEASONS)
    texts = [text for text, _ in phrases]
    assert texts == [
        "Ẩn dụ trung tâm là bốn mùa:",
        "MÙA XUÂN là cơ hội gieo hạt (hành động, học tập);",
        "MÙA HẠ là thời gian bảo vệ, chống lại sâu bọ;",
        "MÙA THU là vụ thu hoạch —",
        "tấm gương trung thực;",
        "MÙA ĐÔNG là nghịch cảnh chắc chắn sẽ tới.",
    ]
    d = DEFAULT_PUNCTUATION_PAUSES
    assert [ms for _, ms in phrases] == [
        d["colon"], d["semicolon"], d["semicolon"], d["dash"], d["semicolon"], 0,
    ]


def test_pauses_are_set_per_mark_and_the_last_phrase_leaves_the_gap_to_the_caller():
    phrases = split_into_phrases("One. Two... Three; four: five, six!",
                                 {"sentence": 700, "ellipsis": 900, "comma": 50},
                                 split_commas=True)
    assert phrases == [("One.", 700), ("Two...", 900), ("Three;", 250),
                       ("four:", 250), ("five,", 50), ("six!", 0)]



def test_a_line_break_ends_a_phrase_like_a_full_stop():
    d = DEFAULT_PUNCTUATION_PAUSES
    text = "\n".join([
        "Three pillars:", "(1) change yourself", "(2) attitude is everything", "",
        "(3) sow and reap",
    ])
    assert split_into_phrases(text) == [
        ("Three pillars:", d["colon"]),
        ("(1) change yourself", d["sentence"]),
        ("(2) attitude is everything", d["sentence"]),
        ("(3) sow and reap", 0),
    ]


def test_a_line_ending_on_its_own_mark_keeps_that_pause_and_is_not_paused_twice():
    d = DEFAULT_PUNCTUATION_PAUSES
    assert split_into_phrases("\n".join(["Hello,", "friend.", "Bye.", ""])) == [
        ("Hello,", d["comma"]), ("friend.", d["sentence"]), ("Bye.", 0),
    ]

@pytest.mark.parametrize("text", [
    "Dr. Smith arrived.",                 # abbreviation
    "It costs 3.5 dollars.",              # decimal
    "Meet at 10:30 sharp.",               # clock time
    "About 1,000 people.",                # thousands separator
    "Sow–reap is the law.",          # joined dash
    "She laughed [sigh. no] then left.",  # never inside a [tag]
    "Commas, by default, stay inside.",   # commas only on request
])
def test_marks_that_do_not_end_a_phrase(text):
    assert [t for t, _ in split_into_phrases(text)] == [text]


def test_closing_quotes_stay_with_their_sentence():
    assert [t for t, _ in split_into_phrases('He said "Go." Then left.')] == [
        'He said "Go."', "Then left.",
    ]


def test_no_space_scripts_split_on_fullwidth_marks():
    text = "你好。世界！"
    assert [t for t, _ in split_into_phrases(text)] == ["你好。", "世界！"]


def test_an_overlong_phrase_is_cut_at_a_comma_with_the_comma_pause():
    clause = "word " * 30
    text = f"{clause.strip()}, {clause.strip()}."
    phrases = split_into_phrases(text, {"comma": 77}, max_chars=200)
    assert len(phrases) == 2
    assert phrases[0][0].endswith(",") and phrases[0][1] == 77
    assert all(len(t) <= 200 for t, _ in phrases)


def test_join_puts_the_chosen_silence_at_each_boundary_and_keeps_outer_edges():
    sr = 1000
    take = torch.cat([torch.zeros(100), torch.ones(300), torch.zeros(100)])  # 500 samples
    out = join_phrases([take, take], sr, [250, 0])
    # Inner edges trimmed to the 40 ms keep (100 → 40), outer ones untouched,
    # plus exactly the 250 ms chosen pause between them.
    assert out.shape[-1] == (100 + 300 + 40) + 250 + (40 + 300 + 100)
    trimmed = join_phrases([take, take], sr, [250, 0], trim_edges=True)
    assert trimmed.shape[-1] == (40 + 300 + 40) * 2 + 250


def _recording_synth(calls, length=200):
    def synth(text, voice_id, speed=None):
        calls.append(text)
        return torch.ones(length)
    return synth


def test_phrase_rendering_sends_each_clause_separately_with_its_pauses():
    calls = []
    plan = parse_audiobook_script(SEASONS)
    pauses = dict(DEFAULT_PUNCTUATION_PAUSES)
    audio, _ = synthesize_chapter(plan.chapters[0].spans, _recording_synth(calls), 1000,
                                  punctuation_pauses=pauses)
    assert len(calls) == 6 and calls[1].startswith("MÙA XUÂN")
    expected_silence = sum(ms for _, ms in split_into_phrases(SEASONS, pauses))
    assert audio.shape[-1] == 6 * 200 + expected_silence


def test_without_phrase_rendering_a_paragraph_is_still_one_take():
    calls = []
    plan = parse_audiobook_script(SEASONS)
    synthesize_chapter(plan.chapters[0].spans, _recording_synth(calls), 1000)
    assert calls == [plan.chapters[0].spans[0].text]


def test_phrase_pauses_count_against_the_chapter_silence_budget():
    spans = [Span(voice_id=None, text="A. " * 400, pause_ms_after=0)]
    with pytest.raises(ValueError, match="15 minutes"):
        synthesize_chapter(spans, _recording_synth([]), 1000,
                           punctuation_pauses={"sentence": 5000})


def test_default_options_keep_their_cache_signature_and_manifest_round_trips():
    assert ExpressiveOptions().cache_signature() == ""
    opts = ExpressiveOptions(punctuation_pauses=(("comma", 90), ("sentence", 300)),
                             split_commas=True, verify_speech=True)
    assert ExpressiveOptions.from_manifest(opts.to_manifest()) == opts
    assert opts.join_kwargs()["punctuation_pauses"] == {"comma": 90, "sentence": 300}


# ── speech check ─────────────────────────────────────────────────────────────

def test_comparison_ignores_tone_marks_tags_and_punctuation():
    assert comparable("MÙA HẠ là [laughter] đời!") == comparable("mua ha la doi")
    assert match_score("Mùa Hạ là thời gian bảo vệ", "mùa hà là thời gian bảo vệ") == 1.0
    swapped = match_score(
        "MÙA XUÂN là cơ hội ngắn ngủi để gieo hạt hành động học tập",
        "Mùa Hạ là thời gian bảo vệ và nuôi dưỡng những gì đã hạt hành động học tập",
    )
    assert swapped < 0.8


class _Take:
    def __init__(self, label):
        self.label = label
        self.shape = (1, 100)


def test_a_mismatched_take_is_retaken_and_the_best_take_kept():
    heard = {"bad": "something else entirely", "good": "the lamp held for forty years"}
    takes = iter([_Take("bad"), _Take("good")])
    verifier = SpeechVerifier(24000, transcribe=lambda audio, sr: heard[audio.label])
    chosen = verifier.render("The lamp held for forty years.", lambda attempt: next(takes))
    assert chosen.label == "good"
    assert verifier.stats() == {"checked": 1, "retaken": 1, "suspect": [], "unavailable": False}


def test_a_phrase_that_keeps_failing_is_reported_once_retries_run_out():
    attempts = []
    verifier = SpeechVerifier(24000, transcribe=lambda audio, sr: "nothing alike here")
    verifier.render("The lamp held for forty years.",
                    lambda attempt: attempts.append(attempt) or _Take("x"))
    assert attempts == [0, 1, 2]
    assert verifier.suspect and verifier.suspect[0]["text"].startswith("The lamp")


def test_no_working_recognizer_turns_the_check_off_without_failing():
    calls = []
    verifier = SpeechVerifier(24000, transcribe=lambda audio, sr: calls.append(1))
    for _ in range(3):
        verifier.render("The lamp held for forty years.", lambda attempt: _Take("x"))
    assert verifier.unavailable and len(calls) == 2


def test_short_phrases_are_not_judged():
    verifier = SpeechVerifier(24000, transcribe=lambda audio, sr: pytest.fail("checked"))
    verifier.render("Yes.", lambda attempt: _Take("x"))
    assert verifier.checked == 0


def test_retakes_reach_a_synth_that_accepts_attempt():
    seen = []

    def synth(text, voice_id, speed=None, attempt=0):
        seen.append(attempt)
        return torch.ones(200)

    verifier = SpeechVerifier(1000, transcribe=lambda audio, sr: "unrelated words entirely")
    spans = [Span(voice_id=None, text="The lamp held for forty years.", pause_ms_after=0)]
    synthesize_chapter(spans, synth, 1000, verifier=verifier)
    assert seen == [0, 1, 2]


def test_a_retake_changes_the_seed_but_not_the_first_take():
    from api.routers.audiobook import _retake_seed_input

    counter = iter(range(100))
    first = _retake_seed_input("Hello.", 0, lambda: next(counter))
    assert first == ("Hello.", 0)
    retake = _retake_seed_input("Hello.", 1, lambda: pytest.fail("counter advanced"))
    assert retake != first and retake[1] == 0


def test_request_without_the_new_fields_renders_exactly_as_before():
    from api.routers.audiobook import AudiobookPreviewRequest, _expressive_opts

    assert _expressive_opts(AudiobookPreviewRequest(text="x")).is_default
    opts = _expressive_opts(AudiobookPreviewRequest(text="x", punctuation_pauses={"comma": 90}))
    assert dict(opts.punctuation_pauses) == {**DEFAULT_PUNCTUATION_PAUSES, "comma": 90}


def test_the_app_and_the_server_share_one_set_of_default_pauses():
    """The settings panel shows the JS defaults and sends them; the server fills
    omitted families from its own. Both must be the same numbers."""
    import pathlib
    import re

    js = (pathlib.Path(__file__).resolve().parents[1] / "electron" / "src" / "shared"
          / "utils" / "longformOverrides.js").read_text(encoding="utf-8")
    block = re.search(r"DEFAULT_PUNCTUATION_PAUSES = \{(.*?)\};", js, re.S).group(1)
    app = {key: int(value) for key, value in re.findall(r"(\w+):\s*(\d+)", block)}
    assert app == DEFAULT_PUNCTUATION_PAUSES
