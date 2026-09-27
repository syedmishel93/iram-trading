#!/usr/bin/env python3
"""S6 — golden tests for the analytics core. Run: python3 tests/test_analytics.py"""
import os
import sys

import numpy as np

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "server"))
import mishel_ml as M


def test_no_leakage():
    n=600; c=np.cumsum(np.random.RandomState(1).randn(n))+100
    X,y,_=M.build_features(c,c+1,c-1,np.ones(n),horizon=24)
    assert len(X)==len(y) and len(X)<n-24, "label rows must exclude unknown-future tail"
    print("  leakage guard: label tail excluded ✓")

def test_learnable_signal():
    # planted signal: price rises after high-momentum bars -> model must beat 55% OOS
    rs=np.random.RandomState(3); n=1200; c=[100.0]
    for i in range(1,n):
        drift=0.4 if (i>24 and c[-1]/c[-24]-1>0.01) else -0.05
        c.append(c[-1]*(1+ (drift+rs.randn()*0.3)/100))
    c=np.array(c)
    r=M.walk_forward(c,c*1.001,c*0.999,np.ones(n),horizon=24)
    assert r["ok"] and 0<=r["p_up"]<=1
    assert r["acc"]>0.55, f"planted signal not learned (acc={r['acc']:.2f})"
    print(f"  planted-signal learning: OOS acc {r['acc']:.2f} ✓ · p_up bounded ✓ · Brier {r['brier']:.3f}")

def test_random_walk_honesty():
    rs=np.random.RandomState(7); n=1000
    c=100*np.exp(np.cumsum(rs.randn(n))*0.002)
    r=M.walk_forward(c,c*1.001,c*0.999,np.ones(n),horizon=24)
    assert abs(r["acc"]-0.5)<0.12, f"model claims edge on pure noise (acc={r['acc']:.2f})"
    print(f"  random-walk honesty: acc {r['acc']:.2f} ≈ coin flip ✓ (no fake edge)")

def test_insufficient_history():
    try: M.build_features([1]*100,[1]*100,[1]*100,[1]*100); assert False
    except ValueError: print("  insufficient-history refusal ✓")

if __name__=="__main__":
    for t in (test_no_leakage,test_learnable_signal,test_random_walk_honesty,test_insufficient_history): t()
    print("ANALYTICS TESTS PASS ✓")
