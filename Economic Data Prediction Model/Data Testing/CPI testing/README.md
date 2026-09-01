# CPI Testing Data Funnel

This folder is an isolated testing area for CPI inflation data. It is not connected to
the main model code under `src/`, and it does not write to the project database.

## Folder layout

- `01_raw/` keeps the untouched FRED CSV downloads.
- `02_processed/` keeps derived CPI inflation metrics for testing.
- `03_notes/` keeps notes and the refresh script.

## Data source

The current test data comes from FRED public CSV downloads:

- `CPIAUCSL`: headline CPI, seasonally adjusted.
- `CPILFESL`: core CPI excluding food and energy, seasonally adjusted.

## Processed outputs

- `02_processed/cpi_inflation_metrics.csv`
  - Monthly CPI index values.
  - Month-over-month inflation percent.
  - Annualized month-over-month inflation percent.
  - Year-over-year inflation percent.
- `02_processed/latest_cpi_inflation_snapshot.csv`
  - Latest available row per CPI series.

## Refresh command

From the project root:

```powershell
& ".venv\Scripts\python.exe" "Data Testing\CPI testing\03_notes\fetch_cpi_data.py"
```
