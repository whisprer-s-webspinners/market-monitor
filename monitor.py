"""Local Yahoo Finance monitor. All prices and model outputs are informational."""
import argparse
import calendar
import json
import logging
import math
import os
import queue
import socket
import threading
import time
import webbrowser
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.error import URLError
from urllib.parse import parse_qs, urlsplit
from urllib.request import ProxyHandler, build_opener
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

import yfinance as yf
from yfinance.exceptions import YFRateLimitError

VERSION = "1.0.0"
HERE = Path(__file__).resolve().parent
WEB = HERE / "web"
HOST = "127.0.0.1"
APP_ID = "market-monitor-local"
ASSETS = {
    "btc": ("Bitcoin", "BTC-USD", "USD", "24/7 crypto reference"),
    "spx": ("S&P 500", "^GSPC", "index pts", "US cash index · Kraken Prop prices may differ"),
    "copper": ("Copper", "HG=F", "USD/lb", "COMEX futures proxy · Kraken Prop prices may differ"),
    "eth": ("Ethereum", "ETH-USD", "USD", "24/7 crypto reference"),
    "crypto": ("Crypto basket", None, "base 100", "BTC, ETH, SOL, XRP and ADA · rebalanced daily"),
    "usd": ("US Dollar Index", "DX-Y.NYB", "index pts", "DXY · USD strength against a currency basket"),
    "gbp": ("GBP/USD", "GBPUSD=X", "USD per £", "More USD per pound means a stronger pound vs USD"),
    "ftse": ("FTSE 100", "^FTSE", "index pts", "UK cash index · local-market price return"),
    "nikkei": ("Nikkei 225", "^N225", "index pts", "Japan cash index · local-market price return"),
    "world": ("Global equities", "ACWI", "USD", "iShares MSCI ACWI ETF · USD share price"),
    "gold": ("Gold", "GC=F", "USD/troy oz", "COMEX futures proxy"),
    "silver": ("Silver", "SI=F", "USD/troy oz", "COMEX futures proxy"),
}
BASKET = ("btc", "eth", "sol", "xrp", "ada")
TICKERS = {key: spec[1] for key, spec in ASSETS.items() if spec[1]}
TICKERS.update(sol="SOL-USD", xrp="XRP-USD", ada="ADA-USD")
# Five days of minute data allows recent-session views through normal weekends.
SERIES = {
    "minute": ("1m", "5d", 60),
    "week": ("15m", "1mo", 900),
    "daily": ("1d", "2y", 300),
}
RANGES = {"1h": "minute", "1d": "minute", "1w": "week",
          "1mo": "daily", "6mo": "daily", "ytd": "daily"}
COMPARE = {"1w", "1mo", "6mo", "ytd"}
UTC = timezone.utc


@dataclass
class Series:
    bars: list
    fetched: int
    quote: list | None = None
    tz: str = "UTC"


def timezone_for(name):
    try:
        return ZoneInfo(name)
    except (ZoneInfoNotFoundError, ValueError, TypeError):
        return UTC


def positive(value):
    try:
        number = float(value)
        return number if math.isfinite(number) and number > 0 else None
    except (TypeError, ValueError, OverflowError):
        return None


def fetch_yahoo(key, kind):
    interval, period, _ = SERIES[kind]
    ticker = yf.Ticker(TICKERS[key])
    table = ticker.history(period=period, interval=interval, prepost=False,
                           auto_adjust=False, actions=False, timeout=12)
    if table.empty:
        raise ValueError("Yahoo returned an empty history")
    meta = ticker.history_metadata
    tz = str(table.index.tz or meta.get("exchangeTimezoneName") or "UTC")
    bars = {}
    for index, *values in table[["Open", "High", "Low", "Close"]].itertuples(name=None):
        if index.tzinfo is None:
            index = index.tz_localize(timezone_for(tz))
        prices = [positive(value) for value in values]
        if all(value is not None for value in prices):
            stamp = int(index.timestamp())
            bars[stamp] = [stamp, *prices, index.strftime("%Y-%m-%d")]
    if not bars:
        raise ValueError("Yahoo returned no valid price bars")
    market_time = meta.get("regularMarketTime")
    stamp = positive(market_time.timestamp() if isinstance(market_time, datetime) else market_time)
    price = positive(meta.get("regularMarketPrice"))
    quote = [int(stamp), price] if stamp and price and stamp <= time.time() + 120 else None
    return Series([bars[stamp] for stamp in sorted(bars)], int(time.time()), quote, tz)


