"""GitHub REST calls used to chain worker runs and to recover stalled runs.

Requires `actions: write` on the GITHUB_TOKEN. A workflow_dispatch event created
with GITHUB_TOKEN does start a new run, which is what makes the chain possible.
"""

from __future__ import annotations

import json
from dataclasses import dataclass
from datetime import datetime, timezone

from .transport import Transport, TransportError

_API = "https://api.github.com"
_EPOCH = datetime(1970, 1, 1, tzinfo=timezone.utc)


class GitHubError(RuntimeError):
    pass


@dataclass(frozen=True)
class RunInfo:
    id: int
    status: str
    conclusion: str | None
    created_at: datetime
    run_started_at: datetime


def _parse_time(value: str | None, fallback: datetime) -> datetime:
    return datetime.fromisoformat(value.replace("Z", "+00:00")) if value else fallback


class GitHubChain:
    def __init__(self, repository: str, workflow_file: str, ref: str, token: str, transport: Transport) -> None:
        self._repo = repository
        self._workflow = workflow_file
        self._ref = ref
        self._token = token
        self._transport = transport

    def _headers(self) -> dict[str, str]:
        return {
            "Authorization": f"Bearer {self._token}",
            "Accept": "application/vnd.github+json",
            "X-GitHub-Api-Version": "2022-11-28",
            "Content-Type": "application/json",
        }

    def _request(self, method: str, path: str, body: dict | None = None) -> tuple[int, dict]:
        data = json.dumps(body).encode("utf-8") if body is not None else None
        try:
            resp = self._transport.request(method, f"{_API}{path}", headers=self._headers(), body=data, timeout=30.0)
        except TransportError as exc:
            raise GitHubError(f"github unreachable ({exc.kind})") from None
        payload: dict = {}
        if resp.body:
            try:
                payload = json.loads(resp.body)
            except ValueError:
                payload = {}
        if resp.status >= 400:
            raise GitHubError(f"github api error {resp.status}")
        return resp.status, payload

    def _runs_path(self) -> str:
        return f"/repos/{self._repo}/actions/workflows/{self._workflow}/runs"

    def _parse_runs(self, payload: dict) -> list[RunInfo]:
        runs = []
        for item in payload.get("workflow_runs", []):
            created = _parse_time(item.get("created_at"), _EPOCH)
            runs.append(
                RunInfo(
                    id=int(item["id"]),
                    status=str(item.get("status")),
                    conclusion=item.get("conclusion"),
                    created_at=created,
                    run_started_at=_parse_time(item.get("run_started_at"), created),
                )
            )
        return runs

    def list_runs(self, statuses: list[str]) -> list[RunInfo]:
        found: dict[int, RunInfo] = {}
        for status in statuses:
            _, payload = self._request("GET", f"{self._runs_path()}?status={status}&per_page=30")
            for run in self._parse_runs(payload):
                found[run.id] = run
        return list(found.values())

    def list_completed(self, limit: int) -> list[RunInfo]:
        _, payload = self._request("GET", f"{self._runs_path()}?status=completed&per_page={limit}")
        return self._parse_runs(payload)

    def dispatch(self) -> None:
        path = f"/repos/{self._repo}/actions/workflows/{self._workflow}/dispatches"
        self._request("POST", path, {"ref": self._ref})

    def cancel(self, run_id: int) -> None:
        self._request("POST", f"/repos/{self._repo}/actions/runs/{run_id}/cancel")
