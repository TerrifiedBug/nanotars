---
name: stocks
description: Look up stock prices, financials, and market data. Use whenever someone asks about stock prices, tickers, market cap, P/E ratios, or company financials.
allowed-tools: Bash(curl:*)
---

# Stock Lookup (Yahoo Finance)

Use curl to query Yahoo Finance. No API key needed.

## Quick Quote (price, change, volume)

```bash
curl -s "https://query1.finance.yahoo.com/v8/finance/chart/AAPL?interval=1d&range=5d" \
  -H "User-Agent: Mozilla/5.0" | jq '{
    symbol: .chart.result[0].meta.symbol,
    currency: .chart.result[0].meta.currency,
    price: .chart.result[0].meta.regularMarketPrice,
    previousClose: .chart.result[0].meta.chartPreviousClose,
    volume: .chart.result[0].meta.regularMarketVolume,
    exchange: .chart.result[0].meta.exchangeName
  }'
```

Replace `AAPL` with any ticker symbol (e.g., `MSFT`, `TSLA`, `GOOG`, `AMZN`).

## Detailed Financials (P/E, EPS, dividend, 52-week range)

```bash
curl -s "https://query1.finance.yahoo.com/v8/finance/chart/AAPL?interval=1d&range=1y" \
  -H "User-Agent: Mozilla/5.0" | jq '{
    symbol: .chart.result[0].meta.symbol,
    currency: .chart.result[0].meta.currency,
    price: .chart.result[0].meta.regularMarketPrice,
    previousClose: .chart.result[0].meta.chartPreviousClose,
    fiftyTwoWeekHigh: .chart.result[0].meta.fiftyTwoWeekHigh,
    fiftyTwoWeekLow: .chart.result[0].meta.fiftyTwoWeekLow,
    volume: .chart.result[0].meta.regularMarketVolume,
    exchange: .chart.result[0].meta.exchangeName
  }'
```

## Multiple Tickers

Query several stocks at once by making parallel curl calls:

```bash
for sym in AAPL MSFT GOOG TSLA; do
  curl -s "https://query1.finance.yahoo.com/v8/finance/chart/$sym?interval=1d&range=5d" \
    -H "User-Agent: Mozilla/5.0" | jq "{
      symbol: .chart.result[0].meta.symbol,
      price: .chart.result[0].meta.regularMarketPrice,
      previousClose: .chart.result[0].meta.chartPreviousClose
    }"
done
```

## Historical Prices

Use `range` and `interval` parameters:

| Range | Interval | Use case |
|-------|----------|----------|
| `1d`  | `5m`     | Intraday |
| `5d`  | `15m`    | Week view |
| `1mo` | `1d`     | Monthly |
| `1y`  | `1wk`    | Yearly |
| `5y`  | `1mo`    | Long-term |

```bash
curl -s "https://query1.finance.yahoo.com/v8/finance/chart/AAPL?interval=1wk&range=1y" \
  -H "User-Agent: Mozilla/5.0" | jq '[.chart.result[0].timestamp as $ts | .chart.result[0].indicators.quote[0] | to_entries[0].value | to_entries | .[] | {i: .key, v: .value}] | length'
```

## Tips

- Always include `-H "User-Agent: Mozilla/5.0"` — requests without it may be blocked
- Ticker symbols are case-insensitive but uppercase is conventional
- For UK stocks use `.L` suffix (e.g., `VOD.L`), for other exchanges see Yahoo Finance ticker format
- If a request fails, retry once — Yahoo occasionally rate-limits
- Present prices with the correct currency symbol based on the `currency` field
- Calculate price change as: `price - previousClose` and percentage as `(change / previousClose) * 100`
- When presenting to users, format nicely: round to 2 decimal places, include +/- sign for changes, use green/red language for up/down
