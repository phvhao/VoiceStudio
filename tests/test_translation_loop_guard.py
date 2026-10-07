"""Translators stuck in a loop: decode guards, the repetition check and its flag.

NLLB-200's greedy search answered a Japanese "No, no, that is not so" with
"No, no, no, no, ..." up to its 400-token limit (English and Vietnamese
alike, whether the line was split into sentences or not), and beam search
looped on other short lines: 20-80 s of CPU per line, and the line's meaning
was gone. Every NLLB pass now decodes under a loop guard that bans only
the token starting one back-to-back copy too many — too many for that line,
whose own repetition it may repeat (half again, at least four copies), and
counted without case — and every translator's
output goes through the repetition check, which flags a line still stuck in
a loop as possibly missing content ("repeated"), with Translate again.

CJK sample text is written as escapes.
"""
from __future__ import annotations

import pytest

from services.translation_sentences import looped_repeats, omission_verdict, repeat_allowance

#: The reported line: "No, no, that is not so" in Japanese.
_JA_NO_NO = (
    "\u3044\u3084\u3044\u3084\u3001\u305d\u3093\u306a\u3053\u3068"
    "\u306a\u3044\u3067\u3059\u3088\u3002"
)
#: What greedy NLLB made of it, shortened: the loop ran to the length limit.
_EN_LOOP = "No, " * 99 + "no,"
_VI_LOOP = "Không, " * 79 + "kh"


# -- The repetition check ---------------------------------------------------


@pytest.mark.parametrize("translation", [_EN_LOOP, _VI_LOOP])
def test_a_translation_stuck_in_a_loop_is_flagged_as_repeated(translation):
    verdict = omission_verdict(_JA_NO_NO, translation, "ja", "en")
    assert verdict["reason"] == "repeated"
    assert verdict["repeats"] >= 79
    assert verdict["source_sentences"] == 1 and verdict["target_sentences"] == 1


@pytest.mark.parametrize("source, translation", [
    # Complete NLLB translations that repeat a word as the line does.
    (_JA_NO_NO, "No, no, it's not like that."),
    ("No, no, no, that's not what I meant.",
     "Không, không, không, không, đó không phải là "
     "điều tôi muốn nói."),
    # What NLLB says under its loop guard: five copies at most, and the
    # next sentence may open with the same word.
    (_JA_NO_NO, "No, no, no, no, no. That's not what happened."),
    (_JA_NO_NO + "\u672c\u5f53\u306b\u5927\u4e08\u592b\u3067\u3059\u3002",
     "Không, không, không, không, không. Không sao đâu."),
    ("Yes, yes, yes, yes!", "Oui, oui, oui, oui, oui !"),
    # A line repeating what its source repeats.
    ("Ha ha ha ha ha ha!", "Ha ha ha ha ha ha!"),
    ("Go! Go! Go! Go! Go!", "¡Vamos! ¡Vamos! ¡Vamos! ¡Vamos! ¡Vamos!"),
    # One character over and over is a laugh or a stammer, not a loop.
    ("Hahaha!", "\u54c8\u54c8\u54c8\u54c8\u54c8\u54c8\u54c8\u54c8"),
    ("I-I-I-I-I don't know.", "I-I-I-I-I don't know."),
    # A laugh or a scream turned into words, or words into a laugh, either way.
    ("\u54c8" * 10, "Ha ha ha ha ha ha ha ha"),
    ("\u54c8" * 10, "Ha ha ha, ha ha, ha ha."),
    ("\u306f" * 9, "Ha ha ha ha ha ha ha ha ha"),
    ("Hahahahahahahahaha!", "\u54c8" * 14),
    ("Hahahahahahahahaha!", "Haha haha haha haha haha haha haha haha"),
    ("Nooooooooo!", "\u3044" * 15),
    # A line saying again what its source says again, a little more often:
    # five "hai" became seven "yeah".
    ("\u306f\u3044\u3001" * 5 + "\u308f\u304b\u308a\u307e\u3057\u305f\u3002",
     "Yeah, yeah, yeah, yeah, yeah, yeah, yeah, I got it."),
])
def test_repetition_a_complete_line_holds_is_no_loop(source, translation):
    assert looped_repeats(source, translation) == 0
    verdict = omission_verdict(source, translation, None, None)
    assert verdict is None or verdict["reason"] != "repeated"


