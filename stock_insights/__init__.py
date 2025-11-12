"""High-level package exports for the stock insights toolkit."""

from .report_builder import build_stock_report
from .cli import app
from .interface import launch_interactive

__all__ = ["build_stock_report", "app", "launch_interactive"]
