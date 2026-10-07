"""Every engine reads the app's spellings of the languages it speaks.

The app names a language several ways: the Electron pickers' labels and codes
(electron/src/shared/utils/languages.js: "Arabic"/"ar", "Chinese (Simplified)"/
"cmn-Hans", "Kurdish"/"ku"), OmniVoice's own names and ids, which Clone and
Voice Design list ("Standard Arabic"/"arb"), and region tags from API callers
("pt-BR"). OmniVoice read Arabic, Chinese and Kurdish from Audiobook, Batch and
Dub as Auto, with no language hint; finite engines refused both Chinese scripts
and Clone's Standard Arabic although they speak them; sidecars received labels
they cut to two letters ("German" reached Confucius4 as "ge"); MOSS-TTS-v1.5
was handed names it does not know ("cmn-Hans"); and PocketTTS was offered every
language, refusing all but six on the first take. A language an engine now
receives otherwise keys its long-form audio apart, so audio cached before is
not replayed.
"""
import re
from pathlib import Path
from types import SimpleNamespace

import pytest

ROOT = Path(__file__).resolve().parents[1]
#: "Hello, how are you?" in Sorani (Central Kurdish), which is written in Arabic script.
SORANI = "\u0633\u06b5\u0627\u0648\u060c \u0686\u06c6\u0646\u06cc\u061f"
KURMANJI = "Rojbaş, tu çawa yî?"


def _picker_languages():
    path = ROOT / "electron/src/shared/utils/languages.js"
    return re.findall(r"\{ code: '([^']+)', label: '([^']+)' \}", path.read_text(encoding="utf-8"))


@pytest.fixture
def tts():
    from services import tts_backend
    return tts_backend


@pytest.fixture
def codes():
    from services import language_codes
    return language_codes


def _subprocess_base(cls):
    # The exact class in this backend's MRO survives the services.* reloads
    # other tests perform (see test_dots_tts.py).
    return next(c for c in cls.__mro__ if c.__name__ == "SubprocessBackend")


class _Sent(Exception):
    """Stops a sidecar request once its message is captured."""


def _capture_sidecar_message(monkeypatch, backend):
    from services import model_manager
    sent = []

    def send(message):
        sent.append(message)
        raise _Sent

    monkeypatch.setattr(model_manager, "running_on_gpu_pool", lambda: True)
    monkeypatch.setattr(backend, "_validate_generate_authorization", lambda: None)
    monkeypatch.setattr(backend, "_spawn", lambda: None)
    monkeypatch.setattr(backend, "_send", send)
    return sent


# ── One vocabulary ────────────────────────────────────────────────────────


def test_each_picker_label_names_the_language_of_its_code(codes):
    pickers = _picker_languages()
    assert len(pickers) > 90
    for code, label in pickers:
        assert codes.engine_language_code(label) is not None, label
        assert codes.engine_language_code(label) == codes.engine_language_code(code), label


def test_picker_spellings_match_the_pickers_and_never_shadow_omnivoice(codes):
    from omnivoice.utils.lang_map import LANG_NAME_TO_ID
    assert not set(codes.PICKER_LANGUAGE_CODES) & set(LANG_NAME_TO_ID)
    for code, label in _picker_languages():
        assert codes.PICKER_LANGUAGE_CODES.get(label.lower(), code) == code, label


@pytest.mark.parametrize("language,expected", [
    ("Standard Arabic", "ar"), ("arb", "ar"), ("ar-EG", "ar"),
    ("Chinese (Traditional)", "zh"), ("cmn-Hans", "zh"), ("zh_TW", "zh"), ("Mandarin", "zh"),
    ("Filipino", "tl"), ("Norwegian Bokmål", "no"), ("Nepali", "ne"), ("jw", "jv"),
    ("Cantonese", "yue"), ("Egyptian Arabic", "arz"), ("Central Kurdish", "ckb"),
    ("Auto", None), (None, None), ("Klingon", None),
])
def test_engine_codes_name_a_standard_variety_by_its_macrolanguage(codes, language, expected):
    assert codes.engine_language_code(language) == expected


