"""Command line interface for the stock insights agent."""

from __future__ import annotations

from pathlib import Path
from typing import Optional

import typer
from rich.console import Console

from .report_builder import build_stock_report
from .ui import export_report_json, export_timeframe_csv, render_report

app = typer.Typer(
    help="Generate data-driven insights for equities using multi-horizon analytics."
)
console = Console()


@app.command()
def analyze(
    ticker: str = typer.Argument(..., help="Ticker symbol to analyze (e.g., NVDA, AMZN)."),
    export_json: Optional[Path] = typer.Option(
        None,
        "--export-json",
        help="Optional path to dump the computed analytics as JSON for further automation.",
    ),
    export_csv: Optional[Path] = typer.Option(
        None,
        "--export-csv",
        help="Optional path to save the timeframe metrics table as CSV (Google Sheets compatible).",
    ),
) -> None:
    """Fetch historical market data, compute metrics, and print a narrative summary."""

    console.print(f"[bold cyan]Fetching analytics for {ticker.upper()}[/bold cyan]")
    try:
        report = build_stock_report(ticker)
    except Exception as exc:  # pragma: no cover - surfacing informative error to users
        console.print(f"[bold red]Failed to build report:[/bold red] {exc}")
        raise typer.Exit(code=1)

    render_report(report, console=console)

    if export_json:
        export_report_json(report, export_json, console=console)
    if export_csv:
        export_timeframe_csv(report, export_csv, console=console)


if __name__ == "__main__":
    app()
