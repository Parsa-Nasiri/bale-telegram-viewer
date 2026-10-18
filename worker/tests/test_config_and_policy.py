import unittest

from bale_viewer_worker.config import ConfigError, Settings, parse_duration
from bale_viewer_worker.policy import (
    JOB_TRANSITIONS,
    PAGE_TRANSITIONS,
    backoff_seconds,
    can_transition,
    sanitize_filename,
)


class DurationTests(unittest.TestCase):
    def test_compound_and_plain_values(self):
        self.assertEqual(parse_duration("5h15m"), 18900)
        self.assertEqual(parse_duration("5h 15m"), 18900)
        self.assertEqual(parse_duration("30m"), 1800)
        self.assertEqual(parse_duration("3600"), 3600)
        self.assertEqual(parse_duration("1h2s"), 3602)

    def test_invalid_values_are_rejected(self):
        for bad in ("", "abc", "1h2", "5 hours"):
            with self.subTest(bad=bad), self.assertRaises(ConfigError):
                parse_duration(bad)


class SettingsTests(unittest.TestCase):
    def test_from_env_requires_supabase(self):
        with self.assertRaises(ConfigError):
            Settings.from_env({"SUPABASE_SERVICE_ROLE_KEY": "k"})

    def test_from_env_reads_defaults_and_strips_slash(self):
        s = Settings.from_env(
            {"SUPABASE_URL": "https://x.supabase.co/", "SUPABASE_SERVICE_ROLE_KEY": "k"}
        )
        self.assertEqual(s.supabase_url, "https://x.supabase.co")
        self.assertEqual(s.max_download_size_bytes, 50 * 1024 * 1024)
        self.assertEqual(s.max_attempts, 3)
        self.assertEqual(s.run_id, "local")

    def test_bale_token_is_only_required_by_commands_that_use_it(self):
        s = Settings.from_env({"SUPABASE_URL": "https://x", "SUPABASE_SERVICE_ROLE_KEY": "k"})
        with self.assertRaises(ConfigError):
            s.require_bale()


class PolicyTests(unittest.TestCase):
    def test_uploading_can_end_as_ambiguous_but_ambiguous_is_final(self):
        self.assertTrue(can_transition(JOB_TRANSITIONS, "uploading", "ambiguous"))
        self.assertFalse(can_transition(JOB_TRANSITIONS, "ambiguous", "queued"))
        self.assertFalse(can_transition(JOB_TRANSITIONS, "succeeded", "processing"))

    def test_page_requests_have_no_upload_state(self):
        self.assertNotIn("uploading", PAGE_TRANSITIONS["processing"])
        self.assertTrue(can_transition(PAGE_TRANSITIONS, "processing", "succeeded"))

    def test_backoff_doubles_and_caps(self):
        self.assertEqual([backoff_seconds(a) for a in (1, 2, 3)], [30, 60, 120])
        self.assertEqual(backoff_seconds(10), 900)

    def test_filename_is_safe_and_keeps_extension(self):
        name = sanitize_filename("../../etc/passwd.pdf", "application/pdf", "document")
        self.assertNotIn("/", name)
        self.assertTrue(name.endswith(".pdf"))

    def test_missing_name_uses_mime_extension(self):
        self.assertEqual(sanitize_filename(None, "image/jpeg", "photo"), "photo.jpg")

    def test_unicode_names_are_kept(self):
        self.assertEqual(sanitize_filename("گزارش نهایی.docx", None, "document"), "گزارش نهایی.docx")

    def test_long_names_are_truncated(self):
        name = sanitize_filename("a" * 300 + ".zip", None, "document")
        self.assertLessEqual(len(name), 112)
        self.assertTrue(name.endswith(".zip"))


if __name__ == "__main__":
    unittest.main()