# ── The speech check's recognizer: Whisper's code, from the same vocabulary ─


@pytest.mark.parametrize("language,expected", [
    ("Vietnamese", "vi"), ("pt-BR", "pt"), ("Arabic", "ar"), ("Standard Arabic", "ar"),
    ("Chinese (Simplified)", "zh"), ("cmn-Hant", "zh"), ("zho", "zh"), ("Filipino", "tl"),
    # Whisper's own spellings: Javanese is "jw", and it knows Nynorsk apart.
    ("Javanese", "jw"), ("jv", "jw"), ("jw", "jw"),
    ("Norwegian Bokmål", "no"), ("nb", "no"), ("Norwegian Nynorsk", "nn"), ("nn", "nn"),
    # It hears every Pashto as one language, and knows its own names.
    ("Southern Pashto", "ps"), ("pbu", "ps"), ("Pashto", "ps"),
    ("Myanmar", "my"), ("Burmese", "my"), ("Malagasy", "mg"), ("Plateau Malagasy", "mg"),
    ("Faroese", "fo"), ("Nynorsk", "nn"),
    # Languages Whisper does not transcribe are detected instead.
    ("Kurdish", None), ("Northern Kurdish", None), ("Cantonese", None), ("Odia", None),
    ("Auto", None), ("", None), (None, None), (7, None), ("Klingon", None),
])
def test_recognizers_are_told_whispers_code_for_every_spelling(codes, language, expected):
    assert codes.whisper_language(language) == expected


def test_a_picker_label_tells_the_recognizer_what_its_code_does(codes):
    for code, label in _picker_languages():
        assert codes.whisper_language(label) == codes.whisper_language(code), label


def test_the_speech_check_keeps_no_language_table_of_its_own(codes):
    """Every spelling the app's vocabulary learns reaches the speech check."""
    from omnivoice.utils.lang_map import LANG_NAME_TO_ID
    from services import speech_verify

    spellings = [*LANG_NAME_TO_ID, *LANG_NAME_TO_ID.values(),
                 *(item for pair in _picker_languages() for item in pair)]
    for spelling in spellings:
        assert speech_verify.recognizer_language(spelling) == codes.whisper_language(spelling)


def test_codes_still_reach_the_recognizer_without_omnivoices_names(codes, monkeypatch):
    import sys

    monkeypatch.setitem(sys.modules, "omnivoice.utils.lang_map", None)
    assert codes.whisper_language("vi-VN") == "vi"
    assert codes.whisper_language("Chinese (Traditional)") == "zh"
    assert codes.whisper_language("Vietnamese") is None  # named only by OmniVoice


def test_whisper_codes_are_the_ones_faster_whisper_knows(codes):
    tokenizer = pytest.importorskip("faster_whisper.tokenizer")
    known = getattr(tokenizer, "_LANGUAGE_CODES", None)
    if known is None:
        pytest.skip("faster-whisper no longer lists its language codes here")
    # Cantonese is left out on purpose: only large-v3 knows it.
    assert codes.WHISPER_LANGUAGES == set(known) - {"yue"}


# ── OmniVoice: every family gets the id the model was trained with ────────


@pytest.mark.parametrize("language,expected", [
    ("Arabic", "arb"), ("ar", "arb"), ("Standard Arabic", "arb"),
    ("Chinese (Simplified)", "zh"), ("Chinese (Traditional)", "zh"),
    ("cmn-Hans", "zh"), ("cmn-Hant", "zh"), ("Mandarin", "zh"),
    ("Kurdish", "kmr"), ("ku", "kmr"),
    ("Haitian Creole", "ht"), ("Kyrgyz", "ky"), ("Pashto", "ps"), ("Punjabi", "pa"),
    ("jw", "jv"), ("ne", "npi"), ("Tagalog", "fil"),
    ("en-US", "en"), ("pt_BR", "pt"), ("Vietnamese", "vi"),
    ("Auto", None), ("auto", None), (None, None), ("", None),
    # Absent from the model: unchanged, read as Auto as before.
    ("Latin", "Latin"), ("Klingon", "Klingon"),
])
def test_omnivoice_reads_every_spelling_as_its_vocabulary_id(codes, language, expected):
    assert codes.omnivoice_language(language) == expected


