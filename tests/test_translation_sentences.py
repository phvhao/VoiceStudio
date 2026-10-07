"""Sentence-level translation helpers (services/translation_sentences.py).

Sentence-trained translators drop all but one sentence of a multi-sentence
segment, so Dub translation splits segments into sentences, translates them
as rows and joins them per target script; every translator's output is then
checked for omitted content. These tests pin the splitter's cuts (and the
cuts it must not make), the per-script join, and the omission verdict on
real NLLB-200 outputs (complete and with a sentence dropped).
"""
from __future__ import annotations

import pytest

from services.translation_sentences import (
    join_translations,
    omission_verdict,
    sentence_count,
    split_for_translation,
)

_USER_CASE = (
    "the opposite, which means that you forget as much as you learn. "
    "But the important question is, what do you forget?"
)


def _texts(pieces):
    return [text for text, _separator in pieces]


# ── Splitting ──────────────────────────────────────────────────────────


def test_user_case_splits_into_its_two_sentences():
    assert split_for_translation(_USER_CASE) == [
        ("the opposite, which means that you forget as much as you learn.", " "),
        ("But the important question is, what do you forget?", ""),
    ]


@pytest.mark.parametrize("text, expected", [
    ("Mr. Smith went to Washington D.C. yesterday. He said hi.",
     ["Mr. Smith went to Washington D.C. yesterday.", "He said hi."]),
    ("It costs 3.5 dollars. Visit example.com now!",
     ["It costs 3.5 dollars.", "Visit example.com now!"]),
    # A period glued to a lowercase word or digit is part of a name.
    ("Open readme.txt now. Node.js is great.", ["Open readme.txt now.", "Node.js is great."]),
    # A semicolon or a trailing ellipsis before lowercase continues the sentence.
    ("A list: one; two; three.", ["A list: one; two; three."]),
    ("I was… thinking about it.", ["I was… thinking about it."]),
    # Scripts with their own sentence marks. A dense script's characters say
    # more each: five of them are a sentence of their own.
    ("その逆です。しかし重要です。",
     ["その逆です。", "しかし重要です。"]),
    ("यह पहला वाक्य है। यह दूसरा वाक्य है।",
     ["यह पहला वाक्य है।", "यह दूसरा वाक्य है।"]),
    ("هل أنت بخير اليوم؟ نعم، أنا بخير تماما.",
     ["هل أنت بخير اليوم؟", "نعم، أنا بخير تماما."]),
])
def test_sentence_cuts(text, expected):
    assert _texts(split_for_translation(text)) == expected


@pytest.mark.parametrize("text, expected", [
    # NLLB-200 answered each of these alone with a sentence of its own
    # (de "1. Das ist nicht der Fall.", "- Nein, ich weiß nicht.", vi "Ồ. Ồ."),
    # where the whole line translated faithfully.
    ("No. You cannot go out tonight, it is too late.",
     ["No. You cannot go out tonight, it is too late."]),
    ("Oh. I did not see you standing there.",
     ["Oh. I did not see you standing there."]),
    # A list's number goes with its item, and an item stays an item: "3. Read
    # it." translates whole, where joined to the item before it was dropped.
    ("1. Open the box. 2. Take out the manual. 3. Read it.",
     ["1. Open the box.", "2. Take out the manual.", "3. Read it."]),
    ("Step 1. Mix the flour and the water. Step 2. Bake it for an hour.",
     ["Step 1. Mix the flour and the water.", "Step 2. Bake it for an hour."]),
    # A short last sentence joins the one before it.
    ("We are going now, all of us together. Okay.",
     ["We are going now, all of us together. Okay."]),
    ("Yes. Okay. Right. We are going now, all of us together.",
     ["Yes. Okay. Right.", "We are going now, all of us together."]),
    # The same in other scripts: a short reply joins the question.
    ("यह एक है। यह दूसरा है।", ["यह एक है। यह दूसरा है।"]),
    ("هل أنت بخير؟ نعم.", ["هل أنت بخير؟ نعم."]),
])
def test_a_sentence_too_short_to_translate_alone_joins_its_neighbour(text, expected):
    assert _texts(split_for_translation(text)) == expected


def test_a_short_sentence_on_its_own_caption_line_keeps_the_line():
    """Joining across a caption's line break would lose the break."""
    pieces = split_for_translation("Who is there at the door?\nMe.")
    assert pieces == [("Who is there at the door?", "\n"), ("Me.", "")]


