#!/usr/bin/env python3
"""
test_onchain_pairs.py - THE DEDUP KEY IS THE ONLY RECORD OF WHAT WAS SEEN.

`onchain_seen` stores one opaque string per token -- `np:solana:ADDRESS` -- and
the new screen needs two fields out of it. A split that guesses would put the
chain in the address column on any key shaped differently, and nothing on screen
would look wrong: an address is an opaque string to the reader too.

WHY THIS TABLE IS WORTH A SCREEN AT ALL: the scanner that fills it had never
written a row in its life. It called `log_event()` from inside its own write
transaction, which deadlocked the thread, raised "database is locked" and rolled
back the insert -- 2,069 failures, an empty table. Fixed in v62.14; 36 rows
within an hour.

WHAT IS ASSERTED: the parse REJECTS rather than repairs, and an address
containing a colon keeps its tail.
"""

import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "server"))

from svc.onchain import parse_pair_key

FAILED = []


def check(name, got, want):
    if got == want:
        print("  ok   %s: %r" % (name, got))
    else:
        print("  FAIL %s: got %r, want %r" % (name, got, want))
        FAILED.append(name)


print("A REAL KEY, FROM THE LIVE TABLE")
check("solana", parse_pair_key("np:solana:3xJDaMTH1zPYi28tLKcpkruGBBjcuSCUo71nfE31pump"),
      {"chain": "solana", "address": "3xJDaMTH1zPYi28tLKcpkruGBBjcuSCUo71nfE31pump"})
check("ethereum", parse_pair_key("np:ethereum:0xabc"), {"chain": "ethereum", "address": "0xabc"})

print()
print("AN ADDRESS CONTAINING A COLON KEEPS ITS TAIL")
# `split(":")` would return four parts and drop the last. The address is opaque,
# so a truncated one looks exactly like a real one.
check("colon in address", parse_pair_key("np:cosmos:ibc:27394FB"),
      {"chain": "cosmos", "address": "ibc:27394FB"})

print()
print("AND IT REJECTS RATHER THAN REPAIRS")
check("wrong prefix", parse_pair_key("wf:solana:abc"), None)
check("too few parts", parse_pair_key("np:solana"), None)
check("empty chain", parse_pair_key("np::abc"), None)
check("empty address", parse_pair_key("np:solana:"), None)
check("whitespace address", parse_pair_key("np:solana:   "), None)
check("not a string", parse_pair_key(None), None)
check("a number", parse_pair_key(12), None)
check("empty", parse_pair_key(""), None)

print()
if FAILED:
    print("FAILED: %d" % len(FAILED))
    for f in FAILED:
        print("  - %s" % f)
    sys.exit(1)
print("ALL PASS")