def test_kurdish_follows_the_script_it_is_written_in(codes):
    assert codes.omnivoice_language("Kurdish", KURMANJI) == "kmr"
    assert codes.omnivoice_language("ku", SORANI) == "ckb"
    # A chosen variety is kept whatever the script.
    assert codes.omnivoice_language("Northern Kurdish", SORANI) == "kmr"
    assert codes.omnivoice_language("Central Kurdish", KURMANJI) == "ckb"


def test_every_picker_language_omnivoice_has_reaches_it_as_an_id(codes, tts):
    from omnivoice.utils.lang_map import LANG_IDS
    options = set(tts.language_options("omnivoice"))
    absent = set()
    for code, label in _picker_languages():
        hint = codes.omnivoice_language(label)
        if hint in LANG_IDS:
            assert codes.omnivoice_language(code) == hint, label
        else:
            assert codes.omnivoice_language(code) not in LANG_IDS, label
            absent.add(label)
        assert (label.lower() in options) == (hint in LANG_IDS), label
    assert absent == {"Latin", "Samoan", "Scots Gaelic", "Sundanese"}


def test_native_omnivoice_calls_pass_the_vocabulary_id(tts):
    """/generate, its stream and the long-form renderer call the model directly."""
    seen = []

    class Model:
        def generate(self, **kw):
            seen.append(kw["language"])
            return ["audio"]

    for language in ("Arabic", "cmn-Hant", "Auto"):
        tts.generate_with_cached_ref(Model(), ref_audio=None, ref_text=None,
                                     text="hello", language=language)
    assert seen == ["arb", "zh", None]


def test_omnivoice_batch_passes_an_id_for_each_line(tts):
    """Batch and Dub send the pickers' codes, one per line."""
    seen = {}

    class Model:
        def generate(self, **kw):
            seen.update(kw)
            return ["a", "b", "c"]

    backend = tts.OmniVoiceBackend(model=Model())
    backend.generate_batch(["hello", SORANI, "hi"], language=["cmn-Hans", "ku", "ar"])
    assert seen["language"] == ["zh", "ckb", "arb"]
    backend.generate_batch(["hello", "hi"], language="Kurdish")
    assert seen["language"] == ["kmr", "kmr"]


def test_omnivoice_sidecar_receives_the_vocabulary_id(monkeypatch):
    """The MPS engine runs the same model in a sidecar process."""
    from engines.omnivoice_subprocess import OmniVoiceSubprocessBackend
    captured = {}
    monkeypatch.setattr(_subprocess_base(OmniVoiceSubprocessBackend), "generate",
                        lambda self, text, **kw: captured.update(kw))
    backend = object.__new__(OmniVoiceSubprocessBackend)
    backend.generate(SORANI, language="Kurdish")
    assert captured["language"] == "ckb"
    backend.generate("hello", language="Chinese (Traditional)")
    assert captured["language"] == "zh"


@pytest.mark.parametrize("language,expected", [
    ("Arabic", "Standard Arabic"), ("ar", "Standard Arabic"), ("cmn-Hans", "Chinese"),
    ("Chinese (Traditional)", "Chinese"), ("Kurdish", "Northern Kurdish"), ("en", "English"),
    ("vi", "Vietnamese"), ("ne", "Nepali"), ("Auto", None), ("Klingon", "Klingon"),
])
def test_gguf_binary_receives_omnivoice_names(language, expected):
    from engines.omnivoice_gguf.backend import _iso_to_omnivoice_lang
    assert _iso_to_omnivoice_lang(language) == expected


