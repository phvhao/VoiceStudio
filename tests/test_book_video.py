"""The MP4 video of a finished book (``services.book_video``)."""
import asyncio
import os
import re
import shutil
import subprocess
import sys

import pytest

from services import book_video as v


def _timeline(**extra):
    doc = {"version": 1, "output": "audiobook_x.m4b", "duration": 40.0, "chapters": [
        {"title": "One", "start": 0.0, "end": 20.0, "precision": "phrase", "sections": [],
         "phrases": [{"text": "Hello there, my friend.", "start": 0.5, "end": 3.0, "voice": None},
                     {"text": "Bye.", "start": 3.5, "end": 4.0, "voice": None}],
         "images": [{"phrase": 0, "start": 0.5, "name": "a.jpg", "fit": "auto"},
                    {"phrase": 1, "start": 3.5, "name": "b.jpg", "fit": "contain"}]},
        {"title": "Chapter 2", "untitled": True, "start": 20.0, "end": 40.0,
         "precision": "chapter", "sections": [],
         "phrases": [{"text": "All of it, evenly.", "start": 20.0, "end": 40.0, "voice": None}],
         "images": [{"phrase": 0, "start": 20.0, "name": None, "fit": "auto"}]},
    ]}
    doc.update(extra)
    return doc


@pytest.mark.parametrize("aspect, quality, size", [
    ("16:9", 1080, (1920, 1080)), ("16:9", 720, (1280, 720)),
    ("9:16", 1080, (1080, 1920)), ("1:1", 720, (720, 720)), ("nope", 720, (1280, 720)),
])
def test_frame_size(aspect, quality, size):
    assert v.frame_size(aspect, quality) == size


def test_scenes_start_on_the_backdrop_and_follow_the_script():
    scenes = v.scenes_of(_timeline())
    assert [(s.start, s.name, s.fit) for s in scenes] == [
        (0.0, None, "auto"), (0.5, "a.jpg", "auto"), (3.5, "b.jpg", "contain"), (20.0, None, "auto")]
    # Two pictures at one moment: the later one; the same picture again: one scene.
    doc = _timeline()
    doc["chapters"][0]["images"] = [
        {"start": 0.0, "name": "x.jpg"}, {"start": 0.0, "name": "y.jpg"},
        {"start": 5.0, "name": "y.jpg"}, {"start": "bad", "name": "z.jpg"}]
    doc["chapters"][1]["images"] = []
    assert [(s.start, s.name) for s in v.scenes_of(doc)] == [(0.0, "y.jpg")]


def test_parts_are_frame_exact_and_crossfade_only_when_long_enough():
    scenes = [v.Scene(0.0, None), v.Scene(0.5, "a.jpg"), v.Scene(3.5, "b.jpg"), v.Scene(20.0, None)]
    parts = v.plan_parts(scenes, 40.0)
    assert sum(p.frames for p in parts) == 1000
    assert [p.first for p in parts] == [0, 12, 88, 500]
    fade = v.crossfade_frames()
    # 12 frames of backdrop are too short to fade out of; the rest are not.
    assert [(p.fade_in, p.fade_out) for p in parts] == [
        (False, False), (False, True), (True, True), (True, False)]
    assert all(p.frames > 2 * fade for p in parts if p.fade_out)
    assert all(not p.fade_in and not p.fade_out
               for p in v.plan_parts(scenes, 40.0, transitions=False))
    # Pictures after the end are not parts; a book with none is one part.
    assert len(v.plan_parts(scenes + [v.Scene(99.0, "late.jpg")], 40.0)) == 4
    assert [(p.first, p.frames) for p in v.plan_parts([v.Scene(0.0, None)], 2.0)] == [(0, 50)]


def test_words_are_timed_by_their_letters_as_the_reader_times_them():
    timed = v.time_words(["Hello", "—", "my", "friend."], 0.0, 1.3)
    assert [w for w, _, _ in timed] == ["Hello", "—", "my", "friend."]
    starts = [round(s, 3) for _, s, _ in timed]
    assert starts == [0.0, 0.5, 0.5, 0.7]  # 5 + 0 + 2 + 6 letters over 1.3 s
    assert timed[-1][2] == pytest.approx(1.3)
    even = v.time_words(["a", "bbb"], 0.0, 1.0, even=True)
    assert [round(s, 3) for _, s, _ in even] == [0.0, 0.5]


def test_long_sentences_become_captions_that_fit_and_never_overlap():
    words = ("Bất kể là học trưởng ôn nhu như ngọc, hay bá chủ trường học kiêu ngạo bất kham, "
             "chỉ cần hẹn hò với tôi một lần, ngày hôm sau nhất định sẽ cắm sừng tôi.").split()
    doc = {"chapters": [{"precision": "phrase", "phrases": [
        {"text": " ".join(words), "start": 1.0, "end": 13.0},
        {"text": "Ngắn.", "start": 13.5, "end": 14.0}]}]}
    cues = v.caption_cues(doc, 50)
    assert len(cues) >= 3
    assert all(len(" ".join(w for w, _, _ in cue.words)) <= 50 for cue in cues)
    assert [w for cue in cues[:-1] for w, _, _ in cue.words] == words
    for cue, following in zip(cues, cues[1:]):
        assert cue.end <= following.start + 1e-9
    # A break after a comma near the even share is preferred.
    assert cues[0].words[-1][0].endswith(",")
    # A pause shorter than CAPTION_HOLD_S keeps the caption up until the next.
    assert cues[-2].end == pytest.approx(cues[-1].start)


