import tempfile
import unittest
from pathlib import Path

from bale_viewer_worker.dotenv import load_dotenv, parse_dotenv


class ParseTests(unittest.TestCase):
    def test_reads_plain_quoted_and_exported_values(self) -> None:
        text = "# comment\n\nA=1\nexport B='two words'\nC=\"three\"\n"
        self.assertEqual(parse_dotenv(text), {"A": "1", "B": "two words", "C": "three"})

    def test_strips_inline_comments_from_unquoted_values(self) -> None:
        self.assertEqual(parse_dotenv("K=value # note\n"), {"K": "value"})

    def test_keeps_hash_signs_inside_values(self) -> None:
        self.assertEqual(parse_dotenv("T=abc#def\n"), {"T": "abc#def"})


class LoadTests(unittest.TestCase):
    def test_fills_only_missing_or_empty_keys(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / ".env"
            path.write_text("SET_ALREADY=from-file\nEMPTY_IN_ENV=from-file\nNEW_KEY=from-file\n", encoding="utf-8")
            env = {"SET_ALREADY": "from-env", "EMPTY_IN_ENV": ""}
            self.assertTrue(load_dotenv(path, env))
            self.assertEqual(
                env,
                {"SET_ALREADY": "from-env", "EMPTY_IN_ENV": "from-file", "NEW_KEY": "from-file"},
            )

    def test_missing_file_is_not_an_error(self) -> None:
        self.assertFalse(load_dotenv(Path("/nonexistent/dir/.env"), {}))