def test_gguf_kurdish_follows_the_script(tmp_path):
    from engines.omnivoice_gguf import backend as gguf
    argv = gguf.OmniVoiceGGUFBackend._build_argv(
        object(), base=tmp_path / "b.gguf", tokenizer=tmp_path / "t.gguf",
        out_path=tmp_path / "o.wav", ref_audio=None, ref_text=None,
        language="ku", text=SORANI,
    )
    assert argv[argv.index("--lang") + 1] == "Central Kurdish"


# ── Engines with a declared set: accept every spelling, reject the rest ───


@pytest.mark.parametrize("language,declared", [
    ("Standard Arabic", "ar"), ("Arabic", "ar"), ("ar", "ar"),
    ("Chinese (Simplified)", "zh"), ("Chinese (Traditional)", "zh"),
    ("cmn-Hans", "zh"), ("cmn-Hant", "zh"), ("Mandarin", "zh"),
    ("Filipino", "tl"), ("Norwegian Bokmål", "no"),
])
def test_finite_engine_accepts_every_spelling_of_a_language_it_speaks(tts, language, declared):
    backend = object.__new__(tts.VoxCPM2Backend)
    assert backend._check_language(language) == declared


@pytest.mark.parametrize("language", [
    "Egyptian Arabic", "Cantonese", "Kurdish", "ku", "Central Kurdish", "Latin", "Klingon",
])
def test_finite_engine_still_rejects_what_it_cannot_speak(tts, language):
    backend = object.__new__(tts.VoxCPM2Backend)
    with pytest.raises(ValueError, match="doesn't support"):
        backend._check_language(language)


@pytest.mark.parametrize("engine", [
    "voxcpm2", "moss-tts-nano", "kittentts", "cosyvoice", "gpt-sovits",
    "indextts2", "confucius4-tts", "audiocpp", "pockettts",
])
def test_picker_offers_exactly_what_the_guard_accepts(tts, engine, monkeypatch):
    """Clone and Design list OmniVoice's names, the other pickers their own
    labels and codes: every one the guard accepts is offered, and only those."""
    from omnivoice.utils.lang_map import LANG_NAME_TO_ID
    monkeypatch.delenv("OMNIVOICE_INDEXTTS_DIR", raising=False)
    if engine == "pockettts":  # its license gates construction
        from engines.pockettts import PocketTTSBackend
        monkeypatch.setattr(PocketTTSBackend, "_license_accepted", classmethod(lambda cls: True))
        monkeypatch.setattr(PocketTTSBackend, "_platform_error", classmethod(lambda cls: None))
    options = set(tts.language_options(engine))
    backend = object.__new__(tts.get_backend_class(engine))

    def accepted(language):
        try:
            backend._check_language(language)
        except ValueError:
            return False
        return True

    pickers = _picker_languages()
    assert all(accepted(name) for name in options), engine
    names = set(LANG_NAME_TO_ID) | {label.lower() for _, label in pickers}
    assert {name for name in names if accepted(name)} <= options, engine
    for code, label in pickers:
        assert accepted(code) == (label.lower() in options), (engine, label)


def test_arabic_engines_offer_clones_standard_arabic(tts, monkeypatch):
    monkeypatch.delenv("OMNIVOICE_INDEXTTS_DIR", raising=False)
    for engine in ("voxcpm2", "moss-tts-nano", "indextts2"):
        assert {"standard arabic", "arabic"} <= set(tts.language_options(engine)), engine


@pytest.mark.parametrize("language,tag", [
    ("Chinese (Traditional)", "zh"), ("cmn-Hans", "zh"), ("Cantonese", "yue"),
])
def test_cosyvoice_cross_lingual_tag_for_picker_spellings(monkeypatch, tts, language, tag):
    import torch
    seen = []

    def inference(text, *args, **kwargs):
        seen.append(text)
        return [{"tts_speech": torch.zeros(1, 10)}]

    backend = object.__new__(tts.CosyVoiceBackend)
    backend._model = SimpleNamespace(inference_cross_lingual=inference)
    monkeypatch.setattr(backend, "_ensure_loaded", lambda: None)
    backend.generate("hello", ref_audio="voice.wav", language=language)
    assert seen == [tts.CosyVoiceBackend.LANG_TAGS[tag] + "hello"]