@pytest.mark.parametrize("text, expected", [
    # The splitter keeps only " and ” with their sentence; every other
    # closing mark used to open the next one ("」と彼は言った。").
    ("「行こう。」と彼は言った。でも誰も動かなかった。",
     ["「行こう。」と彼は言った。", "でも誰も動かなかった。"]),
    ("“我们走吧。”他说。然后他走了。",
     ["“我们走吧。”他说。", "然后他走了。"]),
    ("He said ‘Stop.’ Then he left.", ["He said ‘Stop.’", "Then he left."]),
    ("He said 'Stop.' Then he left.", ["He said 'Stop.'", "Then he left."]),
    ("‘I don’t know.’ She shrugged and walked away.",
     ["‘I don’t know.’", "She shrugged and walked away."]),
    ("Il a dit « Arrête. » Puis il est parti.",
     ["Il a dit « Arrête. »", "Puis il est parti."]),
    ("Er sagte „Halt.“ Dann ging er.", ["Er sagte „Halt.“", "Dann ging er."]),
    ("Er sagte »Halt.« Dann ging er.", ["Er sagte »Halt.«", "Dann ging er."]),
    # A quotation's sentence going on after it stays whole.
    ("'Stop!' he said. Then he left.", ["'Stop!' he said.", "Then he left."]),
    # A bracketed aside, too short alone, joins the sentence after it.
    ("(Laughs.) Okay, let's get started.", ["(Laughs.) Okay, let's get started."]),
])
def test_a_closing_quote_stays_with_the_sentence_it_closes(text, expected):
    assert _texts(split_for_translation(text)) == expected


def test_line_break_inside_a_sentence_does_not_cut_it_but_one_after_a_sentence_is_kept():
    pieces = split_for_translation("First line, still going\nthe second line.\nThird!")
    assert pieces == [("First line, still going the second line.", "\n"), ("Third!", "")]


def test_unspeakable_pieces_join_a_neighbour_and_empty_text_has_none():
    assert _texts(split_for_translation("— Yes. —")) == ["— Yes. —"]
    assert split_for_translation("   ") == []


def test_clause_pass_cuts_at_commas_but_keeps_short_clauses_and_numbers_whole():
    assert _texts(split_for_translation(_USER_CASE, clauses=True)) == [
        "the opposite,",
        "which means that you forget as much as you learn.",
        "But the important question is,",
        "what do you forget?",
    ]
    assert _texts(split_for_translation("Well, sir, I think so. It was 1,000 at 10:30.", clauses=True)) == [
        "Well, sir, I think so.", "It was 1,000 at 10:30.",
    ]
    # A short fullwidth clause stays with the next one, without a space.
    dense = "その逆で、学んだのと同じくらい忘れる。"
    assert _texts(split_for_translation(dense, clauses=True)) == [dense]


# ── Joining ────────────────────────────────────────────────────────────


def test_join_spaces_sentences_and_keeps_line_breaks():
    pieces = split_for_translation("The first one is here. The second is there.\nAnd the third.")
    assert len(pieces) == 3
    assert join_translations(pieces, ["Mot.", "Hai.", "Ba."], "vi") == "Mot. Hai.\nBa."


def test_join_without_spaces_restores_a_dropped_mark_in_no_space_scripts():
    """NLLB's Japanese often ends a sentence with no mark: joined directly
    the two sentences would run together, so the source's mark comes back."""
    pieces = split_for_translation(_USER_CASE)
    joined = join_translations(pieces, ["忘れるのです", "何を忘れるか"], "ja")
    assert joined == "忘れるのです。何を忘れるか"
    terminated = join_translations(pieces, ["忘れる.", "何ですか?"], "zh-CN")
    assert terminated == "忘れる.何ですか?"
    question = split_for_translation("Why did you do that? Because I had to.")
    assert join_translations(question, ["為什麼", "因為"], "zh-TW") == "為什麼？因為"


def test_join_skips_empty_rows():
    pieces = split_for_translation("One. Two.")
    assert join_translations(pieces, ["Uno.", ""], "es") == "Uno."


# ── Omission verdict (NLLB-200 outputs, October 2026) ──────────────────


_VI_DROPPED = "Nhưng câu hỏi quan trọng là, bạn quên điều gì?"
_VI_COMPLETE = (
    "ngược lại, có nghĩa là bạn quên đi nhiều như bạn học được. "
    "Nhưng câu hỏi quan trọng là, bạn quên gì?"
)
_JA_DROPPED = "しかし重要な質問は,何を忘れてしまうかということです."
_JA_COMPLETE = (
    "学習する限りは 忘れてしまうのです。"
    "しかし重要な質問は 何を忘れてしまったのか"
)
_TH_DROPPED = "แต่คำถามสำคัญคือ คุณลืมอะไร"
_TH_COMPLETE = (
    "แทนที่ตรงกันข้าม ซึ่งหมายความว่า "
    "คุณลืมไปเท่าที่คุณเรียนรู้ " + _TH_DROPPED
)


@pytest.mark.parametrize("translation, target, reason", [
    (_VI_DROPPED, "vi", "short"),
    (_JA_DROPPED, "ja", "sentences"),
    (_TH_DROPPED, "th", "short"),
])
def test_dropped_sentence_is_flagged(translation, target, reason):
    verdict = omission_verdict(_USER_CASE, translation, "en", target)
    assert verdict is not None and verdict["reason"] == reason
    assert verdict["source_sentences"] == 2


