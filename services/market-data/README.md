# PDE Studio market-data sidecar

This separately deployable FastAPI service isolates `yfinance` and Python from the Vinext/Cloudflare application. It exposes only typed JSON responses for quotes, adjusted history/actions, expiration discovery, and option chains.

## Local run

```bash
python -m venv .venv
.venv/Scripts/pip install -r requirements.txt
.venv/Scripts/uvicorn main:app --host 127.0.0.1 --port 8010
```

Set `YFINANCE_SERVICE_URL=http://127.0.0.1:8010` in the PDE Studio server environment. Production deployments should use HTTPS, restrict inbound access to the application, impose a bounded upstream timeout, cache successful immutable snapshots, and return ordinary 4xx/5xx JSON failures without leaking upstream response bodies.

The web application owns all expiry-specific rate interpolation, quote filtering, forward normalization, Heston calibration, cancellation, and solver-input application. The sidecar remains a typed provider boundary and never calibrates or applies model parameters.

`yfinance` uses an unofficial Yahoo Finance interface. Review its terms and data-licensing limitations before production or commercial use. PDE Studio never treats a provider response as an accepted solver input until it has been validated, previewed, and explicitly applied.
