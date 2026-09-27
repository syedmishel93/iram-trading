#!/usr/bin/env bash
# Mishel test suite — THE LEGACY TIER.
#
# WHAT THIS RUNS
# The 76 node files below, which test `../index.html`: the frozen v39 terminal.
# Plus a delegation to `verify.py` at the end, which owns everything live.
#
# It used to run both tiers from its own lists, and the reason it no longer
# does is written above that delegation: two manifests of the same build drift,
# and this one had.
#
# TWO THINGS THAT STAY, BOTH LEARNED THE HARD WAY (v39.30)
#   1. PYTHONIOENCODING=utf-8 — a Windows cp1252 console cannot encode the
#      checkmark these tests print, so a file died with UnicodeEncodeError and
#      the old `&&` chain meant NOTHING after it ran. The suite reported
#      nothing and looked fine.
#   2. Run every file and summarise, instead of stopping at the first failure.
#      A runner that hides the other 80 results is not telling you the truth
#      about the build.
cd "$(dirname "$0")" || exit 1
export PYTHONIOENCODING=utf-8

FAILED=""
PASSED=0
run() {  # run <runner> <file>
  if "$1" "$2"; then
    PASSED=$((PASSED + 1))
  else
    FAILED="$FAILED $2"
  fi
}

while read -r runner file; do
  [ -z "$runner" ] && continue
  run "$runner" "$file"
done <<'LIST'
  node test_terminal.js
  node test_frost_visual.js
  node test_robustness_stats.js
  node test_meme_radar.js
  node test_onchain.js
  node test_v146_power.js
  node test_overfit_audit.js
  node test_seasonality.js
  node test_audit_integration.js
  node test_v151_charting.js
  node test_v152_onchain.js
  node test_v153_analytics.js
  node test_v154_aidesk.js
  node test_v161_sources.js
  node test_v162_memepro.js
  node test_v163_newspine.js
  node test_v164_rrg.js
  node test_v171_uifix.js
  node test_v180_massive.js
  node test_v185_scout.js
  node test_v190_visibility.js
  node test_v200_smartdesk.js
  node test_v201_fixes.js
  node test_v210_engine.js
  node test_v220_ui.js
  node test_v221_fixes.js
  node test_v230_dna.js
  node test_v231_solana.js
  node test_v240_verdict.js
  node test_v242_nan.js
  node test_v243_ui.js
  node test_v244_layout.js
  node test_v250_tabbar.js
  node test_v251_gridfix.js
  node test_v252_expand.js
  node test_v254_chart.js
  node test_v260_cockpit.js
  node test_v261_hardening.js
  node test_v262_drawext.js
  node test_v270_space.js
  node test_v280_sig.js
  node test_v290_ui.js
  node test_v300_prochart.js
  node test_v310_intel.js
  node test_v320_workspace.js
  node test_v321_fixpack.js
  node test_v330_master.js
  node test_v340_alpha.js
  node test_v350_ops.js
  node test_v360_mt5.js
  node test_v370_risk.js
  node test_v380_honesty.js
  node test_v380_gate.js
  node test_v231_dashfix.js
  node test_v390_shell.js
  node test_v391_dom.js
  node test_v391_boot.js
  node test_v393_fixes.js
  node test_v395_brain.js
  node test_v397_wiring.js
  node test_v398_sniper.js
  node test_v399_broker.js
  node test_v3910_declutter.js
  node test_v3911_scalp_lab.js
  node test_v3912_livebar.js
  node test_v3918.js
  node test_v3919.js
  node test_v3920.js
  node test_v3921.js
  node test_v3923.js
  node test_v3924.js
  node test_v3925.js
  node test_v3926.js
  node test_v3927.js
  node test_v3928.js
  node test_v3929.js
LIST

# ---------------------------------------------------------------------------
# THE LIVE TIERS — DELEGATED, NOT DUPLICATED.
#
# This runner used to carry its own list of seventeen python3 entries beside
# the node ones, and run app/ typecheck+vitest itself. That made it a SECOND
# manifest of what the build is, and it had already drifted: five python test
# files were missing from it -- test_gateway.py and test_quant_service.py,
# which it never knew about, and test_claims/test_edge/test_rss, which moved
# into tests/ from server/. A list that is wrong is worse than no list,
# because the summary line still says GREEN.
#
# `verify.py` owns the live tiers now: app/ typecheck, vitest, and all
# twenty-two python test files, with a stage that FAILS if a file in tests/
# is in neither of its lists. One place to add a test, one place that checks.
#
# WHAT STAYS HERE, AND WHY IT IS NOT IN THE GATE
# The 76 node files above test `../index.html` -- the frozen v39 terminal (see
# LEGACY.md). Frozen code cannot regress, so running them on every change buys
# nothing and costs a minute. They are kept, and kept runnable, because they
# are the record of what that app does; they are simply not a gate on work that
# cannot touch them. Run this script when you change the legacy terminal.
if [ -f ../verify.py ]; then
  echo
  echo "--- live tiers: verify.py (app typecheck + vitest + 22 python files) ---"
  if python ../verify.py; then
    PASSED=$((PASSED + 1))
  else
    FAILED="$FAILED verify.py"
  fi
else
  echo
  echo "--- live tiers: SKIPPED (verify.py not found) ---"
fi

echo
echo "================================================================"
if [ -n "$FAILED" ]; then
  echo "SUITE RED  —  $PASSED file(s) passed, failures in:"
  for f in $FAILED; do echo "    $f"; done
  echo "================================================================"
  exit 1
fi
echo "SUITE GREEN  —  $PASSED files, 0 failures"
echo "================================================================"