@pytest.mark.parametrize("language,code", [
    ("Chinese (Simplified)", "zh"), ("cmn-Hant", "zh"), ("Cantonese", "yue"),
])
def test_gptsovits_target_language_for_picker_spellings(monkeypatch, tts, language, code):
    import json
    from services import outbound_http
    seen = []

    def capture(*args, **kwargs):
        seen.append(json.loads(kwargs["body"]))
        raise RuntimeError("captured request")

    monkeypatch.setattr(outbound_http, "open_trusted_endpoint", capture)
    backend = object.__new__(tts.GPTSoVITSBackend)
    backend._url = "http://127.0.0.1:9880"
    with pytest.raises(RuntimeError, match="captured request"):
        backend.generate("hello", ref_audio="voice.wav", language=language)
    assert seen[0]["text_lang"] == code


@pytest.mark.parametrize("language,code", [
    ("German", "de"), ("Chinese (Simplified)", "zh"), ("Malay", "ms"), ("pt-BR", "pt"),
])
def test_confucius4_sidecar_receives_the_declared_code(monkeypatch, tmp_path, language, code):
    from engines.confucius4 import Confucius4Backend
    from engines.confucius4.main import _normalize_language
    backend = Confucius4Backend()
    sent = _capture_sidecar_message(monkeypatch, backend)
    with pytest.raises(_Sent):
        backend.generate("hello", ref_audio=str(tmp_path / "ref.wav"), language=language)
    assert sent[0]["language"] == code
    assert _normalize_language(sent[0]["language"]) == code


def test_cosyvoice_sidecar_receives_the_declared_code(monkeypatch):
    from engines.cosyvoice_subprocess import CosyVoiceSubprocessBackend
    backend = CosyVoiceSubprocessBackend()
    sent = _capture_sidecar_message(monkeypatch, backend)
    with pytest.raises(_Sent):
        backend.generate("hello", ref_audio="voice.wav", language="Chinese (Traditional)")
    assert sent[0]["language"] == "zh"


def test_indextts_reads_clones_standard_arabic(monkeypatch):
    from engines.indextts import IndexTTS2Backend
    monkeypatch.delenv("OMNIVOICE_INDEXTTS_DIR", raising=False)
    captured = {}
    monkeypatch.setattr(_subprocess_base(IndexTTS2Backend), "generate",
                        lambda self, text, **kw: captured.update(kw))
    backend = object.__new__(IndexTTS2Backend)
    backend.generate("hello", ref_audio="voice.wav", language="Standard Arabic")
    assert captured["lang"] == "ar"
    backend.generate("hello", ref_audio="voice.wav", language="cmn-Hant")
    assert captured["lang"] == "zh"


def test_mlx_curated_model_receives_its_declared_language(monkeypatch, tts):
    import numpy as np
    monkeypatch.setenv("OMNIVOICE_MLX_AUDIO_MODEL", "qwen3-tts")
    backend = tts.MLXAudioBackend()
    seen = {}

    class Model:
        def generate(self, **kw):
            seen.update(kw)
            return iter([SimpleNamespace(audio=np.zeros(4, dtype=np.float32), sample_rate=24000)])

    backend._model = Model()
    monkeypatch.setattr(backend, "_ensure_loaded", lambda: None)
    backend.generate("hello", language="cmn-Hans", instruct="a calm narrator")
    assert seen["lang_code"] == "chinese"
    monkeypatch.setenv("OMNIVOICE_MLX_AUDIO_MODEL", "outetts")
    backend = tts.MLXAudioBackend()
    backend._model = Model()
    monkeypatch.setattr(backend, "_ensure_loaded", lambda: None)
    backend.generate("hello", language="Standard Arabic")
    assert seen["lang_code"] == "ar"


