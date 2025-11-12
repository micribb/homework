"""Simple interactive launcher for the stock insights agent."""

from __future__ import annotations

from typing import Optional

from rich.console import Console
from rich.prompt import Confirm, Prompt

from .data import DataRetrievalError
from .report_builder import build_stock_report
from .ui import render_report


def launch_interactive(default_ticker: Optional[str] = None) -> None:
    """Run an interactive prompt allowing users to analyze multiple tickers."""

    console = Console()
    console.print(
        "[bold cyan]\nStock Insights Interactive[/bold cyan]\n"
        "Enter a ticker like NVDA or AMZN to fetch analytics."
    )

    ticker = default_ticker
    while True:
        if not ticker:
            ticker = Prompt.ask("Ticker (or type 'quit' to exit)").strip()
        if ticker.lower() in {"", "q", "quit", "exit"}:
            break

        console.print(f"\n[bold cyan]Analyzing {ticker.upper()}[/bold cyan]")
        try:
            report = build_stock_report(ticker)
        except DataRetrievalError as exc:
            console.print(f"[bold red]Data error:[/bold red] {exc}")
        except Exception as exc:  # pragma: no cover - display unexpected issues
            console.print(f"[bold red]Unexpected error:[/bold red] {exc}")
        else:
            render_report(report, console=console)

        console.print()
        if not Confirm.ask("Analyze another ticker?", default=False):
            break
        ticker = None

    console.print("\n[bold green]Goodbye![/bold green]")


if __name__ == "__main__":  # pragma: no cover - convenience for direct execution
    launch_interactive()
