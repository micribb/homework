"""Computation of quantitative metrics for equities."""

from __future__ import annotations

from dataclasses import dataclass
from typing import Iterable, List, Optional

import numpy as np
import pandas as pd


TRADING_DAYS_PER_YEAR = 252


@dataclass(frozen=True)
class TimeframeStat:
    label: str
    start_date: pd.Timestamp
    end_date: pd.Timestamp
    total_return: float
    cagr: Optional[float]
    volatility: Optional[float]
    max_drawdown: Optional[float]


def compute_log_returns(prices: pd.Series) -> pd.Series:
    return np.log(prices / prices.shift(1)).dropna()


def annualized_volatility(prices: pd.Series) -> Optional[float]:
    if len(prices) < 2:
        return None
    log_returns = compute_log_returns(prices)
    if log_returns.empty:
        return None
    return float(log_returns.std() * np.sqrt(TRADING_DAYS_PER_YEAR))


def max_drawdown(prices: pd.Series) -> Optional[float]:
    if prices.empty:
        return None
    running_max = prices.cummax()
    drawdown = (prices / running_max) - 1.0
    return float(drawdown.min())


def compute_cagr(prices: pd.Series) -> Optional[float]:
    if len(prices) < 2:
        return None
    start_price = prices.iloc[0]
    end_price = prices.iloc[-1]
    days = (prices.index[-1] - prices.index[0]).days
    if days <= 0:
        return None
    years = days / 365.25
    return float((end_price / start_price) ** (1 / years) - 1)


def slice_prices_for_timeframe(prices: pd.Series, offset: pd.DateOffset) -> pd.Series:
    end_date = prices.index[-1]
    start_date = end_date - offset
    sliced = prices[prices.index >= start_date]
    if sliced.empty and not prices.empty:
        # If not enough data, fallback to earliest available
        return prices
    return sliced


def build_timeframe_stat(prices: pd.Series, label: str, offset: pd.DateOffset) -> Optional[TimeframeStat]:
    if prices.empty:
        return None
    window = slice_prices_for_timeframe(prices, offset)
    if len(window) < 2:
        return None

    total_return = float(window.iloc[-1] / window.iloc[0] - 1)
    cagr = compute_cagr(window)
    volatility = annualized_volatility(window)
    drawdown = max_drawdown(window)

    return TimeframeStat(
        label=label,
        start_date=window.index[0],
        end_date=window.index[-1],
        total_return=total_return,
        cagr=cagr,
        volatility=volatility,
        max_drawdown=drawdown,
    )


def build_timeframe_stats(prices: pd.Series, config: Iterable[tuple[str, pd.DateOffset]]) -> List[TimeframeStat]:
    stats: List[TimeframeStat] = []
    for label, offset in config:
        stat = build_timeframe_stat(prices, label, offset)
        if stat is not None:
            stats.append(stat)
    return stats


def rolling_momentum(prices: pd.Series, window: int = 63) -> Optional[float]:
    """Compute a simple momentum score using the most recent window."""

    if len(prices) < window:
        return None
    window_prices = prices.iloc[-window:]
    return float(window_prices.iloc[-1] / window_prices.iloc[0] - 1)


def stability_score(volatility: Optional[float]) -> Optional[float]:
    if volatility is None:
        return None
    # Scale such that lower volatility -> higher score
    return float(max(0.0, 1.0 - volatility))