def sample_data(key, kind):
    """Deterministic fictional data for offline use and interface verification."""
    step, count = {"minute": (60, 5 * 1440), "week": (900, 30 * 96),
                   "daily": (86400, 365)}[kind]
    base = dict(btc=82000, spx=6250, copper=5, eth=2800, usd=103, gbp=1.28,
                ftse=9300, nikkei=42000, world=132, gold=2800, silver=44,
                sol=140, xrp=1.8, ada=0.55)[key]
    salt = sum(map(ord, key))
    now = int(time.time())
    end = now // step * step
    bars = []
    for stamp in range(end - (count - 1) * step, end + 1, step):
        day = stamp / 86400
        close = base * (1 + 0.075 * math.sin(day / 24 + salt)
                        + 0.025 * math.cos(day / 4 + salt) + 0.006 * math.sin(day * 10 + salt))
        opened = close * (1 + 0.002 * math.sin(stamp / step * 2 + salt))
        width = 0.002 if kind == "daily" else 0.00035
        bars.append([stamp, opened, max(close, opened) * (1 + width),
                     min(close, opened) * (1 - width), close,
                     datetime.fromtimestamp(stamp, UTC).date().isoformat()])
    return Series(bars, now, [end, bars[-1][4]])


class MarketCache:
    """Single provider worker with a bounded key space and a shared 429 cooldown."""

    def __init__(self, root, provider=fetch_yahoo, spacing=1.5):
        self.root = root
        self.provider = provider
        self.spacing = spacing
        self.lock = threading.Lock()
        self.tasks = queue.PriorityQueue()
        self.data = {}
        self.errors = {}
        self.pending = {}
        self.serial = 0
        self.block_until = 0.0
        self.rate_streak = 0
        self.next_request = 0.0
        if self.root:
            self.root.mkdir(parents=True, exist_ok=True)
            self.load()

    def load(self):
        for key in TICKERS:
            for kind in SERIES:
                path = self.root / f"{key}-{kind}.json"
                try:
                    payload = json.loads(path.read_text(encoding="utf-8"))
                    entry = Series(**payload)
                    if entry.bars and 0 < entry.fetched <= time.time() + 120:
                        self.data[key, kind] = entry
                except FileNotFoundError:
                    continue
                except (ValueError, OSError, TypeError):
                    logging.warning("Could not load %s", path.name)

    def save(self, job, entry):
        if self.root is None:
            return
        path = self.root / f"{job[0]}-{job[1]}.json"
        temp = path.with_suffix(".tmp")
        try:
            temp.write_text(json.dumps(vars(entry), separators=(",", ":"), allow_nan=False), encoding="utf-8")
            temp.replace(path)
        except (ValueError, OSError) as exc:
            logging.warning("Could not save %s: %s", path.name, exc)

    def request(self, key, kind, priority=5):
        job = key, kind
        with self.lock:
            entry = self.data.get(job)
            now = time.time()
            if time.monotonic() < self.block_until:
                return entry
            if entry and now - entry.fetched < SERIES[kind][2]:
                return entry
            if job in self.errors and now < self.errors[job][1]:
                return entry
            current = self.pending.get(job)
            if current is None or (current[0] >= 0 and priority < current[0]):
                self.serial += 1
                item = priority, self.serial
                self.pending[job] = item
                self.tasks.put((*item, job))
            return entry

    def work(self):
        while True:
            priority, ticket, job = self.tasks.get()
            with self.lock:
                if self.pending.get(job) != (priority, ticket):
                    continue
                if time.monotonic() < self.block_until:
                    self.pending.pop(job, None)
                    continue
                self.pending[job] = (-1, ticket)
            time.sleep(max(0, self.next_request - time.monotonic()))
            try:
                entry = self.provider(*job)
                self.save(job, entry)
                with self.lock:
                    self.data[job] = entry
                    self.errors.pop(job, None)
                    self.rate_streak = 0
            except Exception as exc:
                message = str(exc).lower()
                rate_limited = isinstance(exc, YFRateLimitError) or "429" in message or "too many requests" in message
                with self.lock:
                    if rate_limited:
                        self.rate_streak += 1
                        delay = min(1800, 120 * 2 ** min(4, self.rate_streak - 1))
                        self.block_until = time.monotonic() + delay
                        reason = "Yahoo rate limit"
                    else:
                        delay = max(120, SERIES[job[1]][2])
                        reason = "Yahoo data unavailable"
                    self.errors[job] = (reason, time.time() + delay)
                logging.warning("%s %s: %s", *job, str(exc)[:300])
            finally:
                self.next_request = time.monotonic() + self.spacing
                with self.lock:
                    self.pending.pop(job, None)

    def status(self, jobs):
        with self.lock:
            return {
                "queued": sum(job in self.pending for job in jobs),
                "errors": [self.errors[job][0] for job in jobs if job in self.errors],
                "backoff": math.ceil(max(0, self.block_until - time.monotonic())),
            }

    def latest_intraday(self, key):
        with self.lock:
            available = (self.data.get((key, kind)) for kind in ("minute", "week"))
            return max((entry for entry in available if entry),
                       key=lambda entry: (entry.quote or entry.bars[-1])[0], default=None)