@pytest.mark.parametrize("translation, target", [
    (_VI_COMPLETE, "vi"),
    (_JA_COMPLETE, "ja"),
    # Thai separates sentences with spaces: one "sentence", still complete.
    (_TH_COMPLETE, "th"),
])
def test_complete_translation_is_not_flagged(translation, target):
    assert omission_verdict(_USER_CASE, translation, "en", target) is None


def test_dense_scripts_are_measured_by_their_characters_whatever_the_code():
    """A mislabelled Japanese target (or a picker label) still measures as
    Japanese; a source label of Auto falls back to the text's script."""
    assert omission_verdict(_USER_CASE, _JA_COMPLETE, "en", "Japanese") is None
    assert omission_verdict(_USER_CASE, _JA_COMPLETE, "auto", "xx") is None


def test_merged_sentences_of_a_complete_translation_are_not_flagged():
    source = "I know. I know. We all know it, and that is exactly why we came here today."
    merged = "Tôi biết, tôi biết, tất cả chúng ta đều biết điều đó, và đó chính là lý do hôm nay chúng ta đến đây."
    assert omission_verdict(source, merged, "en", "vi") is None


def test_short_sources_and_empty_rows_are_not_judged():
    assert omission_verdict("Yes.", "Có.", "en", "vi") is None
    assert omission_verdict(_USER_CASE, "", "en", "vi") is None
    assert omission_verdict("", "x", "en", "vi") is None


def test_sentence_count_ignores_pieces_without_speech():
    assert sentence_count(_USER_CASE) == 2
    assert sentence_count("—") == 0


def test_sentence_count_counts_what_a_translation_could_leave_out():
    """The count compares sentences, not translation rows: "Oh." or "No."
    before a sentence, and a list's bare "1.", are nothing a complete
    translation must keep (NLLB folds them into the next sentence), while a
    list's short items still count on both sides, and a quotation's closing
    mark ends no sentence of its own."""
    assert sentence_count("No. You cannot go out tonight, it is too late.") == 1
    assert sentence_count("Oh. I did not see you standing there.") == 1
    assert sentence_count("1. Open the box. 2. Take out the manual. 3. Read it.") == 3
    assert sentence_count("1. Mở hộp. 2. lấy hướng dẫn. 3. đọc nó.", "vi") == 3
    assert sentence_count("「行こう。」と彼は言った。でも誰も動かなかった。", "ja") == 2


@pytest.mark.parametrize("source, translation, target", [
    # Complete NLLB-200 translations (October 2026) that dropped or folded
    # the interjection; flagged "sentences" while "Oh." counted as one.
    ("Oh. I did not see you standing there.", "Ich sah dich nicht da stehen.", "de"),
    ("Yes. I will be there in about ten minutes.", "Tôi sẽ ở đó trong khoảng 10 phút.", "vi"),
    ("Okay. Let us go now before it gets dark.", "Vamos ahora antes de que oscurezca.", "es"),
    ("1. Open the box. 2. Take out the manual. 3. Read it.", "1. Mở hộp. 2. lấy hướng dẫn. 3. đọc nó.", "vi"),
])
def test_a_folded_interjection_or_a_short_list_item_is_not_missing_content(source, translation, target):
    assert omission_verdict(source, translation, "en", target) is None


@pytest.mark.parametrize("source, translation, target", [
    # Polite spoken Japanese runs about as long as its English: these complete
    # translations measured 0.41-0.52 against NLLB's compressed Japanese.
    ("申し訳ございませんが、本日はもう営業を終了しております。", "Sorry, we are closed for today.", "en"),
    ("本当にありがとうございました。おかげで助かりました。", "Thanks so much. You saved me.", "en"),
    ("申し訳ございませんが、本日はもう営業を終了しております。", "Lo siento, ya hemos cerrado por hoy.", "es"),
    ("今日はご覧いただきありがとうございました。また次回お会いしましょう。",
     "Thank you for watching today. See you next time.", "en"),
    ("チャンネル登録と高評価をよろしくお願いします。", "Please like and subscribe!", "en"),
    ("いやいや、そんなことないですよ。全然大丈夫ですから。", "No, not at all. It's totally fine.", "en"),
    # A quotation the splitter used to cut in three is two sentences.
    ("「行こう。」と彼は言った。でも誰も動かなかった。", 'He said, "Let\'s go." But no one moved.', "en"),
])
def test_complete_translation_from_japanese_is_not_flagged(source, translation, target):
    assert omission_verdict(source, translation, "ja", target) is None


@pytest.mark.parametrize("translation, reason", [
    ("Thank you very much.", "short"),
    ("Thank you so much for all of it.", "sentences"),
])
def test_translation_from_japanese_missing_a_sentence_is_flagged(translation, reason):
    verdict = omission_verdict("本当にありがとうございました。おかげで助かりました。", translation, "ja", "en")
    assert verdict is not None and verdict["reason"] == reason
