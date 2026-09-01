# Economic Data Prediction Model

Clean, reproducible Python research codebase for ingesting free macro data and forecasting a
swappable target. The first configured target is month-on-month change in US CPI.

## Project Status

Stage 6 complete: deterministic dashboard forecast distribution and snapshot export.

Planned stages:

1. Scaffold
2. Ingestion
3. Features
4. Model and validation
5. Report
6. Dashboard forecast orchestration

## Requirements

- Python 3.11+
- uv

## Setup

```powershell
uv sync
Copy-Item .env.example .env
```

Fill in `.env` before running ingestion in Stage 2:

```text
FRED_API_KEY=your_fred_api_key
FRED_SERIES_IDS=comma,separated,fred,series
TREASURY_SERIES_CONFIG_JSON=[{"series_id":"name","endpoint":"path/from/fiscal_service","date_field":"record_date","value_field":"amount","release_date_field":"record_date"}]
MARKET_TICKERS=comma,separated,yfinance,tickers
TARGET_SERIES_ID=the_target_series_to_forecast
FEATURE_CUTOFF_INCLUSIVE=false
```

## Common Commands

```powershell
uv run pytest
uv run ruff check .
uv run ruff format .
uv run economic-forecast-run --config examples/economic-forecast-run.example.json
```

The orchestration command performs CSV ingestion, strict point-in-time validation, feature
creation, expanding-window evaluation, final fit, next-target forecast, signed OOS residual
bootstrap, calibration checks, and immutable snapshot export. Its normalized CSV boundary is:

```text
series_id, observation_date, value, source, availability_date, vintage_date, fetched_at
```

All four time concepts remain separate. `observation_date` identifies the measurement period,
`availability_date` is the first date the exact value could be used, `vintage_date` identifies the
provider vintage/revision, and the target date comes from the run configuration. Future
availability/vintage rows are excluded at `runAsOf`; contradictory chronology fails closed.

Every distribution uses exactly 10,000 Python-generated draws from signed expanding-window OOS
residuals with the recorded seed. Runs are written to `snapshots/runs/{runId}.json`. A rejected run
is preserved there, but `snapshots/latest.json` changes only when both point-forecast and
distribution/calibration checks pass.

## Layout

```text
src/macro_predictor/
  config.py          # environment-driven settings
  data_sources/      # Stage 2 source modules with fetch, validate, store
  features/          # Stage 3 point-in-time features
  models/            # Stage 4 baselines and validation
  reporting/         # Stage 5 markdown report generation
  dashboard/         # Stage 6 orchestration, distribution, contract, and CLI
tests/               # unit tests
```

## Reproducibility Rules

- No look-ahead: features must be stamped by release date, not reference date.
- Walk-forward validation only.
- No hardcoded absolute paths.
- Configuration belongs in `src/macro_predictor/config.py` or `.env`.
- Fail loudly on missing config, failed validation, or ingestion errors.

## Stage 2 Notes

Every source module exposes the same public interface:

```python
fetch(...)
validate(frame)
store(frame, ...)
```

All sources normalize to:

```text
series_id, date, value, source, release_date, fetched_at
```

Source identifiers are intentionally configured outside code. Exact FRED series, Treasury
endpoints, and market tickers should be chosen explicitly before running live ingestion.

## Stage 3 Notes

Feature generation is strict point-in-time. Each training row is stamped by the target
`release_date`, and features use only observations whose own `release_date` is before that stamp
by default. Set `FEATURE_CUTOFF_INCLUSIVE=true` only when same-day release ordering is known and
safe.

Implemented defaults:

- month-on-month percent changes
- year-on-year percent changes
- PMI diffusion levels and mean, when `PMI_SERIES_IDS` is configured
- long-minus-short yield curve slope
- real fed funds proxy
- 12 and 24 month rolling z-scores
- lagged target month-on-month features

## Stage 4 Notes

Model validation is expanding-window walk-forward only. Real runs require explicit model config in
`.env`; missing window sizes or model params raise an error instead of falling back to hidden
defaults.

Outputs per model:

- out-of-sample RMSE
- out-of-sample MAE
- directional accuracy
- hit rate versus naive last-value baseline
- a plain-language naive comparison

## Stage 5 Notes

Reports are saved to:

```text
reports/{run_date}_baseline.md
```

Each report includes data coverage, feature coverage, model parameters, fold-by-fold metrics,
summary metrics, a plain naive-baseline comparison, and a predicted-versus-actual SVG plot.

## Stage 6 Notes

The distribution method is `walk-forward-signed-residual-bootstrap` version `1.0.0`. It exports
40 compact histogram bins by default, P10/P25/P50/P75/P90, mean, population standard deviation,
threshold probabilities, residual count/range, seed, a draw digest, and 50%/80%/90% historical
coverage plus average interval width. Historical intervals are calibrated sequentially: a test
observation can use only residuals from earlier OOS predictions.

Fewer than 36 eligible errors is preliminary and cannot publish `latest.json`. Calibration uses a
documented sampling tolerance and must pass at every requested coverage level; visual plausibility
is never an acceptance check. The older CPI sandbox CSVs remain UI sample data because they do not
retain official availability dates and vintage dates separately.
