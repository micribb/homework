"""Domain heuristics to translate metrics into insights."""

from __future__ import annotations

from dataclasses import dataclass

from typing import Iterable, List, Optional

import pandas as pd

from .metrics import TimeframeStat


@dataclass(frozen=True)
class Recommendation:
    headline: str
    rationale: str


@dataclass(frozen=True)
class TradingProfile:
    style: str
    confidence: str
    notes: str


def classify_trading_profile(stats: Iterable[TimeframeStat]) -> TradingProfile:
    stats = list(stats)
    if not stats:
        return TradingProfile(
            style="Insufficient data",
            confidence="low",
            notes="Not enough history to classify trading approach.",
        )

    long_term = [s for s in stats if s.label in {"15y", "10y", "5y"}]
    short_term = [s for s in stats if s.label in {"6m", "3m", "1m", "1w", "1d"}]

    avg_long_cagr = _mean([s.cagr for s in long_term if s.cagr is not None])
    avg_long_vol = _mean([s.volatility for s in long_term if s.volatility is not None])
    avg_short_vol = _mean([s.volatility for s in short_term if s.volatility is not None])
    recent_return = _mean([s.total_return for s in short_term])

    if (
        avg_long_cagr is not None
        and avg_long_cagr > 0.15
        and (avg_long_vol or 0) < 0.35
    ):
        return TradingProfile(
            style="Long-term compound growth",
            confidence="high",
            notes="Sustained double-digit CAGR with manageable volatility makes the equity "
            "attractive for buy-and-hold allocation.",
        )
    if avg_short_vol is not None and avg_short_vol > 0.5:
        return TradingProfile(
            style="High-volatility, tactical trading",
            confidence="medium",
            notes="Elevated short-term volatility suggests opportunity for swing or options "
            "strategies. Position sizing discipline is critical.",
        )
    if recent_return is not None and recent_return < 0:
        return TradingProfile(
            style="Contrarian accumulation",
            confidence="medium",
            notes="Recent weakness contrasted with longer history may offer discounted entry if "
            "fundamentals remain intact.",
        )
    if avg_long_cagr is not None and avg_long_cagr > 0.07:
        return TradingProfile(
            style="Core portfolio holding",
            confidence="medium",
            notes="Steady compounding supports dollar-cost averaging and dividend reinvestment "
            "strategies.",
        )
    return TradingProfile(
        style="Watchlist / research",
        confidence="low",
        notes="Momentum is muted. Monitor catalysts, valuation, and macro drivers before committing capital.",
    )


def derive_recommendations(stats: Iterable[TimeframeStat]) -> List[Recommendation]:
    stats = list(stats)
    recs: List[Recommendation] = []

    long_term = {s.label: s for s in stats if s.label in {"15y", "10y", "5y", "3y", "2y", "1y"}}
    short_term = {s.label: s for s in stats if s.label in {"6m", "3m", "1m", "1w", "1d"}}

    five_year = long_term.get("5y")
    one_year = long_term.get("1y")
    one_month = short_term.get("1m")

    if five_year and five_year.cagr is not None and five_year.cagr > 0.18:
        recs.append(
            Recommendation(
                headline="Accelerating secular growth",
                rationale="Five-year CAGR exceeds 18%, indicating durable demand tailwinds. Consider systematic"
                " accumulation before seasonally strong periods (earnings, holidays).",
            )
        )

    if one_year and one_year.total_return < 0:
        recs.append(
            Recommendation(
                headline="Potential value re-rating",
                rationale="Trailing one-year performance is negative. Pair with qualitative catalyst scan to spot"
                " rebound opportunities or covered-call overlays.",
            )
        )

    if one_month and one_month.volatility is not None and one_month.volatility > 0.6:
        recs.append(
            Recommendation(
                headline="Short-term volatility spike",
                rationale="Latest month exhibits >60% annualized volatility. Evaluate earnings or macro catalysts"
                " for event-driven trades (straddles, strangles).",
            )
        )

    if one_year and one_year.max_drawdown is not None and one_year.max_drawdown < -0.3:
        recs.append(
            Recommendation(
                headline="Risk management focus",
                rationale="Drawdown worse than -30% in the last year. Tighten stop-loss discipline and pair trades"
                " with hedges.",
            )
        )

    if (
        one_month
        and one_year
        and one_month.total_return is not None
        and one_year.total_return is not None
        and one_month.total_return > 0.05
        and one_year.total_return > 0.1
    ):
        recs.append(
            Recommendation(
                headline="Momentum-backed accumulation",
                rationale="Positive returns across the last month and year hint at persistent demand. Consider"
                " staged entries before known catalysts to compound gains.",
            )
        )

    if not recs:
        recs.append(
            Recommendation(
                headline="Maintain situational awareness",
                rationale="Blend quantitative view with news, supply-chain dynamics, and macro indicators to uncover"
                " thematic trades (AI, reshoring, climate).",
            )
        )

    return recs


def compute_seasonality(prices: pd.Series) -> pd.Series:
    if prices.empty:
        return pd.Series(dtype=float)
    monthly = prices.resample("M").last()
    returns = monthly.pct_change().dropna()
    if returns.empty:
        return pd.Series(dtype=float)
    grouped = returns.groupby(returns.index.month).mean()
    month_order = list(range(1, 13))
    grouped = grouped.reindex(month_order).dropna()
    grouped.index = grouped.index.map(lambda m: pd.Timestamp(month=m, year=2000, day=1).strftime("%b"))
    return grouped


def _mean(values: Iterable[Optional[float]]) -> Optional[float]:
    filtered = [v for v in values if v is not None]
    if not filtered:
        return None
    return sum(filtered) / len(filtered)
