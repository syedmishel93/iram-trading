#!/usr/bin/env node
/* =====================================================================
   LAB WORKER — one study, one process, then exit.
   ---------------------------------------------------------------------
   WHAT IT IS
   Reads a study job as JSON on stdin, runs the SHIPPED lab over it, and
   writes the result as JSON on stdout. Nothing else: no network, no
   disk, no clock beyond timing itself.

   WHY A PROCESS PER STUDY RATHER THAN A POOL
   A study is CPU-bound for seconds and then done. A pool would need a
   protocol for which worker is busy, a way to notice one wedged inside a
   strategy loop, and a policy for what a leaked global does to the next
   study that lands on it. `spawn, feed, read, exit` has none of those:
   the operating system already knows how to kill a process and reclaim
   everything it touched, and a study that hangs is a `kill` rather than
   a pool slot that never comes back.

   WHY STDIN RATHER THAN ARGV
   Bars are the payload and there are thousands of them. Windows caps a
   command line at 32,767 characters, which a 3,000-bar study passes in
   about a tenth of the way.

   PROTOCOL
     stdin   {"family":"ema","bars":[{t,o,h,l,c,v},...],"opts":{...}}
     stdout  {"ok":true,"result":{family,configs,study,ms}}
             {"ok":false,"error":"..."}            (exit code 1)

   TWO OTHER MODES, AND THE DEFAULT IS UNCHANGED
     {"mode":"ledger", "spec":{...}, "bars":[...], "opts":{horizon,balance,riskPct}}
        -> every setup that rule produced, the sample's own losses named,
           and what the rule did to an account of that size.
     {"mode":"catalogue"}
        -> the shipped rule library, so a caller need not keep a second copy
           of it that can drift.

   A job with no `mode` is a study and is byte-for-byte what it always was.
   `lab.py` and its tests describe that format, and adding a second kind of
   work is not a reason to move the first.

   A malformed job is `ok:false` and exit 1, never a stack trace on
   stdout — the caller parses stdout as JSON and a trace there turns a
   bad input into a parse error two layers away from its cause.
   ===================================================================== */
'use strict';

/* Static relative import, deliberately — see the note in alert_daemon.mjs:
   a dynamic absolute import throws ERR_UNSUPPORTED_ESM_URL_SCHEME on Windows
   because "C:\..." parses as a URL with protocol "c:". */
import { runJob, runLedgerJob, specCatalogue } from './engine/lab-engine.mjs';

function fail(message) {
  process.stdout.write(JSON.stringify({ ok: false, error: String(message) }));
  process.exit(1);
}

async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString('utf8');
}

const raw = await readStdin();
if (!raw.trim()) fail('empty job on stdin');

let job;
try {
  job = JSON.parse(raw);
} catch (err) {
  fail(`job is not valid JSON: ${err.message}`);
}

try {
  const mode = job?.mode ?? 'study';
  let result;
  if (mode === 'ledger') result = runLedgerJob(job);
  else if (mode === 'catalogue') result = { specs: specCatalogue() };
  else if (mode === 'study') result = runJob(job);
  /* An UNKNOWN mode is refused by name rather than falling through to a study.
     Silently running the wrong kind of work would answer a question nobody
     asked, and the caller would have no way to tell. */
  else throw new Error(`unknown mode ${JSON.stringify(mode)} - expected study, ledger or catalogue`);
  process.stdout.write(JSON.stringify({ ok: true, result }));
} catch (err) {
  /* The stack goes to stderr, where the gateway logs it. stdout stays
     machine-readable so the caller never has to guess what it received. */
  process.stderr.write(err?.stack ?? String(err));
  fail(err?.message ?? String(err));
}
