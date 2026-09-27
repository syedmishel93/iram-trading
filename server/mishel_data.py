#!/usr/bin/env python3
"""D1-D7 free data collectors -> M1 feature store (SQLite 'features' table).
Honesty contract: a failed source stores NOTHING (never a stale/fake value);
every row carries source + timestamp; FRED needs a free key (env FRED_API_KEY) and is
skipped with a logged notice when absent; the calendar feed (D7) is best-effort by nature."""
import re
import time
import xml.etree.ElementTree as ET

import requests

UA = {"User-Agent": "MishelIntelligence/1.0"}

def _get(url, timeout=10, as_json=True):
    r = requests.get(url, headers=UA, timeout=timeout); r.raise_for_status()
    return r.json() if as_json else r.text

def parse_rss(xml_text, limit=15):
    """D1/D7 — stdlib RSS/Atom title+time parser."""
    out = []
    try:
        root = ET.fromstring(xml_text.encode() if isinstance(xml_text, str) else xml_text)
        for item in root.iter():
            if item.tag.endswith("item") or item.tag.endswith("entry"):
                t = item.find("title") or next((c for c in item if c.tag.endswith("title")), None)
                if t is not None and t.text: out.append(t.text.strip()[:220])
            if len(out) >= limit: break
    except Exception: pass
    return out

RSS_FEEDS = {  # D1 + D7
    "cointelegraph": "https://cointelegraph.com/rss",
    "coindesk": "https://www.coindesk.com/arc/outboundfeeds/rss/",
    "forexlive": "https://www.forexlive.com/feed/news",
    "investing": "https://www.investing.com/rss/news.rss",
    # `forexfactory_cal` REMOVED (v62.15). It pointed at
    # https://www.forexfactory.com/rss.php, which has returned 404 for 225
    # consecutive runs, and it was a SECOND path to a fact that already has an
    # owner: the calendar block below reads ForexFactory's own JSON feed at
    # nfs.faireconomy.media and stores the whole event, 82 of them on the live
    # probe. One fact, one owner — a duplicate source that 404s is not a backup,
    # it is a job that fails forever and tells nobody.
}
SYM_TAGS = {"BTC": "BTCUSD", "BITCOIN": "BTCUSD", "ETH": "ETHUSD", "GOLD": "XAUUSD",
            "XAU": "XAUUSD", "FED": "MACRO", "CPI": "MACRO", "DOLLAR": "DXY", "EUR": "EURUSD"}

