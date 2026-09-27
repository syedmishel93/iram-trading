"""
Gateway configuration — one place, read once.

WHY THIS FILE EXISTS AT ALL
Before consolidation there were three services, each reading its own environment
variables with its own defaults and its own idea of what "the host" meant:
`DDT_HOST`/`DDT_PORT`, `MISHEL_SVC_HOST`/`MISHEL_SVC_PORT`, `IRAM_QUANT_HOST`/
`IRAM_QUANT_PORT`. Three ports meant three CORS policies, three bind decisions
and three chances to get the localhost guard wrong. The browser paid for it too:
`ERR_CONNECTION_REFUSED` from :8788 while :8787 answered fine looks, from the
terminal, exactly like "the backend is broken".

One process reads one config. The legacy variables are still honoured as
fallbacks so an existing `.env` or launcher keeps working.
"""

from __future__ import annotations

import os
from dataclasses import dataclass, field


def _env(*names: str, default: str = "") -> str:
    """First environment variable that is set and non-empty, else `default`."""
    for n in names:
        v = os.environ.get(n)
        if v:
            return v
    return default


def _flag(*names: str, default: bool = False) -> bool:
    v = _env(*names).strip().lower()
    if not v:
        return default
    return v not in ("0", "false", "no", "off")


#: Origins that are always allowed, whatever the operator configures.
#:
#: `null` is not a typo and not a wildcard. The shipped artefact is one
#: self-contained `index.html` that opens from a double-click, and a page loaded
#: over `file://` sends the literal string `null` as its Origin. Leaving it out
#: is the single most common way this backend "works in dev and dies in the
#: product", because dev runs on :5173 where the origin looks ordinary.
#:
#: The two `tauri` entries are the desktop shell in `desktop/`.
BUILTIN_ORIGINS: tuple[str, ...] = (
    "null",
    "tauri://localhost",
    "https://tauri.localhost",
)

#: Any port on loopback. The terminal is served from :8000 by `run.py`, :5173 by
#: Vite and :4173 by `vite preview`, and operators pick their own often enough
#: that enumerating ports would be a permanent source of support questions.
#: Loopback-only keeps this from being a wildcard: a page on the public internet
#: cannot have a `http://localhost:PORT` origin.
LOOPBACK_ORIGIN_REGEX = r"^https?://(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$"


@dataclass(frozen=True)
class Settings:
    host: str = field(default_factory=lambda: _env("IRAM_HOST", "DDT_HOST", default="127.0.0.1"))
    port: int = field(default_factory=lambda: int(_env("IRAM_PORT", "DDT_PORT", default="8787")))

    #: Extra allowed origins, comma-separated. Only needed when the terminal is
    #: served from somewhere that is not loopback and not a file.
    extra_origins: tuple[str, ...] = field(
        default_factory=lambda: tuple(
            o.strip() for o in _env("IRAM_CORS_ORIGINS").split(",") if o.strip()
        )
    )

    #: Start the eleven background loops that `mishel_service.py` used to start
    #: in its `__main__` block (alerts, backups, ledger, whale watch, …).
    #: Off by default because a gateway started to serve one backtest should not
    #: quietly begin polling vendors and writing to the database.
    background: bool = field(default_factory=lambda: _flag("IRAM_BACKGROUND", default=False))

    #: How many OS threads may be inside legacy Flask code at once. Flask here is
    #: synchronous and some handlers block for ten seconds on a GARCH fit, so
    #: this is what stops one slow request from stalling the rest.
    wsgi_workers: int = field(default_factory=lambda: int(_env("IRAM_WSGI_WORKERS", default="24")))

    @property
    def allow_origins(self) -> list[str]:
        return [*BUILTIN_ORIGINS, *self.extra_origins]

    @property
    def is_loopback(self) -> bool:
        return self.host in ("127.0.0.1", "localhost", "::1")


settings = Settings()
