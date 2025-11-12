# Stock Insights Agent

This project provides a command-line intelligence layer that surfaces multi-horizon, data-driven
analytics for any U.S. equity ticker. Enter a symbol (e.g., `NVDA`, `AMZN`, `GOOGL`) to obtain:

* Timeframe-aware performance metrics from 15 years down to 1 trading day
* Volatility, CAGR, and drawdown diagnostics for each horizon
* Automated trading style classification with qualitative notes
* Momentum snapshot, seasonal tendencies, and contextual business summary
* Export hooks to share metrics with spreadsheets or other automation workflows

The architecture is intentionally modular so the system can evolve into a full automated trading
assistant. Future enhancements can plug in broker APIs (E*TRADE, Alpaca, etc.), specialized web
crawlers, or reinforcement-learning agents without reworking the analytics core.

## Quick start

1. Install dependencies (Python 3.10+ recommended):

   ```bash
   pip install -r requirements.txt
   ```

2. Launch the all-in-one interactive experience by double-clicking `run_stock_insights.py`
   (or running `python run_stock_insights.py`). You will be prompted for a ticker and can keep
   requesting fresh reports without restarting the program.

3. Prefer scripted automation? Run the CLI for any ticker:

   ```bash
   python -m stock_insights analyze NVDA
   ```

   Add optional exports:

   ```bash
   python -m stock_insights analyze AMZN --export-json amzn.json --export-csv amzn.csv
   ```

   The CSV output drops directly into Google Sheets so you can mirror performance tables in the
   Google Finance template shown in the screenshots.

## Project layout

```
stock_insights/
├── __init__.py              # Package entry points
├── __main__.py              # Enables `python -m stock_insights`
├── analysis.py              # Heuristics that convert metrics into recommendations
├── cli.py                   # Typer-based command line interface
├── data.py                  # yfinance integration for profile + historical prices
├── metrics.py               # Multi-horizon quantitative analytics
├── report_builder.py        # Orchestrates fetching, metrics, and reporting
├── interface.py             # Interactive text UI used by the desktop-style launcher
└── ui.py                    # Shared rendering/export helpers

run_stock_insights.py        # Double-click entry point that opens the interactive prompt
```

Each module is unit-test friendly and exposes pure functions so future agents (web crawlers, alert
bots, reinforcement learners) can reuse the analytics engine without shelling out to the CLI.

## Extensibility roadmap

* **Broker integration** – Leverage the JSON export to kick off trade tickets via the E*TRADE API.
* **Real-time crawling** – Feed news, alternative data (supply-chain alerts, weather, contracts) into
  the recommendation layer for thematic trade discovery.
* **Dashboard UI** – Wrap the CLI in Streamlit or Next.js, embedding live Plotly charts synced with
  Google Finance via Sheets API refresh triggers.
* **Agentic workflows** – Pair this analytics core with GPT-based planners that backtest strategies
  or perform Monte Carlo scenario analysis for specific industries (AI, renewables, defense, etc.).

## Notes on data quality

The toolkit relies on [yfinance](https://github.com/ranaroussi/yfinance) for historical data. While
it is robust, you should validate outputs against your brokerage or institutional data feeds before
executing trades. All metrics are for informational purposes only and are not financial advice.
