"""Constrained Uvicorn entry point for the production sidecar container."""

from __future__ import annotations

import os

import uvicorn
from runtime import bounded_integer


def main() -> None:
    """Run one API process; forecast concurrency is bounded inside the application."""
    uvicorn.run(
        "main:app",
        host="0.0.0.0",
        port=bounded_integer("PORT", 8020, 1, 65535),
        workers=1,
        proxy_headers=True,
        forwarded_allow_ips=os.getenv("ECONOMIC_FORECAST_FORWARDED_ALLOW_IPS", "127.0.0.1"),
        limit_concurrency=bounded_integer("ECONOMIC_FORECAST_HTTP_CONCURRENCY", 32, 4, 256),
        limit_max_requests=bounded_integer(
            "ECONOMIC_FORECAST_MAX_REQUESTS_PER_PROCESS", 10_000, 100, 1_000_000
        ),
        timeout_keep_alive=bounded_integer("ECONOMIC_FORECAST_KEEP_ALIVE_SECONDS", 5, 1, 30),
        timeout_graceful_shutdown=bounded_integer(
            "ECONOMIC_FORECAST_GRACEFUL_SHUTDOWN_SECONDS", 300, 30, 1_800
        ),
        access_log=False,
        log_level=os.getenv("LOG_LEVEL", "info").lower(),
    )


if __name__ == "__main__":
    main()