@pytest.mark.parametrize("translation", [
    # A phrase, in a script written without spaces: "no, no" in Chinese.
    "\u6ca1\u6709\uff0c" * 12,
    # Words of a script with spaces between them: Korean "no, no".
    "\uc544\ub2c8, " * 12,
    # A longer phrase going round.
    "I don't know, " * 8,
])
def test_loops_are_found_in_words_phrases_and_unspaced_scripts(translation):
    assert looped_repeats("Hello there, how are you?", translation) >= 8


def test_a_line_is_allowed_the_repetition_its_source_holds():
    assert repeat_allowance("Hello there.") == 4
    assert repeat_allowance(_JA_NO_NO) == 4
    assert repeat_allowance("Yes, yes, yes, yes, yes, yes, yes, yes!") == 13
    assert repeat_allowance("\u54c8" * 10) == 16
    assert repeat_allowance("Ha ha ha ha ha ha ha ha ha ha ha ha!") == 19
    # Past it, a loop: "yes" eight times went round to a hundred.
    assert looped_repeats("I said yes, yes, yes, yes, yes, yes, yes, yes!", "Oui, " * 14) == 14
    assert looped_repeats("I said yes, yes, yes, yes, yes, yes, yes, yes!", "Oui, " * 13) == 0


def test_a_short_line_stuck_in_a_loop_is_judged_whatever_its_length():
    """Lines too short for the length checks ("Yes.") are where a loop shows
    up most; the repetition check does not wait for two seconds of speech."""
    verdict = omission_verdict("Yes.", "Sí, sí, sí, sí, sí, sí, sí.", "en", "es")
    assert verdict["reason"] == "repeated" and verdict["repeats"] == 7
    assert verdict["ratio"] > 3  # measured against the whole "Yes."
    assert omission_verdict("Yes.", "Sí.", "en", "es") is None


# -- NLLB: the decode guard and the flag -----------------------------------


def _guarded(rows, *args):
    """Scores after the guard, for decoder token rows over a 32-token vocab."""
    import torch
    from api.routers.dub_translate import _RepeatRunGuard

    return _RepeatRunGuard(*args)(torch.tensor(rows), torch.zeros(len(rows), 32))


def test_the_guard_bans_only_the_token_starting_a_fifth_copy():
    import math

    no, comma, stop, other = 5, 6, 7, 8
    scores = _guarded([
        [2, 3, 4, no, comma, no, comma, no, comma, no, comma],  # (no ,) four times
        [2, 3, 4, other, no, comma, no, comma, no, comma, stop],  # three, then moved on
        [2, 3, 4, other, stop, no, no, no, no, no, no],  # one token, six times
    ])
    assert scores[0].tolist().count(-math.inf) == 1 and scores[0, no] == -math.inf
    assert not scores[1].isinf().any()
    assert scores[2, no] == -math.inf and scores[2].isinf().sum() == 1


def test_the_guard_sees_units_up_to_sixteen_tokens():
    import math

    unit = list(range(16))
    assert _guarded([[1] + unit * 4])[0, 0] == -math.inf
    assert not _guarded([[1] + unit * 3])[0].isinf().any()
    assert not _guarded([[1] + list(range(17)) * 4])[0].isinf().any()


def test_each_line_and_its_beams_get_that_line_s_limit():
    import math

    yes = 5
    six = [2, yes, yes, yes, yes, yes, yes]
    # Two lines, two beams each: the first line may say "yes" six times, the
    # second only four.
    scores = _guarded([six, six, six, six], [6, 4], 2)
    assert scores[0, yes] == -math.inf and scores[1, yes] == -math.inf
    assert scores[2, yes] == -math.inf and scores[3, yes] == -math.inf
    five = [2, 9, yes, yes, yes, yes, yes]
    scores = _guarded([five, five, five, five], [6, 4], 2)
    assert not scores[:2].isinf().any()
    assert scores[2, yes] == -math.inf and scores[3, yes] == -math.inf


def test_a_change_of_case_does_not_restart_the_count():
    """Greedy French went "oui, oui, oui, oui, Oui, oui, oui, oui, oui": the
    capital "Oui" is another token, and restarted a guard counting ids."""
    import math

    import torch

    oui, Oui, OUI, comma = 5, 6, 7, 8
    folded = torch.arange(32)
    folded[Oui] = oui
    folded[OUI] = oui
    row = [2, oui, comma, Oui, comma, oui, comma, OUI, comma]
    scores = _guarded([row], [4], 1, folded)
    # Every spelling of the token that would start a fifth copy is banned.
    assert [scores[0, t].item() for t in (oui, Oui, OUI)] == [-math.inf] * 3
    assert scores[0].isinf().sum() == 3
    assert not _guarded([row], [4], 1)[0].isinf().any()


