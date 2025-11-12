"""User interface helpers shared by CLI and interactive launcher."""

from __future__ import annotations

from pathlib import Path
from typing import Optional

import json
import pandas as pd
from rich.console import Console
from rich.table import Table

from .report_builder import StockReport, summarize_timeframe_stats


def _resolve_console(console: Optional[Console]) -> Console:
    """Return ``console`` if provided otherwise instantiate a default one."""

    return console or Console()


def render_report(report: StockReport, console: Optional[Console] = None) -> None:
    """Pretty-print the analytics summary for a ticker."""

    console = _resolve_console(console)
    profile = report.profile
    console.rule(f"[bold green]{profile.ticker} — {profile.name or 'Unknown Company'}")

    meta_table = Table(show_header=False)
    meta_table.add_row("Sector", profile.sector or "N/A")
    meta_table.add_row("Industry", profile.industry or "N/A")
    if profile.market_cap:
        meta_table.add_row("Market Cap", format_market_cap(profile.market_cap))
    console.print(meta_table)

    stats_df = summarize_timeframe_stats(report.timeframe_stats)
    if not stats_df.empty:
        console.print("\n[bold]Performance by timeframe[/bold]")
        console.print(dataframe_to_rich_table(stats_df))

    console.print("\n[bold]Trading profile[/bold]")
    console.print(
        f"Style: [cyan]{report.trading_profile.style}[/cyan] "
        f"(confidence: {report.trading_profile.confidence})"
    )
    console.print(report.trading_profile.notes)

    if report.momentum_score is not None:
        console.print(f"\nMomentum (last 3 months): {report.momentum_score * 100:.2f}%")

    if not report.recommendations:
        console.print("\nNo recommendations generated.")
    else:
        console.print("\n[bold]Actionable ideas[/bold]")
        for rec in report.recommendations:
            console.print(f"• [green]{rec.headline}[/green] — {rec.rationale}")

    if not report.seasonality.empty:
        console.print("\n[bold]Seasonality — average monthly return[/bold]")
        for month, value in report.seasonality.items():
            console.print(f"{month}: {value * 100:.2f}%")

    if profile.summary:
        console.print("\n[bold]Business summary[/bold]")
        console.print(profile.summary)


def export_report_json(
    report: StockReport, path: Path, console: Optional[Console] = None
) -> None:
    """Persist report data as JSON for use in spreadsheets or automation."""

    console = _resolve_console(console)
    payload = {
        "ticker": report.ticker,
        "profile": {
            "name": report.profile.name,
            "sector": report.profile.sector,
            "industry": report.profile.industry,
            "market_cap": report.profile.market_cap,
            "summary": report.profile.summary,
        },
        "trading_profile": {
            "style": report.trading_profile.style,
            "confidence": report.trading_profile.confidence,
            "notes": report.trading_profile.notes,
        },
        "momentum_score": report.momentum_score,
        "recommendations": [
            {"headline": rec.headline, "rationale": rec.rationale}
            for rec in report.recommendations
        ],
        "timeframe_stats": [
            {
                "label": stat.label,
                "start": stat.start_date.isoformat(),
                "end": stat.end_date.isoformat(),
                "total_return": stat.total_return,
                "cagr": stat.cagr,
                "volatility": stat.volatility,
                "max_drawdown": stat.max_drawdown,
            }
            for stat in report.timeframe_stats
        ],
        "seasonality": report.seasonality.to_dict(),
    }
    path.write_text(json.dumps(payload, indent=2), encoding="utf-8")
    console.print(f"\nSaved JSON analytics to {path}")


def export_timeframe_csv(
    report: StockReport, path: Path, console: Optional[Console] = None
) -> None:
    """Write timeframe statistics to a CSV file."""

    console = _resolve_console(console)
    stats_df = summarize_timeframe_stats(report.timeframe_stats)
    stats_df.to_csv(path, index=False)
    console.print(f"Saved timeframe metrics to {path}")


def dataframe_to_rich_table(df: pd.DataFrame) -> Table:
    table = Table(show_header=True, header_style="bold magenta")
    for column in df.columns:
        table.add_column(str(column))
    for _, row in df.iterrows():
        table.add_row(*["N/A" if pd.isna(value) else str(value) for value in row])
    return table


def format_market_cap(value: float) -> str:
    trillions = 1_000_000_000_000
    billions = 1_000_000_000
    millions = 1_000_000
    if value >= trillions:
        return f"${value / trillions:.2f}T"
    if value >= billions:
        return f"${value / billions:.2f}B"
    if value >= millions:
        return f"${value / millions:.2f}M"
    return f"${value:,.0f}"

