#!/usr/bin/env python3
"""v15.4 service tests — pure helpers + OHLC cache route, run against the SHIPPED mishel_service.py."""
import os
import sys
import tempfile

os.environ["MISHEL_SVC_DB"] = tempfile.mktemp(suffix=".db")
sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "server"))
import importlib.util

spec = importlib.util.spec_from_file_location("svc", os.path.join(os.path.dirname(__file__), "..", "server", "mishel_service.py"))
svc = importlib.util.module_from_spec(spec); spec.loader.exec_module(svc)
svc.init()
P=F=0
def ok(c, m):
    global P, F
    if c: P += 1
    else: F += 1; print("  FAIL:", m)

# big_transfers: known-answer filtering
items = [
  {"token":{"symbol":"PEPE","decimals":18,"exchange_rate":"0.00001"},"total":{"value":str(10**18*2_000_000_000),"decimals":18},
   "tx_hash":"0xa","from":{"hash":"0xW"},"to":{"hash":"0xX"}},              # 2e9 * 1e-5 = $20,000 -> hit
  {"token":{"symbol":"DUST","decimals":18,"exchange_rate":"1"},"total":{"value":str(10**18*5),"decimals":18},
   "tx_hash":"0xb","from":{"hash":"0xW"},"to":{"hash":"0xY"}},              # $5 -> miss
  {"token":{"symbol":"NORATE","decimals":18},"total":{"value":str(10**18),"decimals":18},"tx_hash":"0xc"},  # no rate -> skipped
]
hits = svc.big_transfers(items, 10000)
ok(len(hits)==1 and hits[0]["sym"]=="PEPE", "filters to the $20k PEPE transfer only")
ok(abs(hits[0]["usd"]-20000) < 1, "USD math exact (got %.0f)" % hits[0]["usd"])
ok(svc.big_transfers([], 1)==[], "empty items safe")
ok(svc.big_transfers([{"broken":True}], 1)==[], "malformed item skipped, not guessed")

# new_items dedup
fresh = svc.new_items({"np:base:0xa"}, [{"chainId":"base","tokenAddress":"0xa"},{"chainId":"base","tokenAddress":"0xb"}],
                      lambda p: "np:"+p["chainId"]+":"+p["tokenAddress"])
ok(len(fresh)==1 and fresh[0][0]=="np:base:0xb", "dedup keeps only unseen")

# OHLC cache round-trip via flask test client
app = svc.app.test_client()
bars=[{"t":1000+i*3600,"o":1+i,"h":2+i,"l":0.5+i,"c":1.5+i,"v":100+i} for i in range(10)]
r = app.post("/svc/data/ohlc", json={"sym":"btcusd","tf":"1h","bars":bars})
ok(r.get_json()["stored"]==10, "stored 10 bars")
r = app.get("/svc/data/ohlc?sym=BTCUSD&tf=1h&n=5")
j = r.get_json()
ok(len(j["bars"])==5 and j["bars"][-1]["c"]==10.5, "returns newest 5, ascending, exact close")
r = app.post("/svc/data/ohlc", json={"sym":"BTCUSD","tf":"1h","bars":[{"t":1000,"o":9,"h":9,"l":9,"c":9,"v":9}]})
ok(r.get_json()["stored"]==1, "upsert same key ok")
r = app.get("/svc/data/ohlc?sym=BTCUSD&tf=1h&n=500")
ok(len(r.get_json()["bars"])==10, "PK upsert did not duplicate")
r = app.post("/svc/data/ohlc", json={"tf":"1h","bars":[]})
ok(r.status_code==400, "missing sym rejected")

# onchain watch routes
r = app.post("/svc/onchain/watch", json={"wallet":"0xWHALE000001","chain":"base","min_usd":25000})
ok(r.get_json()["ok"], "watch added")
j = app.get("/svc/onchain/watch").get_json()
ok(len(j)==1 and j[0]["wallet"]=="0xwhale000001" and j[0]["min_usd"]==25000, "watch persisted lowercase w/ threshold")
r = app.delete("/svc/onchain/watch/0xWHALE000001")
ok(app.get("/svc/onchain/watch").get_json()==[], "watch deleted")
ok(r.get_json()["ok"], "delete ok")

print(f"\nv15.4 SERVICE TESTS: {P} passed, {F} failed"); sys.exit(1 if F else 0)
