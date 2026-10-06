"""Audiobook multi-voice cast mapping (#1217).

The headline fix: ``[voice:NAME]`` used to be handed to ``_resolve_voice`` as if
NAME were a profile id — it never matched (profile ids are UUIDs), so every
``[voice:…]`` silently rendered in the engine default and a multi-voice book was
mono-voiced. A book now carries a ``voice_map`` (NAME → profile id); this suite
pins the resolution, the silent-default fix for unmapped names, exact-id
back-compat, and the CRITICAL cache-signature guard (remapping must re-render;
an absent map must keep today's byte-identical keys).

Engine + DB boundary stubbed throughout — no model loads, no GPU, no ffmpeg.
"""
import os
import types

os.environ.setdefault("OMNIVOICE_MODEL", "test")
os.environ.setdefault("OMNIVOICE_DISABLE_FILE_LOG", "1")

import torch

from services.audiobook import (
    Chapter,
    ExpressiveOptions,
    Span,
    voice_map_signature,
)

_PID = "11111111-2222-3333-4444-555555555555"


# ── voice_map_signature: the CRITICAL TRAP guard ────────────────────────────

def test_absent_or_empty_map_has_empty_signature():
    # An absent/empty map must be byte-identical to pre-#1217: no signature, so
    # no perturbation of any cache key — existing books never re-render.
    assert voice_map_signature(None) == ""
    assert voice_map_signature({}) == ""


def test_map_produces_a_signature_that_changes_with_content():
    a = voice_map_signature({"Mara": _PID})
    b = voice_map_signature({"Mara": "other-pid"})
    c = voice_map_signature({"Mara": _PID, "Cole": "pid2"})
    assert a and b and c
    assert len({a, b, c}) == 3
    # Order-independent (canonical JSON) — same map, same key.
    assert voice_map_signature({"Cole": "pid2", "Mara": _PID}) == c


# ── name → profile resolution through the resolve closure ───────────────────

def _generic_synth_recording(monkeypatch):
    """A generic backend + a recording ``_resolve_voice`` — returns (build, seen)
    where ``seen`` collects every profile id resolution was asked for."""
    import api.routers.audiobook as ab
    import services.tts_backend as tb
    from services.tts_backend import TTSBackend

    class _Fake(TTSBackend):
        id = "fake-cast-engine"
        display_name = "Fake Cast Engine (test)"
        gpu_compat = ("cpu",)

        @property
        def sample_rate(self):
            return 24000

        @property
        def supported_languages(self):
            return ["multi"]

        @classmethod
        def is_available(cls):
            return True, "ready"

        def generate(self, text, **kw):
            return torch.zeros(1, 2400)

    monkeypatch.setattr(tb, "active_backend_id", lambda: "fake-cast-engine")
    monkeypatch.setattr(tb, "get_backend_class", lambda _id: _Fake)

    seen = []

    def fake_resolve(pid):
        seen.append(pid)
        return {"ref_audio": None, "ref_text": None, "instruct": None, "seed": None}

    monkeypatch.setattr(ab, "_resolve_voice", fake_resolve)
    return ab, seen


def test_named_voice_resolves_through_the_map(monkeypatch):
    # [voice:Mara] with voice_map={"Mara": <pid>} must resolve to that profile.
    ab, seen = _generic_synth_recording(monkeypatch)
    info = ab._build_synth("default-pid", voice_map={"Mara": _PID})
    info["synth"]("hello", "Mara")
    assert seen == [_PID]


def test_unmapped_name_falls_back_to_default_voice(monkeypatch):
    # Without a map, a bare NAME is NOT a real profile id → must fall back to
    # default_voice (the silent-default bug fix), NOT be treated as a literal id.
    ab, seen = _generic_synth_recording(monkeypatch)
    monkeypatch.setattr(ab, "_voice_profile_exists", lambda _pid: False)
    info = ab._build_synth("default-pid", voice_map=None)
    info["synth"]("hello", "Mara")
    assert seen == ["default-pid"]


def test_exact_profile_id_still_resolves_as_itself(monkeypatch):
    # An unmapped token that IS a real profile id (someone passed an exact id,
    # e.g. a Stories span) must resolve unchanged — exact-id back-compat.
    ab, seen = _generic_synth_recording(monkeypatch)
    monkeypatch.setattr(ab, "_voice_profile_exists", lambda pid: pid == _PID)
    info = ab._build_synth("default-pid", voice_map=None)
    info["synth"]("hello", _PID)
    assert seen == [_PID]


def test_none_voice_uses_default_without_a_db_probe(monkeypatch):
    # A run with no [voice:] (None) resolves to default_voice and must never hit
    # the profile-existence DB probe.
    ab, seen = _generic_synth_recording(monkeypatch)

    def _boom(_pid):  # would fire only if None wrongly reached the probe
        raise AssertionError("None must not probe the DB")

    monkeypatch.setattr(ab, "_voice_profile_exists", _boom)
    info = ab._build_synth("default-pid", voice_map={"Mara": _PID})
    info["synth"]("hello", None)
    assert seen == ["default-pid"]


