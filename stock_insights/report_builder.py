"""Orchestrates data retrieval, metric computation, and insight generation."""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Iterable, List, Optional

import pandas as pd

from .analysis import Recommendation, TradingProfile, classify_trading_profile, compute_seasonality, derive_recommendations
from .data import CompanyProfile, get_company_profile, get_price_history
from .metrics import TimeframeStat, build_timeframe_stats, rolling_momentum


TIMEFRAME_CONFIG: List[tuple[str, pd.DateOffset]] = [
    ("15y", pd.DateOffset(years=15)),
    ("10y", pd.DateOffset(years=10)),
    ("5y", pd.DateOffset(years=5)),
    ("3y", pd.DateOffset(years=3)),
    ("2y", pd.DateOffset(years=2)),
    ("1y", pd.DateOffset(years=1)),
    ("6m", pd.DateOffset(months=6)),
    ("3m", pd.DateOffset(months=3)),
    ("1m", pd.DateOffset(months=1)),
    ("1w", pd.DateOffset(weeks=1)),
    ("1d", pd.DateOffset(days=1)),
]


@dataclass(frozen=True)
class StockReport:
    ticker: str
    profile: CompanyProfile
    timeframe_stats: List[TimeframeStat]
    trading_profile: TradingProfile
    recommendations: List[Recommendation]
    momentum_score: Optional[float]
    seasonality: pd.Series = field(repr=False)


def build_stock_report(ticker: str) -> StockReport:
    ticker = ticker.upper()
    profile = get_company_profile(ticker)
    history = get_price_history(ticker)
    closes = history["Close"].dropna()

    stats = build_timeframe_stats(closes, TIMEFRAME_CONFIG)
    trading_profile = classify_trading_profile(stats)
    recommendations = derive_recommendations(stats)
    momentum = rolling_momentum(closes)
    seasonality = compute_seasonality(closes)

    return StockReport(
        ticker=ticker,
        profile=profile,
        timeframe_stats=stats,
        trading_profile=trading_profile,
        recommendations=recommendations,
        momentum_score=momentum,
        seasonality=seasonality,
    )


def summarize_timeframe_stats(stats: Iterable[TimeframeStat]) -> pd.DataFrame:
    rows = []
    for stat in stats:
        rows.append(
            {
                "Timeframe": stat.label,
                "Start": stat.start_date.date(),
                "End": stat.end_date.date(),
                "Total Return %": round(stat.total_return * 100, 2),
                "CAGR %": round((stat.cagr or float("nan")) * 100, 2) if stat.cagr is not None else None,
                "Volatility %": round((stat.volatility or float("nan")) * 100, 2) if stat.volatility is not None else None,
                "Max Drawdown %": round((stat.max_drawdown or float("nan")) * 100, 2) if stat.max_drawdown is not None else None,
            }
        )
    return pd.DataFrame(rows)
