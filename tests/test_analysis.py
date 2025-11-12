import pandas as pd

from stock_insights.analysis import (
    TradingProfile,
    classify_trading_profile,
    compute_seasonality,
    derive_recommendations,
)
from stock_insights.metrics import TimeframeStat


def make_stat(label: str, total_return: float = 0.0, cagr=None, volatility=None, max_drawdown=None):
    index = pd.date_range("2023-01-01", periods=10, freq="B")
    return TimeframeStat(
        label=label,
        start_date=index[0],
        end_date=index[-1],
        total_return=total_return,
        cagr=cagr,
        volatility=volatility,
        max_drawdown=max_drawdown,
    )


def test_classify_trading_profile_long_term_growth():
    stats = [
        make_stat("10y", cagr=0.18, volatility=0.2),
        make_stat("5y", cagr=0.2, volatility=0.25),
        make_stat("1m", total_return=0.02, volatility=0.1),
    ]
    profile = classify_trading_profile(stats)
    assert isinstance(profile, TradingProfile)
    assert profile.style == "Long-term compound growth"


def test_classify_trading_profile_contrarian():
    stats = [
        make_stat("5y", cagr=0.08, volatility=0.2),
        make_stat("1m", total_return=-0.1, volatility=0.2),
    ]
    profile = classify_trading_profile(stats)
    assert profile.style == "Contrarian accumulation"


def test_derive_recommendations_momentum_and_risk():
    stats = [
        make_stat("5y", cagr=0.25),
        make_stat("1y", total_return=-0.05, max_drawdown=-0.35),
        make_stat("1m", total_return=0.08, volatility=0.7),
    ]
    recs = derive_recommendations(stats)
    headlines = {rec.headline for rec in recs}
    assert {
        "Accelerating secular growth",
        "Risk management focus",
        "Short-term volatility spike",
        "Momentum-backed accumulation",
    }.issubset(headlines)


def test_compute_seasonality_orders_calendar():
    index = pd.date_range("2020-01-01", periods=24, freq="M")
    prices = pd.Series(range(100, 124), index=index)
    seasonality = compute_seasonality(prices)
    assert list(seasonality.index) == [
        "Feb",
        "Mar",
        "Apr",
        "May",
        "Jun",
        "Jul",
        "Aug",
        "Sep",
        "Oct",
        "Nov",
        "Dec",
    ]