def test_karaoke_text_fills_each_word_and_escapes_the_script():
    cue = v.Cue(1.0, 3.0, [("{odd}", 1.2, 1.8), ("back\\slash", 1.8, 2.6)])
    text = v.karaoke_text(cue)
    assert text == "{\\k20}{\\kf60}\\{odd\\} {\\kf80}back\u29f5slash"
    durations = sum(int(n) for n in re.findall(r"\\kf?(\d+)", text))
    assert durations == round((2.6 - 1.0) * 100)
    assert v.karaoke_text(cue, karaoke=False) == "\\{odd\\} back\u29f5slash"


def test_subtitle_script_has_captions_and_titles_styled_for_the_frame():
    opts = v.VideoOptions(aspect="9:16", quality=720, accent="#112233")
    script = v.build_ass(_timeline(), opts, font_family="Be Vietnam Pro",
                         book_title="My Book", author="An")
    assert "PlayResX: 720" in script and "PlayResY: 1280" in script
    assert "Style: Caption,Be Vietnam Pro," in script
    assert ",&H00332211,&H00FFFFFF," in script  # sung: the accent; unsung: white
    titles = [line for line in script.splitlines() if ",Title," in line and line.startswith("Dialogue")]
    # The book's title opens; an untitled chapter shows none; "One" starts under the book title.
    assert len(titles) == 1 and "My Book\\N" in titles[0] and "An" in titles[0]
    captions = [line for line in script.splitlines() if ",Caption," in line]
    assert captions and all("\\kf" in line for line in captions)
    plain = v.build_ass(_timeline(), v.VideoOptions(captions=False, titles=False),
                        font_family="X")
    assert "Dialogue:" not in plain


def test_part_graph_holds_still_once_the_zoom_settles_and_names_files_relatively():
    fade = v.crossfade_frames()
    long_part = v.Part(first=250, frames=v.FPS * 120, scene=v.Scene(10.0, "a.jpg"), index=1,
                       fade_in=True, fade_out=True)
    following = v.Part(first=250 + v.FPS * 120, frames=500, scene=v.Scene(130.0, "b.jpg"),
                       index=2, fade_in=True)
    graph = v.part_graph(long_part, size=(1280, 720), motion=True, shade=True,
                         subtitles="captions.ass", fonts="fonts", next_part=following)
    assert "split=2" in graph and "loop=loop=" in graph and "concat=n=2" in graph
    assert f"xfade=transition=fade:duration={fade / v.FPS:.6f}" in graph
    assert "[2:v]overlay" in graph
    assert "setpts=PTS-STARTPTS+250/25/TB,ass=filename=captions.ass:fontsdir=fonts" in graph
    # Files are named relative to the run's folder: nothing in the graph to escape.
    assert "\\" not in graph and "/Users" not in graph
    still = v.part_graph(v.Part(first=0, frames=100, scene=v.Scene(0.0, None)), size=(1280, 720),
                         motion=False, shade=False, subtitles=None, fonts="fonts")
    assert "zoompan" not in still and "ass=" not in still and "trim=end_frame=100" in still


def test_commands_keep_inputs_local_and_copy_aac_audio():
    part = v.Part(first=0, frames=50, scene=v.Scene(0.0, None), fade_out=True)
    cmd = v.part_cmd("ffmpeg", part, picture="picture-0.png", next_picture="picture-1.png",
                     shade="shade.png", graph_file="part-0.graph", output="part-0.mp4",
                     progress="part-0.progress")
    assert cmd.count("-protocol_whitelist") == 3
    assert cmd[-1] == "part-0.mp4" and "-progress" in cmd and "-an" in cmd
    mux = v.mux_cmd("ffmpeg", parts_list="parts.txt", audio="/out/book.m4b", output="v.mp4",
                    title="T")
    assert mux[mux.index("-c:a") + 1] == "copy" and "-map_chapters" in mux
    mux = v.mux_cmd("ffmpeg", parts_list="parts.txt", audio="/out/book.mp3", output="v.mp4")
    assert mux[mux.index("-c:a") + 1] == "aac"


def test_progress_file_is_read_from_its_last_report(tmp_path):
    path = tmp_path / "p.progress"
    assert v.read_progress_frame(str(path)) == 0
    path.write_text("frame=10\nfps=0\nprogress=continue\nframe=42\nprogress=continue\n")
    assert v.read_progress_frame(str(path)) == 42