def daily_levels(entry):
    return {bar[5]: bar[4] for bar in entry.bars}


def basket_series(entries):
    if any(entry is None for entry in entries):
        return None
    levels = [daily_levels(entry) for entry in entries]
    common = sorted(set.intersection(*(set(series) for series in levels)))
    if not common:
        return None
    bars = []
    close = 100
    previous = common[0]
    for day in common:
        stamp = int(datetime.fromisoformat(day).replace(tzinfo=UTC).timestamp())
        close *= sum(series[day] / series[previous] for series in levels) / len(levels)
        bars.append([stamp, close, close, close, close, day])
        previous = day
    # This index uses daily closes (the current UTC day may be provisional).
    return Series(bars, min(entry.fetched for entry in entries))


def cutoff_day(window, today):
    if window == "ytd":
        return today.replace(month=1, day=1)
    if window == "1w":
        return today - timedelta(days=7)
    months = 1 if window == "1mo" else 6
    year, month = divmod(today.year * 12 + today.month - 1 - months, 12)
    return today.replace(year=year, month=month + 1,
                         day=min(today.day, calendar.monthrange(year, month + 1)[1]))


def chart_data(entry, window, kind, now, basket=False):
    bars = entry.bars
    if kind == "minute":
        # When the venue is closed, pin the lookback to its last observed candle.
        threshold = bars[-1][0] - (3600 if window == "1h" else 86400)
        start = next((i for i, bar in enumerate(bars) if bar[0] > threshold), len(bars))
    elif kind == "week":
        start = next((i for i, bar in enumerate(bars) if bar[0] >= now - 7 * 86400), len(bars))
    else:
        today = datetime.fromtimestamp(now, timezone_for(entry.tz)).date()
        threshold = cutoff_day(window, today).isoformat()
        start = next((i for i, bar in enumerate(bars) if bar[5] >= threshold), len(bars))
    if start == len(bars):
        return {"bars": [], "fetched": entry.fetched}
    basis = bars[start][4] / 100 if basket else 1
    closes = [bar[4] / basis for bar in bars]
    prefix = [0.0]
    for close in closes:
        prefix.append(prefix[-1] + close)
    plotted = []
    for i in range(start, len(bars)):
        bar = bars[i]
        averages = [(prefix[i + 1] - prefix[i + 1 - n]) / n if i + 1 >= n else None for n in (20, 50)]
        plotted.append([bar[0], *[price / basis for price in bar[1:5]], bar[5], *averages])
    return {"bars": plotted, "fetched": entry.fetched}


def quote_data(daily, recent, basket=False):
    if daily is None and recent is None:
        return None
    entry = recent or daily
    if daily and recent and (daily.quote or daily.bars[-1])[0] > (recent.quote or recent.bars[-1])[0]:
        entry = daily
    bar = entry.bars[-1]
    price = bar[4]
    stamp = None
    if entry.quote:
        stamp, price = entry.quote
    elif entry is recent:
        stamp = bar[0]
    day = datetime.fromtimestamp(stamp, timezone_for(entry.tz)).date().isoformat() if stamp else bar[5]
    previous = next((old[4] for old in reversed(daily.bars) if old[5] < day), None) if daily else None
    if basket:
        price = None
    return {"price": price, "stamp": stamp, "day": day, "fetched": entry.fetched,
            "change": (bar[4] / previous - 1) * 100 if basket and previous else
                      (price / previous - 1) * 100 if previous else None}


