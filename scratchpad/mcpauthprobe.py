"""Drive svc/mcpauth.discover() against the two REAL servers that need sign-in.

DISCOVERY ONLY. `_client()` would POST to a registration endpoint and create a
record on somebody else's service, and the operator pressing Connect is what
authorises that. Everything below is a GET.
"""

import os
import sys
import tempfile

os.environ["MISHEL_SVC_DB"] = os.path.join(tempfile.mkdtemp(), "scratch.db")
sys.path.insert(0, os.path.join(os.environ["IRAM_ROOT"], "server"))

from svc import mcp, mcpauth  # noqa: E402

TARGETS = [
    ("TradingView", "https://mcp.tradingview.com/mcp"),
    ("LunarCrush", "https://lunarcrush.ai/mcp"),
    ("Crypto.com (needs no sign-in)", "https://mcp.crypto.com/market-data/mcp"),
]

print("redirect registered:", mcpauth.REDIRECT)
print()

for name, url in TARGETS:
    # The realistic route: the transport 401s and hands back the hint.
    shake = mcp.handshake(url)
    hint = shake.get("resourceMetadata") if not shake.get("ok") else None
    print("=" * 72)
    print(name)
    print("  handshake:", "ok" if shake.get("ok") else shake["why"][:60])
    print("  hint from 401:", hint)

    got = mcpauth.discover(url, hint)
    if not got.get("ok"):
        print("  discover -> REFUSED:", got["why"])
        continue
    print("  issuer      ", got["issuer"])
    print("  authorize   ", got["authorize"])
    print("  token       ", got["token"])
    print("  register    ", got["register"])
    print("  scopes      ", got["scopes"])
    print("  resource    ", got["resource"])
    print("  -> dynamic registration available:", bool(got["register"]),
          "(so there is no client id for the operator to obtain)")