def test_run_reports_progress_skips_missing_pictures_and_cleans_nothing_it_was_not_given(tmp_path):
    from PIL import Image

    pic = tmp_path / "a.jpg"
    Image.new("RGB", (64, 48), (200, 10, 10)).save(pic)
    calls = []

    async def runner(cmd, timeout, capture, job_id, cwd):
        calls.append((cmd, cwd))
        out = cmd[-1]
        if "-progress" in cmd:
            with open(os.path.join(cwd, cmd[cmd.index("-progress") + 1]), "w") as fh:
                fh.write("frame=5\nprogress=end\n")
        with open(out if os.path.isabs(out) else os.path.join(cwd, out), "wb") as fh:
            fh.write(b"x")
        return 0, b"", b""

    async def run():
        events = []
        async for event in v.render_video(
                ffmpeg="ffmpeg", audio=str(tmp_path / "book.m4b"), timeline=_timeline(),
                options=v.VideoOptions(quality=720), workdir=str(tmp_path),
                output=str(tmp_path / "video.mp4"),
                picture_path=lambda name: str(pic) if name == "a.jpg" else None,
                book_title="Book", runner=runner):
            events.append(event)
        return events

    events = asyncio.run(run())
    assert events[0] == {"type": "start", "frames": 1000, "parts": 3, "missing": ["b.jpg"]}
    assert events[-1] == {"type": "finishing"}
    assert any(e["type"] == "progress" and e["frame"] >= 5 for e in events)
    assert len(calls) == 4 and all(cwd == str(tmp_path) for _, cwd in calls)
    assert (tmp_path / "captions.ass").read_text(encoding="utf-8").count("Dialogue:") >= 3
    assert (tmp_path / "fonts").is_dir() and any(n.endswith(".ttf") for n in os.listdir(tmp_path / "fonts"))


def test_a_failed_encode_says_so_without_ffmpegs_words(tmp_path):
    async def runner(cmd, timeout, capture, job_id, cwd):
        return 1, b"", b"Error opening C:\\Users\\someone\\secret.png"

    async def run():
        async for _ in v.render_video(
                ffmpeg="ffmpeg", audio="book.m4b", timeline=_timeline(),
                options=v.VideoOptions(captions=False, titles=False), workdir=str(tmp_path),
                output="v.mp4", picture_path=lambda name: None, runner=runner):
            pass

    with pytest.raises(v.VideoFailed) as failed:
        asyncio.run(run())
    assert failed.value.code == "video_encode_failed" and "someone" not in str(failed.value)


def test_captions_fall_back_to_the_system_font_when_the_font_cannot_be_written(
        tmp_path, monkeypatch):
    # An environment not synced since fontTools arrived: no import, no failure.
    monkeypatch.setitem(sys.modules, "fontTools.ttLib", None)
    assert v.write_fonts(None, str(tmp_path / "fonts")) == "Sans"
    monkeypatch.undo()
    family = v.write_fonts(None, str(tmp_path / "fonts"))
    assert family != "Sans" and any(name.endswith(".ttf") for name in os.listdir(tmp_path / "fonts"))


def test_an_ffmpeg_that_cannot_be_asked_is_no_answer(tmp_path):
    assert v.missing_tools(str(tmp_path / "no-such-ffmpeg")) is None


def _real_ffmpeg():
    from services.ffmpeg_utils import find_ffmpeg

    ffmpeg = find_ffmpeg()
    if not ffmpeg or v.missing_tools(ffmpeg) != []:
        pytest.skip("no ffmpeg with libx264 and libass here")
    return ffmpeg


def test_a_real_short_book_becomes_a_frame_exact_mp4(tmp_path):
    ffmpeg = _real_ffmpeg()
    from PIL import Image

    audio = tmp_path / "book.m4a"
    subprocess.run([ffmpeg, "-y", "-loglevel", "error", "-f", "lavfi", "-i",
                    "sine=frequency=220:duration=3", "-c:a", "aac", str(audio)], check=True)
    pic = tmp_path / "a.jpg"
    Image.new("RGB", (400, 300), (30, 60, 90)).save(pic)
    timeline = {"duration": 3.0, "chapters": [{
        "title": "One", "start": 0.0, "end": 3.0, "precision": "phrase",
        "phrases": [{"text": "Xin chào các bạn.", "start": 0.2, "end": 2.6}],
        "images": [{"phrase": 0, "start": 1.2, "name": "a.jpg", "fit": "auto"}]}]}
    work = tmp_path / "work"
    work.mkdir()
    out = tmp_path / "video.mp4"

    async def run():
        return [e async for e in v.render_video(
            ffmpeg=ffmpeg, audio=str(audio), timeline=timeline,
            options=v.VideoOptions(quality=720), workdir=str(work), output=str(out),
            picture_path=lambda name: str(pic), book_title="Sách")]

    events = asyncio.run(run())
    assert events[0]["frames"] == 75 and events[-1] == {"type": "finishing"}
    probe = subprocess.run([ffmpeg, "-hide_banner", "-i", str(out), "-map", "0:v", "-f", "null", "-"],
                           capture_output=True, text=True).stderr
    frames = re.findall(r"frame=\s*(\d+)", probe)
    assert frames and int(frames[-1]) == 75
    assert "Audio: aac" in probe and "1280x720" in probe
    shutil.rmtree(work)
