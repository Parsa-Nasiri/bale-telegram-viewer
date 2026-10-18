"""Builds the shared clients from settings. Telethon is not created here."""

from __future__ import annotations

from dataclasses import dataclass

from .bale_client import BaleClient
from .config import Settings
from .github_chain import GitHubChain
from .queue_ops import QueueOps
from .store import Store
from .supabase_rest import SupabaseRest
from .transport import Transport, UrllibTransport


@dataclass
class Context:
    settings: Settings
    store: Store
    queue: QueueOps
    bale: BaleClient | None
    github: GitHubChain | None


def build_context(settings: Settings, transport: Transport | None = None) -> Context:
    transport = transport or UrllibTransport()
    rest = SupabaseRest(settings.supabase_url, settings.supabase_service_role_key, transport)
    bale = BaleClient(settings.bale_api_base_url, settings.bale_bot_token, transport) if settings.bale_bot_token else None
    github = None
    if settings.github_repository and settings.github_token:
        github = GitHubChain(
            settings.github_repository,
            settings.workflow_file,
            settings.github_ref,
            settings.github_token,
            transport,
        )
    return Context(settings=settings, store=Store(rest), queue=QueueOps(rest), bale=bale, github=github)