def test_the_case_folding_maps_each_token_to_its_first_spelling(monkeypatch):
    from api.routers import dub_translate

    class Tokenizer:
        def get_vocab(self):
            return {"<s>": 0, "\u2581oui": 1, "\u2581Oui": 2, "\u2581non": 3, "\u2581OUI": 4}

    monkeypatch.setattr(dub_translate, "_nllb_tokenizer", Tokenizer())
    monkeypatch.setattr(dub_translate, "_nllb_folded", None)
    assert dub_translate._nllb_case_folded().tolist() == [0, 1, 1, 3, 1]
    # Built once per tokenizer.
    assert dub_translate._nllb_case_folded() is dub_translate._nllb_case_folded()


def _fake_nllb(monkeypatch, translate):
    """Install a fake NLLB that records each forward pass's decode options."""
    from api.routers import dub_translate
    from services import translation_engines

    class Tokenizer:
        src_lang = None

        def __call__(self, texts, **kwargs):
            return {"input_ids": list(texts)}

        def convert_tokens_to_ids(self, target):
            return target

        def batch_decode(self, tokens, **kwargs):
            return list(tokens)

    class Model:
        def __init__(self):
            self.calls = []

        def generate(self, *, input_ids, **kwargs):
            self.calls.append(kwargs)
            return [translate(text) for text in input_ids]

    model = Model()
    monkeypatch.setattr(dub_translate, "_nllb_tokenizer", Tokenizer())
    monkeypatch.setattr(dub_translate, "_nllb_model", model)
    monkeypatch.setattr(dub_translate, "_nllb_device", "cpu")
    monkeypatch.setattr(translation_engines, "is_installed", lambda _: True)
    monkeypatch.setattr(translation_engines, "is_ready", lambda _: True)
    monkeypatch.setenv("OMNIVOICE_UNLOAD_NLLB", "0")
    return model


@pytest.mark.asyncio
@pytest.mark.parametrize("retry", [False, True])
@pytest.mark.parametrize("tier", [{}, {"num_beams": 5}])
async def test_every_nllb_pass_decodes_under_the_loop_guard(monkeypatch, retry, tier):
    """Greedy and beam search alike, first pass and Translate again alike; a
    performance preset still picks the beam count."""
    from api.routers import dub_translate
    from schemas.requests import TranslateRequest
    from services import performance_profiles

    monkeypatch.setattr(performance_profiles, "translation_decode_defaults", lambda: dict(tier))
    model = _fake_nllb(monkeypatch, lambda text: f"<{text}>")
    await dub_translate.dub_translate(TranslateRequest(
        provider="nllb", source_lang="ja", target_lang="en", retry_incomplete=retry,
        segments=[{"id": "1", "text": _JA_NO_NO}, {"id": "2", "text": "Well, I think so. But nobody asked."}],
    ))
    assert model.calls
    for options in model.calls:
        (guard,) = options.pop("logits_processor")
        assert type(guard) is dub_translate._RepeatRunGuard
        assert guard.beams == tier.get("num_beams", 1) and set(guard.limits) == {4}
        assert options == {"forced_bos_token_id": "eng_Latn", "max_length": 400, **tier}


@pytest.mark.asyncio
async def test_a_line_a_translator_repeats_over_and_over_is_flagged(monkeypatch):
    """Whatever the engine: the flag rides on the row as every omission does,
    and a normal line beside it is not flagged."""
    from api.routers import dub_translate
    from schemas.requests import TranslateRequest

    _fake_nllb(monkeypatch, lambda text: _EN_LOOP if text == _JA_NO_NO else "Thank you.")
    response = await dub_translate.dub_translate(TranslateRequest(
        provider="nllb", source_lang="ja", target_lang="en",
        segments=[{"id": "1", "text": _JA_NO_NO}, {"id": "2", "text": "\u3042\u308a\u304c\u3068\u3046\u3002"}],
    ))
    looped, fine = response["translated"]
    assert looped["omission"]["reason"] == "repeated"
    assert "omission" not in fine


@pytest.mark.asyncio
async def test_translation_check_flags_agent_rows_stuck_in_a_loop(monkeypatch):
    from api.routers import dub_translate
    from schemas.requests import TranslationCheckRequest

    resp = await dub_translate.dub_translation_check(TranslationCheckRequest(
        source_lang="ja", target_lang="vi",
        rows=[
            {"id": "a", "source": _JA_NO_NO, "text": _VI_LOOP},
            {"id": "b", "source": _JA_NO_NO, "text": "Không, không, không phải vậy đâu."},
        ],
    ))
    assert set(resp["omissions"]) == {"a"}
    assert resp["omissions"]["a"]["reason"] == "repeated"


