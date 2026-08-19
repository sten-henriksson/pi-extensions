from pathlib import Path

Path("app/text.py").write_text(
    '''def normalize_slug(value: str) -> str:
    """Return a URL-friendly slug."""
    return value.lower().replace(" ", "-")
'''
)
Path("tests/test_slug.py").write_text(
    '''import unittest
from app.text import normalize_slug


class SlugTests(unittest.TestCase):
    def test_normalizes_punctuation_and_whitespace(self):
        self.assertEqual(normalize_slug("  Hello, World!  "), "hello-world")
        self.assertEqual(normalize_slug("C++ & Rust"), "c-rust")

    def test_collapses_runs_and_empty_values(self):
        self.assertEqual(normalize_slug("one---two___three"), "one-two-three")
        self.assertEqual(normalize_slug("!!!"), "")


if __name__ == "__main__":
    unittest.main()
'''
)
