from __future__ import annotations

from datetime import date, datetime, timezone
from typing import Literal

import yfinance as yf
from fastapi import FastAPI, HTTPException, Query
from pydantic import BaseModel


app = FastAPI(title="PDE Studio market-data sidecar", version="1.0.0")


class Quote(BaseModel):
    symbol: str
    currency: str
    timezone: str
    regularMarketPrice: float
    regularMarketTime: str


class HistoryPoint(BaseModel):
    date: str
    close: float
    adjustedClose: float
    volume: int
    dividends: float
    splits: float


class OptionContract(BaseModel):
    contractSymbol: str
    optionType: Literal["call", "put"]
    expiration: str
    strike: float
    bid: float
    ask: float
    lastPrice: float
    impliedVolatility: float | None = None
    openInterest: int
    volume: int
    lastTradeTimestamp: str | None = None


def ticker(symbol: str) -> yf.Ticker:
    cleaned = symbol.strip().upper()
    if not cleaned or len(cleaned) > 24:
        raise HTTPException(status_code=400, detail="Invalid symbol")
    return yf.Ticker(cleaned)


def iso_timestamp(value: object) -> str:
    if isinstance(value, (int, float)):
        return datetime.fromtimestamp(float(value), tz=timezone.utc).isoformat().replace("+00:00", "Z")
    if isinstance(value, datetime):
        return value.astimezone(timezone.utc).isoformat().replace("+00:00", "Z")
    if hasattr(value, "to_pydatetime"):
        return value.to_pydatetime().astimezone(timezone.utc).isoformat().replace("+00:00", "Z")
    return str(value)


@app.get("/health")
def health() -> dict[str, str]:
    return {"status": "ok"}


@app.get("/quote", response_model=Quote)
def quote(symbol: str = Query(min_length=1, max_length=24)) -> Quote:
    item = ticker(symbol)
    try:
        fast = item.fast_info
        metadata = item.get_history_metadata()
        market_time_value = metadata.get("regularMarketTime") or fast.get("last_price_time")
        market_time = iso_timestamp(market_time_value) if market_time_value is not None else datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")
        return Quote(
            symbol=symbol.upper(),
            currency=str(fast.get("currency") or metadata.get("currency") or "UNKNOWN"),
            timezone=str(fast.get("timezone") or metadata.get("exchangeTimezoneName") or "UTC"),
            regularMarketPrice=float(fast["last_price"]),
            regularMarketTime=market_time,
        )
    except Exception as exc:
        raise HTTPException(status_code=502, detail="Unable to obtain quote") from exc


@app.get("/history")
def history(symbol: str, start: date, end: date) -> dict[str, object]:
    if end <= start:
        raise HTTPException(status_code=400, detail="end must be after start")
    item = ticker(symbol)
    try:
        frame = item.history(start=start.isoformat(), end=end.isoformat(), auto_adjust=False, actions=True)
        points = [HistoryPoint(
            date=index.date().isoformat(),
            close=float(row["Close"]),
            adjustedClose=float(row.get("Adj Close", row["Close"])),
            volume=int(row.get("Volume", 0)),
            dividends=float(row.get("Dividends", 0)),
            splits=float(row.get("Stock Splits", 0)),
        ).model_dump() for index, row in frame.iterrows()]
        currency = str(item.fast_info.get("currency") or "UNKNOWN")
        return {"symbol": symbol.upper(), "currency": currency, "points": points}
    except Exception as exc:
        raise HTTPException(status_code=502, detail="Unable to obtain adjusted history") from exc


@app.get("/expirations")
def expirations(symbol: str) -> dict[str, object]:
    try:
        return {"symbol": symbol.upper(), "expirations": list(ticker(symbol).options)}
    except Exception as exc:
        raise HTTPException(status_code=502, detail="Unable to obtain option expirations") from exc


@app.get("/option-chain")
def option_chain(symbol: str, expiration: date) -> dict[str, object]:
    item = ticker(symbol)
    try:
        chain = item.option_chain(expiration.isoformat())
        contracts: list[dict[str, object]] = []
        for option_type, frame in (("call", chain.calls), ("put", chain.puts)):
            for _, row in frame.iterrows():
                last_trade = row.get("lastTradeDate")
                contracts.append(OptionContract(
                    contractSymbol=str(row["contractSymbol"]),
                    optionType=option_type,
                    expiration=expiration.isoformat(),
                    strike=float(row["strike"]),
                    bid=float(row.get("bid", 0)),
                    ask=float(row.get("ask", 0)),
                    lastPrice=float(row.get("lastPrice", 0)),
                    impliedVolatility=float(row["impliedVolatility"]) if row.get("impliedVolatility") is not None else None,
                    openInterest=int(row.get("openInterest", 0) or 0),
                    volume=int(row.get("volume", 0) or 0),
                    lastTradeTimestamp=iso_timestamp(last_trade) if last_trade is not None else None,
                ).model_dump())
        currency = str(item.fast_info.get("currency") or "UNKNOWN")
        return {"symbol": symbol.upper(), "currency": currency, "expiration": expiration.isoformat(), "contracts": contracts}
    except Exception as exc:
        raise HTTPException(status_code=502, detail="Unable to obtain option chain") from exc