def test_kokoro_reads_picker_spellings_of_its_languages(monkeypatch, tts):
    import importlib.metadata
    import sys
    import types
    pipeline = types.ModuleType("mlx_audio.tts.models.kokoro.pipeline")
    pipeline.ALIASES, pipeline.LANG_CODES = tts._KOKORO_FALLBACK_TABLES
    for name in ("mlx_audio", "mlx_audio.tts", "mlx_audio.tts.models", "mlx_audio.tts.models.kokoro"):
        monkeypatch.setitem(sys.modules, name, types.ModuleType(name))
    monkeypatch.setitem(sys.modules, pipeline.__name__, pipeline)
    for language in ("Chinese (Simplified)", "Chinese (Traditional)", "cmn-Hans", "Mandarin"):
        assert tts.resolve_kokoro_lang_code(language) == "z", language
    assert tts.resolve_kokoro_lang_code("es-MX") == "e"
    with pytest.raises(ValueError, match="doesn't support"):
        tts.resolve_kokoro_lang_code("Cantonese")

    def unreadable(_name):
        raise importlib.metadata.PackageNotFoundError
    monkeypatch.setattr(importlib.metadata, "distribution", unreadable)
    options = tts._installed_kokoro_language_options()
    assert {"chinese (simplified)", "chinese (traditional)", "mandarin"} <= set(options)
    assert "arabic" not in options


# ── Open-ended engines whose sidecars take codes ──────────────────────────


@pytest.mark.parametrize("language,lang", [
    ("German", "de"), ("Swedish", "sv"), ("Chinese (Simplified)", "zh"),
    ("Standard Arabic", "ar"), ("en-US", "en"), ("Hawaiian", "haw"),
    ("Auto", "na"), (None, "na"),
])
def test_supertonic3_reads_picker_names_as_iso_codes(monkeypatch, language, lang):
    """The sidecar kept the first two letters: "Swedish" became Swahili, and
    Hawaiian ("haw") Hausa."""
    from engines.supertonic3 import constants
    from engines.supertonic3.backend import Supertonic3Backend
    from engines.supertonic3.sidecar import _normalize_lang
    # generate() pins this for the sidecar; keep it out of later tests' env.
    monkeypatch.setenv("SUPERTONIC3_REVISION", constants.PINNED_REVISION_SHA)
    captured = {}
    monkeypatch.setattr(_subprocess_base(Supertonic3Backend), "generate",
                        lambda self, text, **kw: captured.update(kw))
    object.__new__(Supertonic3Backend).generate("hello", language=language)
    assert _normalize_lang(captured["lang"]) == lang


@pytest.mark.parametrize("language,expected", [
    ("German", "DE"), ("Chinese (Traditional)", "ZH"), ("cmn-Hans", "ZH"),
    ("Standard Arabic", "AR"), ("Cantonese", "Cantonese"), ("Klingon", "Klingon"),
])
def test_dots_receives_iso_codes_for_picker_spellings(monkeypatch, language, expected):
    from engines.dots_tts import DotsTTSBackend
    from engines.dots_tts.main import _normalize_language
    captured = {}
    monkeypatch.setattr(_subprocess_base(DotsTTSBackend), "generate",
                        lambda self, text, **kw: captured.update(kw))
    DotsTTSBackend().generate("hello", language=language)
    assert _normalize_language(captured["language"]) == expected


@pytest.mark.parametrize("language,sent,name", [
    ("Chinese (Simplified)", "zh", "Chinese"), ("cmn-Hant", "zh", "Chinese"),
    ("Standard Arabic", "ar", "Arabic"), ("pt-BR", "pt", "Portuguese"),
    ("English", "en", "English"),
    # No MOSS name in the sidecar: sent as given, so a MOSS name passes through.
    ("Afrikaans", "Afrikaans", "Afrikaans"), ("Tagalog", "Tagalog", "Tagalog"),
])
def test_moss_v15_reads_every_spelling_by_its_moss_name(monkeypatch, language, sent, name):
    """MOSS puts the language's name in its prompt word for word: Dub's
    "cmn-Hans" and Audiobook's "Chinese (Simplified)" reached it as names it
    does not know."""
    from engines.moss_tts_v15 import MossTTSV15Backend
    from engines.moss_tts_v15.main import _resolve_language
    captured = {}
    monkeypatch.setattr(_subprocess_base(MossTTSV15Backend), "generate",
                        lambda self, text, **kw: captured.update(kw))
    MossTTSV15Backend().generate("hello", language=language)
    assert captured["language"] == sent
    assert _resolve_language(captured["language"]) == name