# ── chapter / segment / preview cache keys follow each span's own voice ─────

def _profiles(monkeypatch):
    """Profiles resolve to their own reference take (as real ones do); a bare
    name is never a profile id; the engine is ``eng`` at 24 kHz, unmarked.
    Returns the router module."""
    import api.routers.audiobook as ab
    import services.tts_backend as tb
    import services.watermark as wm

    monkeypatch.setattr(tb, "active_backend_id", lambda: "eng")
    monkeypatch.setattr(ab, "_local_sample_rate", lambda engine: 24000 if engine == "eng" else None)
    monkeypatch.setattr(wm, "will_mark", lambda: False)
    monkeypatch.setattr(wm, "mark_synthetic", lambda audio, *_a, **_k: audio)

    def resolve_voice(pid):
        if not pid:
            return {"ref_audio": None, "ref_text": None, "instruct": None, "seed": None}
        return {"ref_audio": f"/voices/{pid}.wav", "ref_text": f"said by {pid}",
                "instruct": None, "seed": None}

    monkeypatch.setattr(ab, "_resolve_voice", resolve_voice)
    monkeypatch.setattr(ab, "_voice_profile_exists", lambda _pid: False)
    return ab


def _counting_synth(calls):
    def synth(text, voice_id, speed=None):
        calls.append(text)
        return torch.full((2400,), 0.1)
    return synth


def _render(ab, tmp_path, chapter, voice_map, calls=None):
    """Render ``chapter`` as a book render does, the cast resolved through
    ``voice_map``: ``(chapter key, cached)``."""
    wav_path, _dur, cached, _stats = ab._render_chapter_cached(
        chapter, _counting_synth([] if calls is None else calls), 24000, "eng",
        ab._voice_resolver("default-pid", voice_map), str(tmp_path), None, None,
        ExpressiveOptions(), voice_map, default_voice="default-pid",
    )
    return os.path.basename(wav_path), cached


def _render_key(ab, tmp_path, voice_map):
    ch = Chapter(title="C", spans=[Span(voice_id="Mara", text="hello", pause_ms_after=0)])
    return _render(ab, tmp_path, ch, voice_map)[0]


def test_chapter_cache_key_changes_when_the_map_changes(tmp_path, monkeypatch):
    ab = _profiles(monkeypatch)
    base = _render_key(ab, tmp_path, None)                   # no map
    empty = _render_key(ab, tmp_path, {})                    # empty map == no map
    a = _render_key(ab, tmp_path, {"Mara": _PID})            # mapped one way
    b = _render_key(ab, tmp_path, {"Mara": "other-pid"})     # remapped
    assert empty == base, "an absent/empty map must keep today's cache key"
    assert a != base, "adding a mapping must re-render"
    assert b != a, "remapping a voice must re-render"


def _two_voice_chapter(title="C", minor="Cole"):
    return Chapter(title=title, spans=[
        Span(voice_id=None, text="The narrator opens.", pause_ms_after=0),
        Span(voice_id="Mara", text="Mara answers him.", pause_ms_after=0),
        Span(voice_id=minor, text="A short reply.", pause_ms_after=0),
        Span(voice_id="Mara", text="Mara goes on talking.", pause_ms_after=0),
    ])


def test_recasting_one_voice_renders_only_that_voices_lines(tmp_path, monkeypatch):
    """The whole cast map used to key every segment, so recasting the voice
    of one line re-rendered every line of the book. A span is keyed by the
    voice it resolves to, so only the recast voice's lines render again."""
    ab = _profiles(monkeypatch)
    calls: list = []
    _render(ab, tmp_path, _two_voice_chapter(), {"Mara": _PID, "Cole": "pid-a"}, calls)
    assert len(calls) == 4
    calls.clear()
    _key, cached = _render(ab, tmp_path, _two_voice_chapter(),
                           {"Mara": _PID, "Cole": "pid-b"}, calls)
    assert cached is False
    assert calls == ["A short reply."]


def test_chapters_without_the_recast_voice_keep_their_audio(tmp_path, monkeypatch):
    ab = _profiles(monkeypatch)
    other = Chapter(title="D", spans=[
        Span(voice_id="Mara", text="Only Mara speaks here.", pause_ms_after=0)])
    _render(ab, tmp_path, other, {"Mara": _PID, "Cole": "pid-a"})
    calls: list = []
    key, cached = _render(ab, tmp_path, other, {"Mara": _PID, "Cole": "pid-b"}, calls)
    assert cached is True and calls == []
    # …and the outline reads it as rendered under the same key.
    states = ab._chapter_cache_state(
        other, decision=types.SimpleNamespace(remote=False), default_voice="default-pid",
        language=None, opts=ExpressiveOptions(), voice_map={"Mara": _PID, "Cole": "pid-b"},
        lexicon=None, cache_dir=str(tmp_path))
    assert states[:2] == (os.path.splitext(key)[0], True)


