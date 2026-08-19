#!/usr/bin/env python3
"""
model-bench.py — throughput/latency/cost table for every model pi can reach.

Runs one fixed generation per model through the real pi binary (so whatever
providers, keys and gateways your pi is configured with are what gets measured)
and reports TTFT, output tokens/sec, wall time and cost.

Usage:
    ./scripts/model-bench.py                 # every model in `pi --list-models`
    ./scripts/model-bench.py zai             # only models whose provider/id matches "zai"
    ./scripts/model-bench.py -n 3 zai        # 3 runs per model, report the best tps
    ./scripts/model-bench.py --md out.md     # also write the markdown table to a file

Notes:
  - Costs real tokens: one short generation per model per run.
  - Tools are disabled (`--no-tools`) and the session is ephemeral
    (`--no-session`), so this measures raw generation, not agent behaviour.
  - Models that error (missing key, gateway refusal) are listed with the reason
    rather than silently dropped.
"""

import argparse
import json
import re
import subprocess
import sys
import time

PROMPT = (
    "Write exactly 150 words of plain prose about why deterministic builds matter. "
    "No lists, no headings, no preamble — start with the first word of the prose."
)
TIMEOUT = 180


def list_models():
    out = subprocess.run(["pi", "--list-models"], capture_output=True, text=True, timeout=60).stdout
    models = []
    for line in out.splitlines()[1:]:  # skip header
        parts = re.split(r"\s{2,}", line.strip())
        if len(parts) >= 2 and parts[0] and parts[1]:
            models.append((parts[0], parts[1]))
    return models


def bench_one(provider, model):
    """One generation. Returns dict with ttft/tps/usage or an error string."""
    cmd = [
        "pi", "-p", PROMPT, "--mode", "json",
        "--model", f"{provider}/{model}",
        "--no-tools", "--no-session",
    ]
    t0 = time.monotonic()
    t_first = None
    t_gen_start = None
    t_gen_end = None
    usage = None
    api_error = None
    try:
        proc = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
        for line in proc.stdout:
            line = line.strip()
            if not line:
                continue
            try:
                ev = json.loads(line)
            except Exception:
                continue
            kind = ev.get("type")
            msg = ev.get("message") if isinstance(ev.get("message"), dict) else None
            # pi's json mode has no token-level deltas; the first assistant
            # message_start is the closest honest proxy for "first response".
            if kind == "message_start" and msg and msg.get("role") == "assistant":
                now = time.monotonic()
                t_first = t_first or now
                t_gen_start = now
            if kind == "message_end" and msg and msg.get("role") == "assistant":
                if msg.get("stopReason") == "error":
                    api_error = (msg.get("errorMessage") or "error")[:90]
                    continue
                u = msg.get("usage") or {}
                if u.get("output"):
                    usage = u
                    t_gen_end = time.monotonic()
        proc.wait(timeout=TIMEOUT)
    except subprocess.TimeoutExpired:
        proc.kill()
        return {"error": f"timeout >{TIMEOUT}s"}
    except Exception as e:  # noqa: BLE001
        return {"error": str(e)[:90]}

    if not usage:
        return {"error": api_error or "no output produced"}

    out_tok = usage.get("output", 0) or 0
    window = (t_gen_end - t_gen_start) if (t_gen_start and t_gen_end) else (time.monotonic() - t0)
    return {
        "ttft": (t_first - t0) if t_first else None,
        "wall": time.monotonic() - t0,
        "out": out_tok,
        "tps": (out_tok / window) if window > 0 else 0.0,
        "in": usage.get("input", 0),
        "cacheRead": usage.get("cacheRead", 0),
        "think": usage.get("reasoning", 0) or 0,
        "cost": ((usage.get("cost") or {}).get("total")),
    }


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("pattern", nargs="?", default="", help="substring filter on provider/model")
    ap.add_argument("-n", "--runs", type=int, default=1, help="runs per model (best tps wins)")
    ap.add_argument("--md", help="write the markdown table to this file")
    args = ap.parse_args()

    models = [(p, m) for p, m in list_models() if args.pattern in f"{p}/{m}"]
    if not models:
        sys.exit(f"no models match {args.pattern!r}")
    print(f"benchmarking {len(models)} model(s), {args.runs} run(s) each\n", file=sys.stderr)

    rows = []
    for provider, model in models:
        best = None
        err = None
        for _ in range(args.runs):
            r = bench_one(provider, model)
            if "error" in r:
                err = r["error"]
                continue
            if best is None or r["tps"] > best["tps"]:
                best = r
        label = f"{provider}/{model}"
        if best:
            print(f"  {label:<42} {best['tps']:6.1f} tok/s  ttft {best['ttft'] or 0:.2f}s", file=sys.stderr)
            rows.append((label, best))
        else:
            print(f"  {label:<42} ERR  {err}", file=sys.stderr)
            rows.append((label, {"error": err}))

    ok = sorted([r for r in rows if "error" not in r[1]], key=lambda r: -r[1]["tps"])
    bad = [r for r in rows if "error" in r[1]]

    lines = [
        "| model | tok/s | TTFT | wall | out tok | think tok | cost |",
        "|---|---:|---:|---:|---:|---:|---:|",
    ]
    for label, r in ok:
        cost = f"${r['cost']:.5f}" if r.get("cost") else "—"
        lines.append(
            f"| `{label}` | **{r['tps']:.1f}** | {r['ttft'] or 0:.2f}s | {r['wall']:.1f}s | {r['out']} | {r.get('think', 0)} | {cost} |"
        )
    for label, r in bad:
        lines.append(f"| `{label}` | — | — | — | — | — | {r['error']} |")
    table = "\n".join(lines)
    print("\n" + table)
    if args.md:
        with open(args.md, "w") as fh:
            fh.write(f"# pi model benchmark\n\nprompt: {PROMPT!r}\n\n{table}\n")
        print(f"\nwrote {args.md}", file=sys.stderr)


if __name__ == "__main__":
    main()
