# Antifragile Quant Engine

A screening and position-sizing tool for Indian listed equities, built on Sajal Kapoor's *Antifragile Thinking* framework, with Taleb, Mauboussin, Thiel, Greene and a Simons-style signal test.

**Live:** https://nayakvignesh113-bot.github.io/Antifragile-quant-engine/

## What it does

1. **Via negativa first.** It removes anything that can cause ruin before scoring upside:
   - company debt beyond the sector's trough tolerance;
   - owner debt (pledge) beyond the sector's sensitivity;
   - chronic negative operating cash flow, serial dilution, audit and governance flags;
   - his science/tech valuation cut-offs;
   - a rich valuation on a fragile business.
2. **System–Valuation map.** Business quality (resilience, trajectory, moat, management) is plotted against valuation, with 3-year arrows showing direction of travel.
3. **Net margin of safety.** It's the minimum of business resilience, management and valuation cheapness, so one weak leg sinks it.
4. **Capital-lag stage.** It separates passing pain (low ROCE with plants still being built) from value destruction, and flags cyclical peaks.
5. **Quarterly hurdle, crowding (six signs), scale test (10× in 10 years).**
6. **Regret profile.** "Not owning enough" means staged buying and wider tolerance. "Overpaying" means an undemanding entry and a hard stop.
7. **Kill switch for held stocks.** Price means investigate, time means reassess, thesis means exit.
8. **Barbell sizing.** Safe / core / convex, with sector caps.
9. **Signal Lab.** Price signals get weight only if they pass in-sample and out-of-sample rank-IC tests.

## Data

Type NSE symbols and press **Fetch**:

| Source | What |
|---|---|
| Screener.in public pages | 12 yrs P&L, balance sheet, cash flow, ratios, 13 quarters, shareholding, cost and cash breakdown |
| BSE filings | promoter pledge/encumbrance, industry, filed quarterly results (used to verify Screener, standalone basis) |
| Yahoo Finance | 10 yrs monthly prices (past P/S, drawdown, Signal Lab) |

- If a source changes its layout or blocks the request, a red banner names the stock, the source and the exact item that couldn't be read.
- Other ways to load data: Screener **Export to Excel** files, or a CSV (template on the Data tab).

### Access token

- **On GitHub Pages:** the page calls a Supabase edge function. It needs the access token, which you enter once per browser and which is stored only there. Only its SHA-256 hash is stored server-side. Fetches are capped at 300 per hour.
- **On claude.ai** (the artifact version): it uses your Supabase connector instead. Claude can also draft the qualitative scores there, each with a reason, for you to accept.

### Backend

- `supabase/schema.sql`: fetching, 12-hour cache, parsing, token check.
- `supabase/functions/afqe/index.ts`: the HTTP endpoint (deploy with `verify_jwt = false`).

## Caveats

- **Unofficial scraping.** Fetching from Screener and Yahoo may breach their terms. It's for personal, low-volume use.
- **The numbers are a translation.** His frameworks are qualitative. The numeric thresholds here are a translation and are all editable in Settings.
- **Only price signals are backtested.** The business scores are snapshots.
- **Not investment advice.** Don't clone anyone's portfolio, his included.
