"""SSML-LITE inline markup parser (PR 8).

Pure tests: every tag type, nesting, unclosed-to-EOL, plain text, mixed input,
stray closes, and the spell_out helper. No torch, no I/O, no main import.
"""
from __future__ import annotations

from services.ssml_lite import (
    EMPHASIS_SPEED,
    FAST_SPEED,
    SLOW_SPEED,
    parse_ssml_lite,
    spell_out,
)


def test_plain_text_single_segment():
    segs = parse_ssml_lite("just a plain line")
    assert segs == [
        {"text": "just a plain line", "speed": None, "spell": False, "emphasis": False}
    ]


def test_empty_and_none():
    assert parse_ssml_lite("") == []
    assert parse_ssml_lite(None) == []


def test_slow_tag():
    segs = parse_ssml_lite("a [slow]b[/slow] c")
    assert [s["text"] for s in segs] == ["a ", "b", " c"]
    assert segs[0]["speed"] is None
    assert segs[1]["speed"] == SLOW_SPEED
    assert segs[2]["speed"] is None


def test_fast_tag():
    segs = parse_ssml_lite("[fast]zoom[/fast]")
    assert len(segs) == 1
    assert segs[0]["text"] == "zoom"
    assert segs[0]["speed"] == FAST_SPEED
    assert segs[0]["spell"] is False


def test_emphasis_tag_sets_speed_and_flag():
    segs = parse_ssml_lite("[emphasis]wow[/emphasis]")
    assert segs[0]["speed"] == EMPHASIS_SPEED
    assert segs[0]["emphasis"] is True
    assert segs[0]["spell"] is False


def test_spell_tag_sets_flag_not_speed():
    segs = parse_ssml_lite("call [spell]NASA[/spell] now")
    middle = segs[1]
    assert middle["text"] == "NASA"
    assert middle["spell"] is True
    assert middle["speed"] is None


def test_nesting_innermost_speed_wins():
    # [fast] nested inside [slow] -> fast wins inside the inner run.
    segs = parse_ssml_lite("[slow]a[fast]b[/fast]c[/slow]")
    by_text = {s["text"]: s for s in segs}
    assert by_text["a"]["speed"] == SLOW_SPEED
    assert by_text["b"]["speed"] == FAST_SPEED
    assert by_text["c"]["speed"] == SLOW_SPEED


def test_nesting_spell_inside_slow_keeps_both():
    segs = parse_ssml_lite("[slow]x[spell]Y[/spell]z[/slow]")
    by_text = {s["text"]: s for s in segs}
    assert by_text["Y"]["speed"] == SLOW_SPEED  # outer slow still applies
    assert by_text["Y"]["spell"] is True
    assert by_text["x"]["spell"] is False
    assert by_text["z"]["spell"] is False


def test_unclosed_applies_to_eol():
    segs = parse_ssml_lite("start [slow]rest of line")
    assert segs[0]["text"] == "start "
    assert segs[0]["speed"] is None
    assert segs[1]["text"] == "rest of line"
    assert segs[1]["speed"] == SLOW_SPEED


def test_unclosed_nested_both_to_eol():
    segs = parse_ssml_lite("[slow]a[spell]b")
    by_text = {s["text"]: s for s in segs}
    assert by_text["a"]["speed"] == SLOW_SPEED and by_text["a"]["spell"] is False
    assert by_text["b"]["speed"] == SLOW_SPEED and by_text["b"]["spell"] is True


def test_stray_close_ignored():
    segs = parse_ssml_lite("hello[/slow]world")
    # Markers stripped; the two plain runs merge into one segment.
    assert segs == [
        {"text": "helloworld", "speed": None, "spell": False, "emphasis": False}
    ]


def test_only_markers_yields_no_segments():
    assert parse_ssml_lite("[slow][/slow]") == []


def test_mixed_tags_in_one_line():
    segs = parse_ssml_lite("Say [slow]hi[/slow] then [fast]bye[/fast]!")
    texts = [s["text"] for s in segs]
    assert texts == ["Say ", "hi", " then ", "bye", "!"]
    assert segs[1]["speed"] == SLOW_SPEED
    assert segs[3]["speed"] == FAST_SPEED
    assert segs[0]["speed"] is None and segs[4]["speed"] is None


def test_adjacent_plain_runs_merge():
    # Open+immediate-close around nothing, surrounded by text -> single seg.
    segs = parse_ssml_lite("foo[slow][/slow]bar")
    assert segs == [
        {"text": "foobar", "speed": None, "spell": False, "emphasis": False}
    ]


def test_case_insensitive_tags():
    segs = parse_ssml_lite("[SLOW]x[/Slow]")
    assert segs[0]["speed"] == SLOW_SPEED


def test_spell_out_basic():
    assert spell_out("USA") == "U S A"
    assert spell_out("a") == "a"


def test_spell_out_strips_and_joins_whitespace():
    assert spell_out("  hi  ") == "h i"
    assert spell_out("go USA") == "g o U S A"
    assert spell_out("") == ""


def test_redos_safe_on_adversarial_input():
    # Many bracket-like fragments must not blow up (linear-time guarantee).
    import time

    payload = "[slow]" * 5000 + "x"
    t0 = time.perf_counter()
    segs = parse_ssml_lite(payload)
    assert time.perf_counter() - t0 < 1.0
    # All 5000 opens unclosed -> the single 'x' run is slow.
    assert segs[-1]["text"] == "x"
    assert segs[-1]["speed"] == SLOW_SPEED


# ── [volume ±N dB]…[/volume] ─────────────────────────────────────────────────

def test_volume_sets_a_gain_only_on_the_wrapped_words():
    segs = parse_ssml_lite("a [volume -6dB]b[/volume] c")
    assert segs == [
        {"text": "a ", "speed": None, "spell": False, "emphasis": False},
        {"text": "b", "speed": None, "spell": False, "emphasis": False, "gain_db": -6.0},
        {"text": " c", "speed": None, "spell": False, "emphasis": False},
    ]


def test_volume_accepts_db_spellings_a_space_and_a_bare_number():
    for tag in ("[volume -3dB]", "[volume -3db]", "[VOLUME -3DB]", "[volume -3 dB]",
                "[volume -3]", "[volume\t-3.0]"):
        assert parse_ssml_lite(f"{tag}x[/volume]")[0]["gain_db"] == -3.0, tag
    assert parse_ssml_lite("[volume +2]x")[0]["gain_db"] == 2.0  # unclosed: to the end


def test_volume_nesting_adds_and_clamps_to_twelve_db():
    by_text = {s["text"]: s.get("gain_db") for s in parse_ssml_lite(
        "[volume 3]a[volume 4]b[volume 20]c[/volume][/volume][/volume][volume -30]d")}
    assert by_text == {"a": 3.0, "b": 7.0, "c": 12.0, "d": -12.0}


def test_volume_without_a_readable_gain_is_literal_text():
    for text in ("[volume]x", "[volume loud]x", "x[/volume 3]", "[volume 12345]x",
                 "[slow 3]x", "[volume 1e3]x"):
        segs = parse_ssml_lite(text)
        assert [s["text"] for s in segs] == [text] and "gain_db" not in segs[0], text


def test_volume_open_tags_write_the_gain_back():
    from services.ssml_lite import open_tags

    assert open_tags("[slow]a [volume -6dB]b") == ["slow", "volume -6"]
    assert open_tags("[volume -6dB]b[/volume]") == []
    # Written back, the open tag reads the same gain.
    assert parse_ssml_lite("[volume -6]x")[0]["gain_db"] == -6.0