def collect(store, log, fresh=None):
    """store(source,key,value_float_or_json_str) ; log(kind,msg). Each source isolated.

    `fresh(source, key, max_age_s)` -> True when the stored copy is recent
    enough to skip. Optional and defaulting to "always fetch", so every existing
    caller and test keeps working unchanged; only the legs that pull a slow-
    moving resource ask.
    """
    def _fresh(source, key, max_age_s):
        return bool(fresh(source, key, max_age_s)) if fresh else False
    now = time.time()
    # D1/D7 news
    for name, url in RSS_FEEDS.items():
        try:
            titles = parse_rss(_get(url, as_json=False))
            if titles:
                tags = sorted({v for t in titles for k, v in SYM_TAGS.items() if k in t.upper()})
                store(name, "headlines", {"n": len(titles), "tags": tags, "titles": titles[:8]})  # v39.5 X2: raw — this one was double-encoded since D1 shipped
        except Exception as e: log("data_" + name, str(e))
    # D2 FRED
    import os
    fk = os.environ.get("FRED_API_KEY", "")
    if fk:
        for sid, key in (("DGS10", "us10y"), ("DGS2", "us2y"), ("CPIAUCSL", "cpi"), ("DFF", "fedfunds")):
            try:
                j = _get(f"https://api.stlouisfed.org/fred/series/observations?series_id={sid}"
                         f"&api_key={fk}&file_type=json&sort_order=desc&limit=1")
                v = j["observations"][0]["value"]
                if v not in (".", ""): store("fred", key, float(v))
            except Exception as e: log("data_fred_" + key, str(e))
    else:
        log("data_fred", "skipped: set FRED_API_KEY (free at fred.stlouisfed.org) for real macro legs")
    # D3 funding + open interest (keyless)
    for sym in ("BTCUSDT", "ETHUSDT"):
        try:
            j = _get(f"https://fapi.binance.com/fapi/v1/premiumIndex?symbol={sym}")
            store("binance_funding", sym, float(j["lastFundingRate"]))
        except Exception as e: log("data_funding", str(e))
        try:
            j = _get(f"https://fapi.binance.com/futures/data/openInterestHist?symbol={sym}&period=1h&limit=1")
            if j: store("binance_oi", sym, float(j[-1]["sumOpenInterestValue"]))
        except Exception as e: log("data_oi", str(e))
    # D4 fear & greed
    try:
        j = _get("https://api.alternative.me/fng/?limit=1")
        store("feargreed", "index", float(j["data"][0]["value"]))
    except Exception as e: log("data_fng", str(e))
    # D5 coingecko category flows + global
    try:
        j = _get("https://api.coingecko.com/api/v3/global")
        d = j["data"]
        store("coingecko", "btc_dominance", float(d["market_cap_percentage"]["btc"]))
        store("coingecko", "mcap_change_24h", float(d["market_cap_change_percentage_24h_usd"]))
    except Exception as e: log("data_cg", str(e))
    # D6 ECB reference rates (feed-integrity cross-check)
    try:
        x = _get("https://www.ecb.europa.eu/stats/eurofxref/eurofxref-daily.xml", as_json=False)
        for m in re.finditer(r"currency='(USD|JPY|GBP)'\s+rate='([\d.]+)'", x.replace('"', "'")):
            store("ecb", "eur" + m.group(1).lower(), float(m.group(2)))
    except Exception as e: log("data_ecb", str(e))

    # ================= v39.3 MACRO DESK LEGS (D8-D15) =================
    # THE CONTRACT, unchanged: each leg isolated in its own try; a failure is
    # LOGGED and the driver renders "-" in the terminal. Nothing is ever
    # interpolated, backfilled, or guessed. Tier labels (LIVE / DAILY-FREE /
    # WEEKLY-OFFICIAL / SCRAPE-FRAGILE / MODEL) are attached client-side; the
    # server stores raw observations + their source, nothing else.

    # D8 stablecoin float (DeFiLlama, keyless) - sidelined purchasing power
    try:
        j = _get("https://stablecoins.llama.fi/stablecoins?includePrices=false")
        tot = 0.0
        for a in j.get("peggedAssets", []):
            c = a.get("circulating") or {}
            tot += float(c.get("peggedUSD") or 0)
        if tot > 0: store("llama", "stablecoin_usd", tot)
    except Exception as e: log("data_stables", str(e))

    # D9 MVRV (CoinMetrics community, keyless, daily) - market vs realized cap.
    # Z-score needs history; we store the RATIO each cycle and let the client
    # z-score it against the accumulated feature-store series (D9 is honest:
    # the z stabilises only as history accumulates, and says so).
    try:
        j = _get("https://community-api.coinmetrics.io/v4/timeseries/asset-metrics"
                 "?assets=btc&metrics=CapMVRVCur&frequency=1d&page_size=1&sort=time")
        # TWO COMPOUNDING FAULTS, FOUND BY CALLING IT (v62.15). This had asked
        # for `order=desc`, which the API no longer accepts -- 400
        # "Unsupported parameter 'order'", 225 runs in a row. Removing it
        # revealed the second: `CapRealUSD` is 403 on the community tier now,
        # so the market-cap-over-realised-cap division could not be done at all.
        # `CapMVRVCur` IS that ratio and is still served, so the same number
        # comes back as one metric instead of two -- and one metric is one thing
        # that can be revoked. Verified live: 1.5773 at 2026-09-24.
        r = j["data"][0]
        mvrv = float(r["CapMVRVCur"])
        if mvrv > 0: store("coinmetrics", "btc_mvrv", mvrv)
    except Exception as e: log("data_mvrv", str(e))

    # D10 hashrate + difficulty (blockchain.info, keyless) - the miner leg.
    # Stored raw; the hash-ribbon (30d vs 60d trend) is computed client-side
    # from the accumulated series. No "cost floor $" is ever printed - a miner
    # cost MODEL without electricity-price data is a guess wearing a suit.
    try:
        hr = float(_get("https://blockchain.info/q/hashrate", as_json=False))
        store("btcchain", "hashrate_ghs", hr)
    except Exception as e: log("data_hashrate", str(e))
    try:
        df = float(_get("https://blockchain.info/q/getdifficulty", as_json=False))
        store("btcchain", "difficulty", df)
    except Exception as e: log("data_difficulty", str(e))

    # D11 FRED macro extension (same key, same loop discipline as D2):
    #   DFII10  = 10Y TIPS real yield        (gold's core driver, BTC headwind)
    #   T10YIE  = 10Y breakeven inflation    (the OTHER half of real yields -
    #             breakevens moving alone is the early signal)
    #   M2SL    = US M2                      (the liquidity sponge's tide)
    #   GFDEBTN = federal debt               (the debt-premium proxy leg)
    if fk:
        for sid, key in (("DFII10", "real10y"), ("T10YIE", "breakeven10y"),
                         ("M2SL", "m2"), ("GFDEBTN", "fed_debt")):
            try:
                j = _get(f"https://api.stlouisfed.org/fred/series/observations?series_id={sid}"
                         f"&api_key={fk}&file_type=json&sort_order=desc&limit=1")
                v = j["observations"][0]["value"]
                if v not in (".", ""): store("fred", key, float(v))
            except Exception as e: log("data_fred_" + key, str(e))

    # D12 spot-ETF net flow (Farside, SCRAPE - fragile by nature and labeled so
    # in the terminal; when the page shape changes this logs and goes blank)
    try:
        h = None
        # v39.7 A8: two page shapes tried in order; the error log records which
        # failed so the terminal's "why blank" tooltip cites the real reason.
        for _u in ("https://farside.co.uk/btc/", "https://farside.co.uk/bitcoin-etf-flow-all-data/"):
            try:
                h = _get(_u, as_json=False)
                if h and "Total" in h: break
            except Exception as _e:
                log("data_etfflow", f"{_u.split('/')[-2] or 'btc'}: {_e}")
        if not h: raise RuntimeError("all Farside page shapes failed")
        m = re.search(r"Total[^<]*</t[dh]>\s*<t[dh][^>]*>\s*\(?(-?[\d,.]+)\)?", h)
        if m:
            v = float(m.group(1).replace(",", ""))
            if "(" in h[m.start():m.end()]: v = -abs(v)
            store("farside", "btc_etf_flow_musd", v)
    except Exception as e: log("data_etfflow", str(e))

    # D13 COT managed-money net gold (CFTC public API, keyless, weekly)
    try:
        j = _get("https://publicreporting.cftc.gov/resource/6dca-aqww.json"
                 "?$where=starts_with(market_and_exchange_names,'GOLD')"
                 "&$order=report_date_as_yyyy_mm_dd%20DESC&$limit=1")
        if j:
            r = j[0]
            net = float(r.get("m_money_positions_long_all", 0)) - float(r.get("m_money_positions_short_all", 0))
            store("cftc", "gold_mm_net", net)
            store("cftc", "gold_cot_date", r.get("report_date_as_yyyy_mm_dd", ""))  # v39.5 X2: raw
    except Exception as e: log("data_cot", str(e))

    # D14 econ calendar - next high-impact USD events (ForexFactory weekly JSON
    # mirror; SCRAPE tier). Half the macro legs above MOVE on these releases.
    # A WEEK'S CALENDAR DOES NOT CHANGE HOURLY.
    #
    # MEASURED: 42 `data_calendar` rate-limit failures — 429 from a vendor
    # throttling a loop that asks every hour, and again the moment the service
    # restarts. Probed directly the same feed answers 200 with 82 events, so
    # nothing was broken except the asking. Six hours still refreshes a weekly
    # file several times over, and the stored copy is what every reader uses in
    # between; a failed fetch never removed it.
    try:
        # THE SKIP GOES INSIDE THE TRY, not before it.
        #
        # My first version put an early `return now` above this block, and
        # `test_data_v393.py` caught it: "D8-D14 each open with their own try
        # (one dead feed never kills the rest)". That structure is the reason a
        # single failing vendor does not take the other six legs down with it,
        # and an early return out of the middle of `collect` is exactly the
        # shape that erodes it. The guard belongs where it cannot change the
        # control flow of anything else.
        if not _fresh("calendar", "week", 6 * 3600):
            j = _get("https://nfs.faireconomy.media/ff_calendar_thisweek.json")

            # v45: keep the WHOLE event. This block used to fetch all of this and
            # throw it away - USD only, high only, top ten, title cut to 48 chars,
            # forecast and previous dropped entirely. Measured on the live feed:
            # 112 events over 10 currencies, 15 of them high impact, 78 carrying a
            # forecast. The terminal surfaced 10 titles out of that.
            def row(e):
                return {"t": e.get("date", ""), "n": e.get("title", ""),
                        "c": e.get("country", ""), "i": str(e.get("impact", "")).lower(),
                        "f": e.get("forecast", ""), "p": e.get("previous", "")}
            med = [e for e in j if str(e.get("impact", "")).lower() in ("high", "medium")]
            store("calendar", "week", [row(e) for e in med])

            # The old thin key stays, unchanged in shape. The terminal cross-checks
            # the live feed against it, and anything else reading it (the alert
            # daemon, older snapshots) keeps working.
            hi = [e for e in j if str(e.get("impact", "")).lower() == "high"
                  and e.get("country") in ("USD", "US")]
            store("calendar", "high_usd",
                [{"t": e.get("date", ""), "n": e.get("title", "")[:48]} for e in hi[:10]])  # RAW - store() serializes
    except Exception as e: log("data_calendar", str(e))

    return now
