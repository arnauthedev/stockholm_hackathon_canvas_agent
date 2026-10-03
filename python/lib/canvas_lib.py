"""Helpers importable by generated scripts (PYTHONPATH includes python/lib).

A fetch script's contract: print ONE JSON object to stdout; the runner merges it
into data.json atomically. Scripts may also call atomic_write themselves, but only
for data.json in their own folder (cwd).
"""
from __future__ import annotations

import json
import os
import tempfile
from typing import Any

import requests


def atomic_write(path: str, obj: Any) -> None:
    d = os.path.dirname(os.path.abspath(path))
    fd, tmp = tempfile.mkstemp(dir=d, prefix=".tmp-")
    with os.fdopen(fd, "w") as f:
        json.dump(obj, f)
    os.replace(tmp, path)


def fetch_json(url: str, timeout: float = 10, **kw: Any) -> Any:
    r = requests.get(url, timeout=timeout, headers={"User-Agent": "canvas-agent/0.1"}, **kw)
    r.raise_for_status()
    return r.json()


def emit(obj: dict) -> None:
    """Print the data patch for the runner."""
    print(json.dumps(obj, default=str))


def quote(ticker: str) -> dict:
    """Latest price for a ticker via yfinance. Returns a Metric-friendly dict.

    Uses fast_info attributes (fast_info.get() returns None for computed fields),
    falling back to recent 1-minute history.
    """
    import yfinance as yf

    t = yf.Ticker(ticker)
    fi = t.fast_info
    price = prev = None
    currency = "USD"
    try:
        price = float(fi.last_price)
        prev = float(fi.previous_close)
        currency = fi.currency or currency
    except Exception:
        pass
    if price is None or prev is None:
        h = t.history(period="5d", interval="1d")
        if len(h) >= 1:
            price = price or float(h["Close"].iloc[-1])
        if len(h) >= 2:
            prev = prev or float(h["Close"].iloc[-2])
    if price is None:
        raise RuntimeError(f"no price for {ticker}")
    delta = price - prev if prev else None
    return {
        "symbol": ticker.upper(),
        "price": round(price, 2),
        "currency": currency,
        "change": round(delta, 2) if delta is not None else None,
        "change_pct": round(delta / prev * 100, 2) if prev and delta is not None else None,
        "trend": "flat" if not delta else ("up" if delta > 0 else "down"),
        "delayed": True,
    }
