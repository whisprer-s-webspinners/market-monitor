# Market Monitor 1.0.0

## Open it on Windows

1. Right-click the ZIP and select **Extract All**.
2. In the extracted **Market-Monitor** folder, double-click **Start-Market-Monitor.cmd**. The dashboard opens in your default browser.
3. Keep the console window open while you use it. Press **Ctrl+C** there or close the console to stop.

The package includes 64-bit Python 3.14.10 and yfinance 1.8.0. It runs on x64 Windows 10 or 11 with no installer, admin access, API keys, or extra Python setup. Internet access is needed for current Yahoo data. The app is served only on your own computer at **http://127.0.0.1:8769/**. If the browser does not open automatically, paste that address into it.

The first load fills the watchlist gradually. Use **Check for updates** to read the latest local data. The app checks the active 1-minute series at most every 60 seconds, the watchlist and daily history every five minutes, and 1-week intraday history every 15 minutes. Quote timestamps are distinct from fetch timestamps. Yahoo’s exchange delays, closing hours, and rate limits still apply. The dashboard backs off when throttled and retains available history on disk at `%LOCALAPPDATA%\MarketMonitor`. Keep the chart tab visible for automatic refresh.

To try the controls with fictional data, open PowerShell in the extracted folder and run:

```powershell
.\Start-Market-Monitor.cmd --demo
```

Demo opens on port 8770 and has a separate browser snapshot. For a port conflict, use `.\Start-Market-Monitor.cmd --port 8870` in the same folder.

## Read the screen

- **Watchlist** starts with Bitcoin, the S&P 500 cash index and copper futures. It also includes Ethereum, a daily BTC/ETH/SOL/XRP/ADA proxy with equal daily weights, the US Dollar Index, GBP/USD, the FTSE 100, the Nikkei 225, the ACWI global equity ETF, gold futures and silver futures. DXY shows broad dollar strength. GBP/USD tells you how many US dollars one pound buys.
- **Market chart** shows 1H and 1D at one-minute resolution, 1W at 15-minute resolution, and 1M, 6M and YTD as daily bars. The five-coin basket uses daily data. An intraday view ends at the latest observed bar, including when the market is closed. Gaps without observations occupy no candle slots. Hover the chart or focus it and use the arrow keys for values.
- **Candles and averages** show the open, high, low and close for each bar. Mint candles closed at or above their open. Pink candles closed below it. SMA 20 and SMA 50 average the last 20 and 50 closes in the selected bar interval, including available warm-up history before the displayed range.
- **Compare returns** puts up to six assets on a percentage scale from their first shared date. This compares price moves across different units. Values are in the instruments’ quoted currencies, and the comparison excludes dividends and FX conversion. The newest daily bar may still be forming. Missing sessions are not filled with invented prices.
- **Historical return model** shows where the middle and tails of past returns landed after 5 or 20 daily bars, along with a 5-bar walk-forward error comparison against zero change. These are historical scenarios. The shaded band gives no guarantee about future prices. It can be especially misleading when volatility changes or a futures contract rolls.

## Read your Kraken evaluation

Open the Kraken Prop **Portfolio** widget and copy **Equity** and the dollar value shown for **Max Daily Loss limit** into **Evaluation buffer**. Use the Kraken figures whenever you refresh the snapshot. The panel calculates the distance to the daily floor, the Starter plan’s separate `$4,700` total floor, and the `$5,500` equity target. It marks snapshots after five minutes and clears the displayed distances when the 00:30 UTC daily reset passes. No account data is sent to a provider or used to place trades.

At a `$5,000` reset balance the daily floor is `$4,850`. If Kraken shows `$5,020` equity and `$4,850` for today’s floor, the snapshot shows `$170` of daily headroom. Kraken checks live equity, including unrealised P&L and applicable fees. Touching the floor is enough to breach. Both the S&P 500 and copper references in this app can diverge from the prices in Kraken Prop, including when the underlying index or futures market is closed.

**Margin** is collateral. **Notional** is the size of the market exposure. If `$2,500` is BTC notional, a 1% move is roughly `$25` of P&L. If `$2,500` is margin backing a position at 5×, that is `$12,500` notional and a 1% move is roughly `$125` before costs. Check the position size and instrument info in Kraken for the actual exposure. A market can end up higher weeks from now and still cross the daily loss floor on the way.

## References

- [Yahoo Finance coverage and delays](https://help.yahoo.com/kb/finance/article-exchanges-data-delays-sln2310.html)
- [Kraken Prop evaluation rules](https://support.kraken.com/articles/how-kraken-prop-evaluations-work)
- [Kraken’s daily loss floor](https://support.kraken.com/articles/maximum-daily-loss-mdl-explained)
- [Kraken’s total drawdown floor](https://support.kraken.com/articles/maximum-drawdown-mdd-explained)
- [Kraken Prop equity indices](https://support.kraken.com/gb/articles/equity-indices-kraken-prop)
- [Kraken Prop commodities](https://blog.kraken.com/product/prop/commodities-are-now-live-at-half-the-commission)

The application source is `monitor.py` and `web/`. The pinned dependency list and the Windows runtime’s upstream license notices are included.