def quantile(sorted_values, p):
    position = p * (len(sorted_values) - 1)
    low = int(position)
    fraction = position - low
    return sorted_values[low] * (1 - fraction) + sorted_values[min(low + 1, len(sorted_values) - 1)] * fraction


def model(entry, now):
    local_today = datetime.fromtimestamp(now, timezone_for(entry.tz)).date().isoformat()
    completed = [bar for bar in entry.bars if bar[5] < local_today][-121:]
    if len(completed) < 81:
        return None
    logs = [math.log(bar[4]) for bar in completed]
    fan = [[0, 0, 0, 0]]
    for steps in range(1, 21):
        sample = sorted(b - a for a, b in zip(logs, logs[steps:]))
        fan.append([steps, *[100 * math.expm1(quantile(sample, p)) for p in (0.1, 0.5, 0.9)]])
    # Walk-forward benchmark: each historical projection sees only prior data.
    errors = []
    for origin in range(len(logs) - 25, len(logs) - 5):
        training = logs[:origin + 1]
        history = sorted(b - a for a, b in zip(training, training[5:]))
        predicted = 100 * math.expm1(quantile(history, 0.5))
        actual = 100 * math.expm1(logs[origin + 5] - logs[origin])
        errors.append((abs(predicted - actual), abs(actual)))
    return {"fan": fan, "base": completed[-1][4], "day": completed[-1][5],
            "days": len(completed), "sample5": len(logs) - 5, "sample20": len(logs) - 20,
            "modelMae": sum(a for a, _ in errors) / len(errors),
            "flatMae": sum(b for _, b in errors) / len(errors), "benchmarkN": len(errors)}


def relative_series(series, window, now):
    levels = {key: daily_levels(entry) for key, entry in series.items() if entry}
    today = datetime.fromtimestamp(now, UTC).date()
    threshold = cutoff_day(window, today).isoformat()
    if len(levels) != len(series) or not levels:
        return {}
    common = set.intersection(*(set(values) for values in levels.values()))
    baseline = min((day for day in common if day >= threshold), default=None)
    if baseline is None:
        return {}
    return {key: [[day, (price / values[baseline] - 1) * 100]
                  for day, price in values.items() if day >= baseline]
            for key, values in levels.items()}


def dashboard(cache, asset, window, view, selected, demo):
    now = int(time.time())
    kind = "daily" if asset == "crypto" else RANGES[window]
    priority = 0 if view == "chart" else 4
    recent = cache.request(asset, kind, priority) if asset != "crypto" and kind != "daily" else None
    daily = {key: cache.request(key, "daily", 0 if view == "compare" and
             (key in selected or ("crypto" in selected and key in BASKET)) else
             1 if key == asset or (asset == "crypto" and key in BASKET) else 5) for key in TICKERS}
    daily["crypto"] = basket_series([daily[key] for key in BASKET])
    entry = daily[asset] if kind == "daily" else recent
    jobs = [(key, "daily") for key in TICKERS]
    if kind != "daily":
        jobs.append((asset, kind))
    status = cache.status(jobs)
    return {
        "demo": demo, "now": now, **status,
        "assets": {key: {"name": value[0], "symbol": value[1], "unit": value[2],
                         "note": value[3], "quote": quote_data(daily[key], cache.latest_intraday(key),
                                                               key == "crypto")}
                   for key, value in ASSETS.items()},
        "chart": chart_data(entry, window, kind, now, asset == "crypto") if entry and view == "chart" else None,
        "chartStatus": cache.status([(key, "daily") for key in BASKET] if asset == "crypto" else [(asset, kind)]),
        "kind": kind,
        "forecast": model(daily[asset], now) if daily[asset] and view == "chart" and asset != "crypto" else None,
        "compare": relative_series({key: daily[key] for key in selected}, window, now) if view == "compare" else {},
        "compareReady": all(daily[key] for key in selected),
    }


def default_root():
    if os.name == "nt":
        return Path(os.environ.get("LOCALAPPDATA") or Path.home() / "AppData" / "Local") / "MarketMonitor"
    return Path(os.environ.get("XDG_CACHE_HOME") or Path.home() / ".cache") / "market-monitor-local"


STATIC = {
    "/": ("index.html", "text/html; charset=utf-8"),
    "/style.css": ("style.css", "text/css; charset=utf-8"),
    "/app.js": ("app.js", "text/javascript; charset=utf-8"),
    "/icon.svg": ("icon.svg", "image/svg+xml"),
}


