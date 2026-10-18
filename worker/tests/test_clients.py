import json
import unittest

from bale_viewer_worker.bale_client import BaleClient
from bale_viewer_worker.errors import AppError
from bale_viewer_worker.github_chain import GitHubChain, GitHubError
from bale_viewer_worker.supabase_rest import StoreError, SupabaseRest
from bale_viewer_worker.transport import HttpResponse, TransportError

from tests.fakes import FakeTransport, ok_json

TOKEN = "123456:SECRET-TOKEN"
BASE = "https://tapi.bale.ai"


class BaleClientTests(unittest.TestCase):
    def _client(self, responder):
        transport = FakeTransport(responder)
        return BaleClient(BASE, TOKEN, transport), transport

    def _file(self, tmp_path):
        path = tmp_path / "f.bin"
        path.write_bytes(b"abc")
        return str(path)

    def test_send_document_returns_message_id_and_uses_multipart(self):
        import tempfile, os

        with tempfile.TemporaryDirectory() as tmp:
            path = os.path.join(tmp, "f.bin")
            open(path, "wb").write(b"abc")
            client, transport = self._client(lambda *a: ok_json({"ok": True, "result": {"message_id": 99}}))
            message_id = client.send_document("777", path, "f.pdf", "application/pdf", "hi")
        self.assertEqual(message_id, "99")
        call = transport.calls[0]
        self.assertTrue(call["url"].endswith("/sendDocument"))
        self.assertIn(b'name="chat_id"', call["body"])
        self.assertIn(b'filename="f.pdf"', call["body"])
        self.assertTrue(call["headers"]["Content-Type"].startswith("multipart/form-data; boundary="))

    def test_429_is_retryable_and_not_ambiguous(self):
        import tempfile, os

        with tempfile.TemporaryDirectory() as tmp:
            path = os.path.join(tmp, "f.bin")
            open(path, "wb").write(b"abc")
            client, _ = self._client(lambda *a: HttpResponse(429, b"{}"))
            with self.assertRaises(AppError) as ctx:
                client.send_document("777", path, "f.bin", "application/octet-stream", "")
        self.assertEqual(ctx.exception.code, "BALE_SEND_FAILED")
        self.assertTrue(ctx.exception.retryable)

    def test_gateway_timeout_after_upload_is_ambiguous(self):
        import tempfile, os

        with tempfile.TemporaryDirectory() as tmp:
            path = os.path.join(tmp, "f.bin")
            open(path, "wb").write(b"abc")
            client, _ = self._client(lambda *a: HttpResponse(504, b""))
            with self.assertRaises(AppError) as ctx:
                client.send_document("777", path, "f.bin", "application/octet-stream", "")
        self.assertEqual(ctx.exception.code, "BALE_SEND_AMBIGUOUS")

    def test_connection_never_established_is_retryable(self):
        import tempfile, os

        with tempfile.TemporaryDirectory() as tmp:
            path = os.path.join(tmp, "f.bin")
            open(path, "wb").write(b"abc")
            client, _ = self._client(lambda *a: TransportError("not_sent", "refused"))
            with self.assertRaises(AppError) as ctx:
                client.send_document("777", path, "f.bin", "application/octet-stream", "")
        self.assertTrue(ctx.exception.retryable)

    def test_timeout_during_upload_is_ambiguous(self):
        import tempfile, os

        with tempfile.TemporaryDirectory() as tmp:
            path = os.path.join(tmp, "f.bin")
            open(path, "wb").write(b"abc")
            client, _ = self._client(lambda *a: TransportError("unknown", "timeout"))
            with self.assertRaises(AppError) as ctx:
                client.send_document("777", path, "f.bin", "application/octet-stream", "")
        self.assertEqual(ctx.exception.code, "BALE_SEND_AMBIGUOUS")

    def test_error_messages_never_contain_the_token(self):
        import tempfile, os

        with tempfile.TemporaryDirectory() as tmp:
            path = os.path.join(tmp, "f.bin")
            open(path, "wb").write(b"abc")
            client, _ = self._client(lambda *a: TransportError("unknown", "network error"))
            with self.assertRaises(AppError) as ctx:
                client.send_document("777", path, "f.bin", "application/octet-stream", "")
        self.assertNotIn(TOKEN, str(ctx.exception))
        self.assertNotIn(TOKEN.split(":")[1], str(ctx.exception))

    def test_get_me_rejects_bad_token(self):
        client, _ = self._client(lambda *a: HttpResponse(401, b'{"ok": false}'))
        with self.assertRaises(AppError) as ctx:
            client.get_me()
        self.assertEqual(ctx.exception.code, "BALE_TOKEN_INVALID")