def _legacy_keys(ab, tmp_path, chapter, voice_map):
    """Where builds before per-voice keys cached ``chapter``: the whole cast
    map folded into the chapter key and into every segment's extra
    signature (the derivation as it shipped, written out here on purpose)."""
    from services.longform_render import SEGMENT_SUBDIR, chapter_cache_key, segment_cache_key

    keys = ab._chapter_cache_keys(chapter, 24000, "eng",
                                  ab._voice_resolver("default-pid", voice_map), str(tmp_path),
                                  opts=ExpressiveOptions(), voice_map=voice_map,
                                  default_voice="default-pid")
    vmap = voice_map_signature(voice_map)
    chapter_key = chapter_cache_key([ab._span_key_tuple(s) for s in keys.spans],
                                    sample_rate=24000, engine_id="eng",
                                    voice_sig={**keys.voice_sigs, "\x00voicemap": vmap})
    segments = {
        s.text: os.path.join(str(tmp_path), SEGMENT_SUBDIR, segment_cache_key(
            s.text, sample_rate=24000, engine_id="eng", voice_id=s.voice_id,
            voice_sig=keys.voice_sigs[s.voice_id or ""], extra_sig=f"\x00{vmap}") + ".wav")
        for s in keys.spans}
    return os.path.join(str(tmp_path), f"{chapter_key}.wav"), segments


def _write_wav(path, frames=2400):
    import wave

    os.makedirs(os.path.dirname(path), exist_ok=True)
    with wave.open(path, "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(24000)
        w.writeframes(b"\x10\x00" * frames)


def test_a_book_cached_with_the_whole_map_in_its_keys_is_still_found(tmp_path, monkeypatch):
    ab = _profiles(monkeypatch)
    cast = {"Mara": _PID, "Cole": "pid-a"}
    chapter = _two_voice_chapter()
    legacy_chapter, legacy_segments = _legacy_keys(ab, tmp_path, chapter, cast)
    _write_wav(legacy_chapter)
    calls: list = []
    key, cached = _render(ab, tmp_path, chapter, cast, calls)
    assert cached is True and calls == []
    assert key != os.path.basename(legacy_chapter)  # moved to the per-voice key
    assert os.path.exists(os.path.join(str(tmp_path), key))
    # The segment layer finds its older segments the same way.
    for path in legacy_segments.values():
        _write_wav(path)
    os.remove(os.path.join(str(tmp_path), key))
    _key, cached = _render(ab, tmp_path, chapter, cast, calls)
    assert cached is False and calls == []


def test_the_outline_reads_a_book_keyed_before_per_voice_keys_as_unchanged(
        tmp_path, monkeypatch):
    ab = _profiles(monkeypatch)
    cast = {"Mara": _PID, "Cole": "pid-a"}
    chapter = _two_voice_chapter()
    legacy_chapter, _segments = _legacy_keys(ab, tmp_path, chapter, cast)
    key, cached, names = ab._chapter_cache_state(
        chapter, decision=types.SimpleNamespace(remote=False), default_voice="default-pid",
        language=None, opts=ExpressiveOptions(), voice_map=cast, lexicon=None,
        cache_dir=str(tmp_path))
    assert key != os.path.splitext(os.path.basename(legacy_chapter))[0]
    # The book's timeline recorded the old name: the same audio, not a change.
    assert os.path.splitext(os.path.basename(legacy_chapter))[0] in names


# ── render / preview parity ─────────────────────────────────────────────────

def test_preview_and_render_requests_carry_and_key_on_the_same_map(tmp_path, monkeypatch):
    from api.routers.audiobook import AudiobookPreviewRequest, AudiobookRequest

    ab = _profiles(monkeypatch)
    vm = {"Mara": _PID, "Cole": "pid2"}
    r = AudiobookRequest(text="# A\n[voice:Mara] hi", voice_map=vm)
    p = AudiobookPreviewRequest(text="# A\n[voice:Mara] hi", voice_map=vm)
    assert r.voice_map == p.voice_map == vm
    # …and therefore the same chapter cache slot (preview warms what render reuses).
    assert _render_key(ab, tmp_path, r.voice_map) == _render_key(ab, tmp_path, p.voice_map)


def test_default_request_omits_the_map(tmp_path, monkeypatch):
    from api.routers.audiobook import AudiobookRequest

    ab = _profiles(monkeypatch)
    # An untouched request has no map → today's exact key (no re-render).
    assert AudiobookRequest(text="# A\nhi").voice_map is None
    assert _render_key(ab, tmp_path, None) == _render_key(ab, tmp_path, {})
