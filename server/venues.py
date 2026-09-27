"""What each venue calls an instrument. One owner, several readers.

WHY THIS IS A LEAF MODULE

`ddt_data_server.py` needs it to serve `/ohlc`, and `svc/core.py` needs it to
top up the enrolled series in the background. Those two are SIBLINGS — both are
Flask apps the gateway mounts by prefix — and CLAUDE.md's layering rule is that
a mounted app does not reach into another. A copy in each would be two
definitions of what a Binance ticker is, free to drift the first time one of
them learns about a new quote asset.

A leaf both import inverts nothing, which is the same shape as `enginepath.py`.
"""

from __future__ import annotations

#: What Binance quotes AGAINST. Longest first, so "BTCUSDC" matches USDC and not
#: the "USD" inside it — a shorter suffix that is a prefix of a longer one makes
#: every match after it wrong.
BINANCE_QUOTES = ("FDUSD", "USDT", "USDC", "TUSD", "BUSD", "DAI", "BTC", "ETH", "BNB")

#: Bases that end in USD but are FX or metals, not crypto. Small and explicit:
#: guessing from the shape alone would send EURUSD to Binance as EURUSDT, which
#: it DOES list — a wrong answer that returns real bars for a different market,
#: which is worse than a refusal.
NON_CRYPTO_BASES = frozenset(
    {
        "EUR", "GBP", "AUD", "NZD", "CAD", "CHF", "JPY", "CNH", "SEK", "NOK",
        "XAU", "XAG", "XPT", "XPD", "SPX", "NAS", "US30", "US500", "UK100", "GER40",
    }
)


def binance_symbol(sym: str | None) -> str | None:
    """Binance's own ticker for `sym`, or None when Binance does not list it.

    THIS WAS A SEVEN-ENTRY HARDCODED MAP and it refused Binance's OWN NATIVE
    TICKERS. Measured against the running gateway with the archive's own binance
    holdings as the input: BTCUSDT, ETHUSDT, SOLUSDT, FILUSDT and ONDOUSDT were
    all refused with "crypto only (BTCUSD, ETHUSD, ...)", while the canonical
    alias BTCUSD returned real bars. So the proxy could not re-fetch a single one
    of the series it had stored, and the failure read as "this vendor does not
    have that" rather than "this lookup was never made".

    Two forms are accepted, in this order:

      1. ALREADY A BINANCE PAIR — anything ending in a quote asset it lists.
         Binance lists thousands of pairs; a hardcoded list of them is a list
         that is wrong the week it is written.
      2. THE TERMINAL'S CANONICAL `XXXUSD` — `data/history.ts` and the
         instrument table speak USD and the venue speaks USDT. That mapping is
         what the original seven entries were for; it now covers every base
         rather than seven of them.

    Everything else is refused, which is the guard worth keeping.
    """
    s = (sym or "").strip().upper()
    if not s:
        return None
    for q in BINANCE_QUOTES:
        if s.endswith(q) and len(s) > len(q):
            return s
    if s.endswith("USD") and len(s) > 3:
        base = s[:-3]
        if base not in NON_CRYPTO_BASES:
            return base + "USDT"
    return None


#: Canonical timeframe -> Binance's own interval string. Binance names every one
#: of these natively, so unlike yfinance nothing has to be resampled.
BINANCE_INTERVALS = {
    "1m": "1m", "3m": "3m", "5m": "5m", "15m": "15m", "30m": "30m",
    "1h": "1h", "2h": "2h", "4h": "4h", "6h": "6h", "8h": "8h", "12h": "12h",
    "1d": "1d", "1w": "1w", "1M": "1M",
}


def normalise_ms(t: float) -> float:
    """A Binance timestamp in milliseconds, whatever unit it arrived in.

    Binance switched kline `open_time` from milliseconds to MICROSECONDS in its
    2025 archives. CLAUDE.md's rule is to detect that by MAGNITUDE rather than by
    a cutover date: `t > 1e14` is right in every year, and a date comparison is a
    fact that goes stale and that nobody revisits.
    """
    return t / 1000.0 if t > 1e14 else float(t)


#: The suffixes MT5 brokers append to an instrument name.
#:
#: AN EXPLICIT SET, NOT A SHAPE. The first version matched any short trailing
#: `.X` and turned the real ticker `BRK.B` into `BRK` — a wrong answer that
#: looks entirely right and would size a different company. Same reasoning as
#: `NON_CRYPTO_BASES`: guessing from the shape returns a plausible wrong
#: answer, which is worse than leaving an unknown suffix alone.
#:
#: An unrecognised suffix is KEPT. A spec filed under a name nobody looks up is
#: a miss; a spec matched to the wrong instrument is a mis-sized trade.
BROKER_SUFFIXES = frozenset(
    {"S", "M", "C", "I", "A", "Z", "E", "PRO", "RAW", "ECN", "STP", "CASH", "MICRO", "MINI", "SPOT"}
)


def canonical_symbol(sym: str | None) -> str:
    """The instrument's name without the broker's suffix.

    JustMarkets quotes `XAUUSD.s` and `BTCUSD.s`. `/svc/mt5/sync` stored a spec
    under the BROKER's name and `/svc/risk/size` looked it up under the
    canonical one, so every lookup missed and sizing could never work on this
    account — the route answered 200 with `ok: false` and advised running a sync
    that had already run.

    Anything with no suffix comes back unchanged, and a string that is ONLY a
    suffix is not one.
    """
    s = (sym or "").strip().upper()
    if not s:
        return ""
    head, dot, tail = s.rpartition(".")
    # `head` is empty when there was no dot, or when the dot was the first
    # character — and a string that is ONLY a suffix is not one.
    if dot and head and tail in BROKER_SUFFIXES:
        return head
    return s


def spec_keys(sym: str | None) -> list[str]:
    """Every name a contract spec should be filed under, broker's name first.

    THE SYNC KNOWS THE BROKER'S NAME AND THE CALLER KNOWS THE CANONICAL ONE,
    and neither should have to know the other's. Filing under both is the cheap
    fix; teaching every call site to try two spellings is the find-every-consumer
    trap this project records.
    """
    s = (sym or "").strip().upper()
    if not s:
        return []
    c = canonical_symbol(s)
    return [s] if c == s else [s, c]


__all__ = [
    "BINANCE_INTERVALS",
    "BINANCE_QUOTES",
    "BROKER_SUFFIXES",
    "NON_CRYPTO_BASES",
    "binance_symbol",
    "canonical_symbol",
    "normalise_ms",
    "spec_keys",
]
