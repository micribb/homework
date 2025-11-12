import pandas as pd
import numpy as np
import pytest

from stock_insights.metrics import (
    TRADING_DAYS_PER_YEAR,
    build_timeframe_stat,
    compute_cagr,
    compute_log_returns,
    max_drawdown,
    annualized_volatility,
)


@pytest.fixture
def price_series():
    # Simulate five years of business-day prices trending upward
    index = pd.date_range("2018-01-01", periods=TRADING_DAYS_PER_YEAR * 5, freq="B")
    values = np.linspace(100, 250, len(index))
    return pd.Series(values, index=index)


def test_compute_log_returns_matches_manual(price_series):
    log_returns = compute_log_returns(price_series)
    manual = np.log(price_series / price_series.shift(1)).dropna()
    pd.testing.assert_series_equal(log_returns, manual)


def test_build_timeframe_stat_basic(price_series):
    stat = build_timeframe_stat(price_series, "1y", pd.DateOffset(years=1))
    assert stat is not None
    assert stat.label == "1y"
    assert stat.end_date == price_series.index[-1]
    assert stat.total_return == pytest.approx(price_series.iloc[-1] / price_series.iloc[-252] - 1, rel=1e-3)
    assert stat.cagr == pytest.approx(compute_cagr(price_series.iloc[-252:]), rel=1e-3)
    assert stat.volatility == pytest.approx(annualized_volatility(price_series.iloc[-252:]), rel=1e-3)
    assert stat.max_drawdown == pytest.approx(max_drawdown(price_series.iloc[-252:]), rel=1e-3)


def test_build_timeframe_stat_handles_short_history(price_series):
    short_prices = price_series.iloc[-5:]
    stat = build_timeframe_stat(short_prices, "1m", pd.DateOffset(months=1))
    assert stat is None


def test_compute_cagr_handles_flat_series():
    index = pd.date_range("2020-01-01", periods=10, freq="B")
    flat_prices = pd.Series(100.0, index=index)
    assert compute_cagr(flat_prices) == 0.0


def test_max_drawdown_negative(price_series):
    drawdown = max_drawdown(price_series)
    assert drawdown <= 0