class SupabaseRestTests(unittest.TestCase):
    def _rest(self, responder):
        transport = FakeTransport(responder)
        return SupabaseRest("https://proj.supabase.co", "SERVICE-KEY", transport), transport

    def test_select_builds_filtered_url_with_auth_headers(self):
        rest, transport = self._rest(lambda *a: HttpResponse(200, b'[{"id": "x"}]'))
        rows = rest.select("users", {"select": "id", "id": "eq.abc"})
        self.assertEqual(rows, [{"id": "x"}])
        call = transport.calls[0]
        self.assertEqual(call["method"], "GET")
        self.assertIn("/rest/v1/users?", call["url"])
        self.assertIn("id=eq.abc", call["url"])
        self.assertEqual(call["headers"]["apikey"], "SERVICE-KEY")

    def test_update_sends_patch_with_return_representation(self):
        rest, transport = self._rest(lambda *a: HttpResponse(200, b"[]"))
        rest.update("download_jobs", {"id": "eq.1", "status": "eq.queued"}, {"status": "processing"})
        call = transport.calls[0]
        self.assertEqual(call["method"], "PATCH")
        self.assertEqual(call["headers"]["Prefer"], "return=representation")
        self.assertEqual(json.loads(call["body"]), {"status": "processing"})

    def test_rpc_posts_to_function_path(self):
        rest, transport = self._rest(lambda *a: HttpResponse(200, b"7"))
        self.assertEqual(rest.rpc("pgmq_send", {"p_queue": "q", "p_msg": {}}), 7)
        self.assertTrue(transport.calls[0]["url"].endswith("/rest/v1/rpc/pgmq_send"))

    def test_http_errors_raise_store_error_with_status(self):
        rest, _ = self._rest(lambda *a: HttpResponse(409, b'{"message": "conflict"}'))
        with self.assertRaises(StoreError) as ctx:
            rest.select("users", {})
        self.assertEqual(ctx.exception.status, 409)

    def test_transport_failure_does_not_leak_the_key(self):
        rest, _ = self._rest(lambda *a: TransportError("unknown", "network error"))
        with self.assertRaises(StoreError) as ctx:
            rest.select("users", {})
        self.assertNotIn("SERVICE-KEY", str(ctx.exception))


class GitHubChainTests(unittest.TestCase):
    def _chain(self, responder):
        transport = FakeTransport(responder)
        return GitHubChain("owner/repo", "telegram-bale-worker.yml", "main", "GH-TOKEN", transport), transport

    def test_dispatch_posts_ref_to_workflow_dispatches(self):
        chain, transport = self._chain(lambda *a: HttpResponse(204, b""))
        chain.dispatch()
        call = transport.calls[0]
        self.assertEqual(call["method"], "POST")
        self.assertTrue(call["url"].endswith("/repos/owner/repo/actions/workflows/telegram-bale-worker.yml/dispatches"))
        self.assertEqual(json.loads(call["body"]), {"ref": "main"})
        self.assertEqual(call["headers"]["Authorization"], "Bearer GH-TOKEN")

    def test_list_runs_parses_and_dedupes(self):
        payload = {"workflow_runs": [{"id": 5, "status": "in_progress", "conclusion": None,
                                      "created_at": "2026-10-17T10:00:00Z",
                                      "run_started_at": "2026-10-17T10:00:05Z"}]}
        chain, _ = self._chain(lambda *a: HttpResponse(200, json.dumps(payload).encode()))
        runs = chain.list_runs(["in_progress", "queued"])
        self.assertEqual([r.id for r in runs], [5])
        self.assertIsNotNone(runs[0].run_started_at.tzinfo)

    def test_api_errors_do_not_leak_the_token(self):
        chain, _ = self._chain(lambda *a: HttpResponse(403, b"{}"))
        with self.assertRaises(GitHubError) as ctx:
            chain.dispatch()
        self.assertNotIn("GH-TOKEN", str(ctx.exception))

    def test_cancel_posts_to_run_cancel_endpoint(self):
        chain, transport = self._chain(lambda *a: HttpResponse(202, b""))
        chain.cancel(77)
        self.assertTrue(transport.calls[0]["url"].endswith("/repos/owner/repo/actions/runs/77/cancel"))


if __name__ == "__main__":
    unittest.main()