# ── PocketTTS: six languages, declared ────────────────────────────────────


@pytest.fixture
def pockettts(monkeypatch):
    from engines.pockettts import PocketTTSBackend
    monkeypatch.setattr(PocketTTSBackend, "_license_accepted", classmethod(lambda cls: True))
    monkeypatch.setattr(PocketTTSBackend, "_platform_error", classmethod(lambda cls: None))
    return PocketTTSBackend


@pytest.mark.parametrize("language,code", [
    ("Portuguese", "pt"), ("pt-BR", "pt"), ("en-US", "en"), ("fr", "fr"), ("Spanish", "es"),
    ("eng", "en"),  # the sidecar's own three-letter spelling
])
def test_pockettts_sidecar_receives_the_declared_code(monkeypatch, pockettts, language, code):
    from engines.pockettts.main import _pocket_language
    backend = pockettts()
    sent = _capture_sidecar_message(monkeypatch, backend)
    with pytest.raises(_Sent):
        backend.generate("hello", language=language)
    assert sent[0]["language"] == code
    assert _pocket_language(sent[0]["language"]) == _pocket_language(code)


def test_pockettts_refuses_another_language_before_its_sidecar(monkeypatch, tts, pockettts):
    """It speaks six languages, one model each: the pickers offered every
    language and the sidecar refused it on the first take."""
    options = set(tts.language_options("pockettts"))
    assert {"english", "portuguese", "french", "german", "italian", "spanish"} <= options
    assert "vietnamese" not in options
    backend = pockettts()
    sent = _capture_sidecar_message(monkeypatch, backend)
    with pytest.raises(ValueError, match="doesn't support"):
        backend.generate("hello", language="Vietnamese")
    assert sent == []
    with pytest.raises(_Sent):  # Auto keeps the sidecar's default
        backend.generate("hello", language="Auto")


# ── Cache keys follow what the engine receives ────────────────────────────


@pytest.mark.parametrize("engine,language,changed", [
    ("omnivoice", "Arabic", True), ("omnivoice", "cmn-Hans", True), ("omnivoice", "Kurdish", True),
    ("omnivoice", "pt-BR", True), ("omnivoice-subprocess", "Chinese (Traditional)", True),
    ("omnivoice", "English", False), ("omnivoice", "Standard Arabic", False),
    ("omnivoice", "Northern Kurdish", False), ("omnivoice", "Latin", False),
    ("omnivoice", "Auto", False), ("omnivoice", None, False),
    ("omnivoice-gguf", "Arabic", True), ("omnivoice-gguf", "vi", True),
    ("omnivoice-gguf", "Vietnamese", False),
    ("supertonic3", "Swedish", True), ("supertonic3", "German", True),
    ("supertonic3", "English", False), ("supertonic3", "sv", False),
    ("confucius4-tts", "German", True), ("confucius4-tts", "de", False),
    ("confucius4-tts", "English", False),
    ("cosyvoice", "Spanish", True), ("cosyvoice", "French", False),
    ("dots-tts", "Chinese (Simplified)", True), ("dots-tts", "English", False),
    ("moss-tts-v15", "cmn-Hans", True), ("moss-tts-v15", "English", False),
    ("moss-tts-v15", "Afrikaans", False),
    ("pockettts", "pt-BR", False), ("indextts2", "Standard Arabic", False), ("eng", "Arabic", False),
])
def test_cache_keys_know_which_languages_an_engine_now_receives_otherwise(
        codes, engine, language, changed):
    """Long-form keys carry LANGUAGE_INPUT_RENDER for exactly these: audio
    cached before for them renders again, and every other key stays as it
    was (see tests/test_longform_cache_reuse.py)."""
    assert codes.language_input_changed(engine, language) is changed
