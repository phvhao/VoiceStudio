"""Settings → Reading: one app-wide way to read text aloud.

Stored once (prefs.json), edited from Settings or any workspace's quick
popover, and applied to Audiobook, Stories, Clone and Voice Design when the app
asks for it. API callers that do not ask keep exactly the take they had.
"""
from __future__ import annotations

import json

import pytest

torch = pytest.importorskip("torch")

from api.routers import generation as gen  # noqa: E402
from services import reading_settings  # noqa: E402
from services.chunked_tts import DEFAULT_PUNCTUATION_PAUSES  # noqa: E402


@pytest.fixture()
def prefs(monkeypatch):
    """An in-memory prefs store."""
    from core import prefs as core_prefs

    store: dict = {}
    monkeypatch.setattr(core_prefs, "get", lambda key, default=None: store.get(key, default))
    monkeypatch.setattr(core_prefs, "set_", lambda key, value: store.__setitem__(key, value))
    return store


def test_defaults_read_sentence_by_sentence_without_the_check(prefs):
    assert reading_settings.load() == {
        "phrase_rendering": True,
        "punctuation_pauses": DEFAULT_PUNCTUATION_PAUSES,
        "split_commas": False,
        "verify_speech": False,
    }


def test_save_merges_partial_changes_and_clamps_bad_values(prefs):
    reading_settings.save({"punctuation_pauses": {"comma": 400}, "verify_speech": True})
    saved = reading_settings.save({"punctuation_pauses": {"sentence": 99999, "bogus": 3}})
    assert saved["punctuation_pauses"] == {**DEFAULT_PUNCTUATION_PAUSES, "comma": 400,
                                           "sentence": 5000}
    assert saved["verify_speech"] is True
    prefs["reading"] = "not a dict"
    assert reading_settings.load()["phrase_rendering"] is True


def test_settings_endpoints_round_trip(prefs):
    from api.routers.settings import _ReadingBody, get_reading, set_reading

    body = _ReadingBody(phrase_rendering=False, punctuation_pauses={"dash": 80})
    saved = set_reading(body)
    assert saved["phrase_rendering"] is False
    assert get_reading()["punctuation_pauses"]["dash"] == 80
    with pytest.raises(ValueError):
        _ReadingBody(punctuation_pauses={"sentence": -1})


def test_long_form_follows_the_app_only_when_asked(prefs):
    from api.routers.audiobook import AudiobookPreviewRequest, _expressive_opts

    reading_settings.save({"verify_speech": True, "punctuation_pauses": {"comma": 90}})
    assert _expressive_opts(AudiobookPreviewRequest(text="x")).is_default
    opts = _expressive_opts(AudiobookPreviewRequest(text="x", use_app_reading=True))
    assert dict(opts.punctuation_pauses) == {**DEFAULT_PUNCTUATION_PAUSES, "comma": 90}
    assert opts.verify_speech is True
    # A project's own value wins over the app's, "off" included.
    own = _expressive_opts(AudiobookPreviewRequest(
        text="x", use_app_reading=True, punctuation_pauses=None, verify_speech=False))
    assert own.punctuation_pauses is None and own.verify_speech is False


def test_reading_field_resolution(prefs):
    assert gen._resolve_reading(None, None) is None
    reading_settings.save({"phrase_rendering": False})
    assert gen._resolve_reading("app", None) is None  # nothing would change
    reading_settings.save({"phrase_rendering": True})
    assert gen._resolve_reading("app", None)["pauses"] == DEFAULT_PUNCTUATION_PAUSES
    explicit = gen._resolve_reading(json.dumps({"punctuation_pauses": {"comma": 10},
                                                "verify_speech": True}), None)
    assert explicit["pauses"]["comma"] == 10 and explicit["verify"] is True
    # A fixed duration keeps one take; the check still applies.
    assert gen._resolve_reading(json.dumps({"punctuation_pauses": {}, "verify_speech": True}),
                                3.0)["pauses"] is None
    assert gen._resolve_reading("{not json", None) is None


class _Model:
    sampling_rate = 1000

    def __init__(self):
        self.texts = []

    def create_voice_clone_prompt(self, ref_audio, ref_text=None, preprocess_prompt=True):
        return "PROMPT"

    def generate(self, **kw):
        self.texts.append(kw["text"])
        return [torch.full((300,), 0.2)]


def _run(model, text, **over):
    kw = dict(
        model=model, text=text, language=None, ref_audio_path=None, ref_text=None,
        instruct=None, duration=None, num_step=4, guidance_scale=2.0, speed=1.0,
        t_shift=None, denoise=False, postprocess_output=False,
        layer_penalty_factor=None, position_temperature=None,
        class_temperature=None, used_seed=7, effect_preset="raw",
    )
    kw.update(over)
    return gen._run_inference(**kw)


TEXT = "Spring is for sowing; summer is for tending. Autumn is the harvest!"


def test_generate_reads_sentence_by_sentence_with_the_chosen_pauses():
    model = _Model()
    pauses = {**DEFAULT_PUNCTUATION_PAUSES, "semicolon": 400, "sentence": 600}
    audio = _run(model, TEXT, reading={"pauses": pauses, "split_commas": False, "verify": False})
    assert model.texts == ["Spring is for sowing;", "summer is for tending.",
                           "Autumn is the harvest!"]
    assert audio.shape[-1] == 3 * 300 + 400 + 600


def test_generate_without_reading_is_unchanged():
    model = _Model()
    _run(model, TEXT)
    assert model.texts == [TEXT]