class Handler(BaseHTTPRequestHandler):
    server_version = "MarketMonitor/1"

    def log_message(self, *_):
        pass

    def reply(self, code, mime, body):
        self.send_response(code)
        self.send_header("Content-Type", mime)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("Referrer-Policy", "no-referrer")
        self.send_header("Content-Security-Policy",
                         "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self'; "
                         "connect-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'")
        self.end_headers()
        self.wfile.write(body)

    def json(self, payload, code=200):
        body = json.dumps(payload, separators=(",", ":"), allow_nan=False).encode()
        self.reply(code, "application/json; charset=utf-8", body)

    def do_GET(self):
        if self.headers.get("Host") != f"{HOST}:{self.server.server_port}" or self.headers.get("Sec-Fetch-Site") == "cross-site":
            self.send_error(403)
            return
        url = urlsplit(self.path)
        if url.path in STATIC:
            name, mime = STATIC[url.path]
            self.reply(200, mime, (WEB / name).read_bytes())
        elif url.path == "/health":
            self.json({"app": APP_ID, "version": VERSION, "demo": self.server.demo})
        elif url.path == "/api/market":
            try:
                params = parse_qs(url.query, max_num_fields=8)
                asset = params.get("asset", ["btc"])[0]
                window = params.get("range", ["1d"])[0]
                view = params.get("view", ["chart"])[0]
                selected = list(dict.fromkeys(params.get("series", ["btc,spx,copper"])[0].split(",")))
                if (asset not in ASSETS or window not in RANGES or view not in {"chart", "compare"}
                        or (view == "compare" and window not in COMPARE)
                        or (view == "chart" and asset == "crypto" and window not in COMPARE)
                        or not 1 <= len(selected) <= 6 or any(key not in ASSETS for key in selected)):
                    raise ValueError("Unknown symbol, range or comparison selection")
            except ValueError as exc:
                self.json({"error": str(exc)}, 400)
                return
            self.json(dashboard(self.server.cache, asset, window, view, selected, self.server.demo))
        else:
            self.send_error(404)


class LocalServer(ThreadingHTTPServer):
    def server_bind(self):
        if os.name == "nt":
            self.allow_reuse_address = False
            self.socket.setsockopt(socket.SOL_SOCKET, socket.SO_EXCLUSIVEADDRUSE, 1)
        super().server_bind()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--demo", action="store_true", help="Use fictional data, without contacting Yahoo")
    parser.add_argument("--no-browser", action="store_true")
    parser.add_argument("--port", type=int)
    args = parser.parse_args()
    port = args.port if args.port is not None else (8770 if args.demo else 8769)
    url = f"http://{HOST}:{port}/"
    logging.basicConfig(level=logging.WARNING, format="%(asctime)s %(levelname)s %(message)s")
    try:
        server = LocalServer((HOST, port), Handler)
    except OSError as exc:
        try:
            opener = build_opener(ProxyHandler({}))
            with opener.open(url + "health", timeout=2) as response:
                existing = json.load(response)
        except (OSError, URLError, ValueError):
            existing = {}
        if existing.get("app") == APP_ID and existing.get("demo") == args.demo:
            print(f"Already running at {url}", flush=True)
            if not args.no_browser:
                webbrowser.open(url)
            return
        raise SystemExit(f"Could not open {url} ({exc}). Use --port with a free port.")
    root = default_root()
    if not args.demo:
        root.mkdir(parents=True, exist_ok=True)
        yf.config.debug.hide_exceptions = False
        yf.set_tz_cache_location(str(root / "yahoo-metadata"))
    server.demo = args.demo
    server.cache = MarketCache(None if args.demo else root / "prices-v1",
                               sample_data if args.demo else fetch_yahoo,
                               spacing=0 if args.demo else 1.5)
    threading.Thread(target=server.cache.work, name="yahoo-worker", daemon=True).start()
    url = f"http://{HOST}:{server.server_port}/"
    print(f"Market Monitor running at {url}\nKeep this window open. Press Ctrl+C to stop.", flush=True)
    if not args.no_browser:
        threading.Timer(0.4, lambda: webbrowser.open(url)).start()
    with server:
        try:
            server.serve_forever()
        except KeyboardInterrupt:
            pass


if __name__ == "__main__":
    main()
