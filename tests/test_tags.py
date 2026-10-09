import unittest

from release_notes import tags


class SlugTest(unittest.TestCase):
    def test_lowercase_words_joined_by_hyphens(self):
        for name, want in [("Maine 2016", "maine-2016"), ("Williamsburg/DC Vacation", "williamsburg-dc-vacation"),
                           ("Big Green Egg", "big-green-egg"), ("8thBridge", "8thbridge"), ("Café", "cafe"),
                           ("  --Kubb--  ", "kubb")]:
            self.assertEqual(tags.slug(name), want, name)

    def test_long_names_are_cut_without_a_trailing_hyphen(self):
        self.assertEqual(tags.slug("a" * 49 + " b"), "a" * 49)


class FoundTest(unittest.TestCase):
    def test_hashtags_are_the_tags_once_each_in_order(self):
        self.assertEqual(tags.found("Kubb with #Tyler and #Mazie. #maine-2016 #tyler"), ["tyler", "mazie", "maine-2016"])

    def test_what_is_not_a_tag(self):
        for text in ["# A title", "PR #31 and #2016", "https://example.com/page#section", "a#b", "&#39;", "##", "#_x"]:
            self.assertEqual(tags.found(text), [], text)

    def test_punctuation_after_a_hashtag_ends_it(self):
        self.assertEqual(tags.found("(#kubb), #cabin! #big-green-egg-"), ["kubb", "cabin", "big-green-egg"])

    def test_at_most_twenty(self):
        self.assertEqual(len(tags.found(" ".join(f"#t{n}" for n in range(30)))), tags.MAX_TAGS)


class LineTest(unittest.TestCase):
    def test_names_from_elsewhere_as_hashtags(self):
        line = tags.line(["Tyler", "Maine 2016", "tyler", "2016", "Williamsburg/DC Vacation"])
        self.assertEqual(line, "#tyler #maine-2016 #williamsburg-dc-vacation")
        self.assertEqual(tags.found(line), ["tyler", "maine-2016", "williamsburg-dc-vacation"])


class SplitTest(unittest.TestCase):
    def test_hashtags_split_out_of_text_parts(self):
        link = {"url": "https://example.com/", "label": "example.com"}
        parts = tags.split(["Up north #Cabin with ", link, " #kubb"])
        self.assertEqual(parts, ["Up north ", {"tag": "cabin", "text": "#Cabin"}, " with ", link, " ",
                                 {"tag": "kubb", "text": "#kubb"}])


if __name__ == "__main__":
    unittest.main()
