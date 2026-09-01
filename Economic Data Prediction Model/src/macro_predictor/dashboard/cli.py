"""Command-line entry point for the economic forecast pipeline."""

from __future__ import annotations

import argparse
import json
from pathlib import Path

from macro_predictor.dashboard.pipeline import run_pipeline


def main() -> None:
    """Execute all Phase 2 stages from a single configuration file."""
    parser = argparse.ArgumentParser(
        description=(
            "Ingest, validate point-in-time inputs, create features, walk-forward evaluate, "
            "fit, forecast, bootstrap, and export an immutable dashboard snapshot."
        )
    )
    parser.add_argument("--config", required=True, type=Path, help="Path to pipeline JSON config")
    args = parser.parse_args()
    snapshot = run_pipeline(args.config)
    print(
        json.dumps(
            {
                "runId": snapshot["runId"],
                "status": snapshot["status"],
                "latestUpdated": snapshot["status"] == "accepted",
            },
            sort_keys=True,
        )
    )
    if snapshot["status"] != "accepted":
        raise SystemExit(2)


if __name__ == "__main__":
    main()
