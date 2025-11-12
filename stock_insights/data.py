"""Utilities to fetch price and company data for equities."""

from __future__ import annotations

from dataclasses import dataclass
from functools import lru_cache
from typing import Any, Dict, Optional

import pandas as pd
import yfinance as yf


@dataclass(frozen=True)
class CompanyProfile:
    """Structured snapshot of company fundamentals."""

    ticker: str
    name: Optional[str]
    sector: Optional[str]
    industry: Optional[str]
    market_cap: Optional[float]
    summary: Optional[str]


class DataRetrievalError(RuntimeError):
    """Raised when remote financial data cannot be obtained."""


@lru_cache(maxsize=32)
def _download_ticker(ticker: str) -> yf.Ticker:
    try:
        return yf.Ticker(ticker)
    except Exception as exc:  # pragma: no cover - yfinance raises many types
        raise DataRetrievalError(f"Unable to initialize ticker '{ticker}': {exc}") from exc


def get_company_profile(ticker: str) -> CompanyProfile:
    ticker_obj = _download_ticker(ticker)
    try:
        general_info: Dict[str, Any] = ticker_obj.info or {}
    except Exception:  # pragma: no cover
        general_info = {}

    return CompanyProfile(
        ticker=ticker.upper(),
        name=general_info.get("longName") or general_info.get("shortName"),
        sector=general_info.get("sector"),
        industry=general_info.get("industry"),
        market_cap=general_info.get("marketCap"),
        summary=general_info.get("longBusinessSummary"),
    )


def get_price_history(ticker: str) -> pd.DataFrame:
    """Return a cleaned OHLCV dataframe indexed by UTC timestamps."""

    ticker_obj = _download_ticker(ticker)
    try:
        history = ticker_obj.history(period="max", auto_adjust=True)
    except Exception as exc:  # pragma: no cover
        raise DataRetrievalError(f"Unable to download history for '{ticker}': {exc}") from exc

    if history.empty:
        raise DataRetrievalError(f"No pricing data returned for '{ticker}'.")

    history = history.tz_localize(None) if history.index.tz is not None else history
    return history.sort_index()


def get_recent_price(ticker: str) -> float:
    history = get_price_history(ticker)
    return float(history["Close"].iloc[-1])