def _nllb_weights_installed() -> bool:
    try:
        import core.config  # noqa: F401 — points Hugging Face at the app's cache first
        from services import translation_engines

        return translation_engines.is_installed("nllb")
    except Exception:
        return False


@pytest.mark.asyncio
@pytest.mark.skipif(not _nllb_weights_installed(), reason="NLLB-200 weights are not installed")
@pytest.mark.parametrize("target, tier", [("en", {}), ("vi", {}), ("vi", {"num_beams": 5})])
async def test_installed_nllb_no_longer_loops_on_the_reported_line(monkeypatch, target, tier):
    """The reported line against the real model on CPU: greedy decoding wrote
    "No, no, no, ..." (Vietnamese "Không, không, ...") to the length limit,
    and so did the five beams of the Quality preset in Vietnamese."""
    import torch
    from api.routers import dub_translate
    from schemas.requests import TranslateRequest
    from services import performance_profiles

    monkeypatch.setattr(performance_profiles, "translation_decode_defaults", lambda: dict(tier))
    monkeypatch.setattr(torch.cuda, "is_available", lambda: False)
    monkeypatch.setattr(torch.backends.mps, "is_available", lambda: False)
    monkeypatch.setattr(dub_translate, "_nllb_model", None)
    monkeypatch.setattr(dub_translate, "_nllb_tokenizer", None)
    monkeypatch.setattr(dub_translate, "_nllb_device", None)
    monkeypatch.setenv("OMNIVOICE_UNLOAD_NLLB", "1")
    response = await dub_translate.dub_translate(TranslateRequest(
        provider="nllb", source_lang="ja", target_lang=target, quality="fast",
        segments=[{"id": "1", "text": _JA_NO_NO}],
    ))
    row = response["translated"][0]
    assert not row.get("error")
    assert looped_repeats(_JA_NO_NO, row["text"]) == 0, row["text"]
    assert len(row["text"]) < 80, row["text"]
    assert "omission" not in row
    assert dub_translate._nllb_model is None  # released after the run


#: Lines that repeat a word on purpose, against the real model: a fixed limit
#: of four copies ended the first after its fifth "yeah" ("I got it" lost),
#: kept four of eight "oui", and four "\u54c8" of twelve — flagged "short"
#: then, and no Translate again could clear it.
_ON_PURPOSE = [
    ("ja", "en", "\u306f\u3044\u3001" * 5 + "\u308f\u304b\u308a\u307e\u3057\u305f\u3002",
     lambda text: "got it" in text.lower()),
    ("en", "fr", "I said yes, yes, yes, yes, yes, yes, yes, yes!",
     lambda text: text.lower().count("oui") == 8),
    ("en", "zh", "Ha ha ha ha ha ha ha ha ha ha ha ha!",
     lambda text: text.count("\u54c8") >= 8),
]


@pytest.mark.asyncio
@pytest.mark.skipif(not _nllb_weights_installed(), reason="NLLB-200 weights are not installed")
@pytest.mark.parametrize("tier", [{}, {"num_beams": 5}])
@pytest.mark.parametrize("source, target, text, kept", _ON_PURPOSE)
async def test_installed_nllb_keeps_lines_that_repeat_on_purpose(
        monkeypatch, source, target, text, kept, tier):
    import torch
    from api.routers import dub_translate
    from schemas.requests import TranslateRequest
    from services import performance_profiles

    monkeypatch.setattr(performance_profiles, "translation_decode_defaults", lambda: dict(tier))
    monkeypatch.setattr(torch.cuda, "is_available", lambda: False)
    monkeypatch.setattr(torch.backends.mps, "is_available", lambda: False)
    monkeypatch.setattr(dub_translate, "_nllb_model", None)
    monkeypatch.setattr(dub_translate, "_nllb_tokenizer", None)
    monkeypatch.setattr(dub_translate, "_nllb_device", None)
    monkeypatch.setenv("OMNIVOICE_UNLOAD_NLLB", "1")
    response = await dub_translate.dub_translate(TranslateRequest(
        provider="nllb", source_lang=source, target_lang=target, quality="fast",
        segments=[{"id": "1", "text": text}],
    ))
    row = response["translated"][0]
    assert not row.get("error")
    assert kept(row["text"]), row["text"]
    assert "omission" not in row, (row["text"], row.get("omission"))
