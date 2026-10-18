"""Pure decision logic for the watchdog. No I/O, so it is unit-tested directly."""

from __future__ import annotations

from dataclasses import dataclass, field
from datetime import datetime, timedelta

from .github_chain import RunInfo

STALL_GRACE = timedelta(minutes=15)  # a run this young may still be starting up
HEARTBEAT_STALE = timedelta(minutes=10)
FAILURES_BEFORE_BLOCK = 3


@dataclass(frozen=True)
class Decision:
    cancel_run_ids: list[int] = field(default_factory=list)
    dispatch: bool = False
    reason: str = ""


def _parse(value: str) -> datetime:
    return datetime.fromisoformat(value.replace("Z", "+00:00"))


def decide(
    now: datetime,
    active_runs: list[RunInfo],
    heartbeat: dict | None,
    recent_completed: list[RunInfo],
) -> Decision:
    """Decide whether to cancel a hung run and whether to start a new chain.

    * An in-progress run that is older than the grace period and has no fresh heartbeat is hung: cancel it.
    * If nothing is running or waiting, dispatch a new run.
    * If the last three completed runs all failed, do not dispatch. A failure
      loop would burn minutes, so a person should look at it.
    """
    in_progress = [run for run in active_runs if run.status == "in_progress"]
    waiting = [run for run in active_runs if run.status != "in_progress"]

    cancel: list[int] = []
    for run in in_progress:
        if now - run.run_started_at < STALL_GRACE:
            continue
        fresh = (
            heartbeat is not None
            and heartbeat.get("run_id") == str(run.id)
            and now - _parse(heartbeat["updated_at"]) < HEARTBEAT_STALE
        )
        if not fresh:
            cancel.append(run.id)

    still_running = [run for run in in_progress if run.id not in cancel]
    if still_running or waiting:
        return Decision(cancel, False, "chain is active")

    last = recent_completed[:FAILURES_BEFORE_BLOCK]
    if len(last) == FAILURES_BEFORE_BLOCK and all(run.conclusion == "failure" for run in last):
        return Decision(cancel, False, "blocked: the last runs failed; investigate before restarting")
    return Decision(cancel, True, "no active run; dispatching a new chain")
