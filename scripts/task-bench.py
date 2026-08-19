#!/usr/bin/env python3
"""task-bench.py — deterministic coding-task price/time dashboard for pi.

Each task starts from a fresh copy of bench/fixture/, applies a task-local setup
script that deliberately makes tests fail, asks a real pi worker to fix it, then
runs a deterministic verifier. Tests are hash-protected: modifying them fails a
run even if verification passes.

Examples:
  ./scripts/task-bench.py --verify-only
  ./scripts/task-bench.py --models github-copilot/gpt-5.4-mini --runs 1
  ./scripts/task-bench.py --models zai/glm-5.3,github-copilot/gpt-5.4-mini --runs 3
  ./scripts/task-bench.py --models github-copilot/gpt-5.4-mini --tasks slug-normalization,record-merge

Results are written to bench/results/<timestamp>.json and latest.md (ignored by
Git). This is intentionally a CLI script, not a pi extension: it needs clean
disposable repos, long model calls, hard process timeouts and shell verification.
"""

import argparse
import hashlib
import json
import os
from pathlib import Path
import shutil
import statistics
import subprocess
import sys
import tempfile
import time
from datetime import datetime, timezone

ROOT = Path(__file__).resolve().parent.parent
FIXTURE = ROOT / "bench" / "fixture"
TASK_ROOT = ROOT / "bench" / "tasks"
RESULTS = ROOT / "bench" / "results"


def digest_tree(root: Path) -> str:
    """Content hash independent of mtime/path traversal order."""
    h = hashlib.sha256()
    for p in sorted(root.rglob("*")):
        # Python test execution creates bytecode caches; they are runtime
        # noise, not test-source edits. Hash every other test asset exactly.
        if p.is_file() and "__pycache__" not in p.parts and p.suffix != ".pyc":
            h.update(str(p.relative_to(root)).encode())
            h.update(b"\0")
            h.update(p.read_bytes())
            h.update(b"\0")
    return h.hexdigest()


def tasks(selected: set[str] | None):
    found = []
    for manifest_path in sorted(TASK_ROOT.glob("*/task.json")):
        task = json.loads(manifest_path.read_text())
        task["dir"] = manifest_path.parent
        if selected is None or task["id"] in selected:
            found.append(task)
    unknown = (selected or set()) - {t["id"] for t in found}
    if unknown:
        raise SystemExit(f"unknown task(s): {', '.join(sorted(unknown))}")
    return found


def setup_worktree(task: dict, keep: bool):
    tmp = Path(tempfile.mkdtemp(prefix=f"pi-task-{task['id']}-"))
    work = tmp / "repo"
    shutil.copytree(FIXTURE, work)
    setup = task["dir"] / task["setup"]
    out = subprocess.run([sys.executable, str(setup)], cwd=work, capture_output=True, text=True)
    if out.returncode:
        shutil.rmtree(tmp, ignore_errors=True)
        raise RuntimeError(f"task setup failed: {out.stderr[-400:]}")
    protected = digest_tree(work / "tests")
    # Ensure the task begins broken; otherwise it cannot measure repair ability.
    initial = subprocess.run(task["verify"], cwd=work, capture_output=True, text=True)
    if initial.returncode == 0:
        shutil.rmtree(tmp, ignore_errors=True)
        raise RuntimeError(f"task {task['id']} setup unexpectedly passes verification")
    return tmp, work, protected


def run_pi(work: Path, model: str, prompt: str, timeout_s: int):
    cmd = ["pi", "-p", prompt, "--mode", "json", "--model", model, "--no-session"]
    t0 = time.monotonic()
    first_assistant = None
    end_assistant = None
    usage = None
    api_error = None
    proc = None
    try:
        proc = subprocess.Popen(cmd, cwd=work, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
        assert proc.stdout is not None
        for line in proc.stdout:
            try:
                ev = json.loads(line)
            except json.JSONDecodeError:
                continue
            msg = ev.get("message") if isinstance(ev.get("message"), dict) else None
            if ev.get("type") == "message_start" and msg and msg.get("role") == "assistant":
                first_assistant = first_assistant or time.monotonic()
            if ev.get("type") == "message_end" and msg and msg.get("role") == "assistant":
                if msg.get("stopReason") == "error":
                    api_error = str(msg.get("errorMessage") or "model error")[:300]
                elif (msg.get("usage") or {}).get("output"):
                    usage = msg["usage"]
                    end_assistant = time.monotonic()
        proc.wait(timeout=timeout_s)
        stderr = (proc.stderr.read() if proc.stderr else "").strip()
    except subprocess.TimeoutExpired:
        if proc:
            proc.kill()
        return {"status": "timeout", "wall_s": round(time.monotonic() - t0, 3), "error": f">{timeout_s}s"}
    except Exception as exc:  # noqa: BLE001
        return {"status": "runner_error", "wall_s": round(time.monotonic() - t0, 3), "error": str(exc)[:300]}

    wall = round(time.monotonic() - t0, 3)
    if not usage:
        return {"status": "agent_error", "wall_s": wall, "error": api_error or stderr[-300:] or f"exit {proc.returncode}"}
    return {
        "status": "agent_ok",
        "wall_s": wall,
        "ttft_s": round((first_assistant - t0) if first_assistant else wall, 3),
        "agent_finish_s": round((end_assistant - t0) if end_assistant else wall, 3),
        "input_tokens": usage.get("input", 0) or 0,
        "output_tokens": usage.get("output", 0) or 0,
        "reasoning_tokens": usage.get("reasoning", 0) or 0,
        "cache_read_tokens": usage.get("cacheRead", 0) or 0,
        "cost": ((usage.get("cost") or {}).get("total")),
    }


def one_run(task: dict, model: str, keep_failures: bool):
    tmp, work, protected_before = setup_worktree(task, keep_failures)
    try:
        result = run_pi(work, model, task["prompt"], task["timeout_seconds"])
        result.update({"task": task["id"], "model": model})
        protected_after = digest_tree(work / "tests")
        result["tests_unchanged"] = protected_before == protected_after
        if result["status"] == "agent_ok" and not result["tests_unchanged"]:
            result["status"] = "tests_modified"
            result["error"] = "tests/ changed during run"
        if result["status"] == "agent_ok":
            verify = subprocess.run(task["verify"], cwd=work, capture_output=True, text=True, timeout=task["timeout_seconds"])
            result["verify_exit"] = verify.returncode
            result["verify_tail"] = (verify.stdout + "\n" + verify.stderr)[-1200:]
            result["status"] = "pass" if verify.returncode == 0 else "verify_fail"
        if result["status"] != "pass" and keep_failures:
            result["worktree"] = str(work)
            tmp = None  # retain for inspection
        return result
    finally:
        if tmp is not None:
            shutil.rmtree(tmp, ignore_errors=True)


def median(values):
    return statistics.median(values) if values else None


def render(results: list[dict], started: str):
    models = sorted({r["model"] for r in results})
    lines = [
        "# pi task benchmark",
        "",
        f"Started: `{started}`",
        "",
        "## Model summary",
        "",
        "| model | passes | runs | pass rate | median time-to-green | median cost-to-green | median TTFT |",
        "|---|---:|---:|---:|---:|---:|---:|",
    ]
    for model in models:
        rs = [r for r in results if r["model"] == model]
        passed = [r for r in rs if r["status"] == "pass"]
        times = [r["wall_s"] for r in passed]
        costs = [r["cost"] for r in passed if r.get("cost") is not None]
        ttfts = [r["ttft_s"] for r in passed if r.get("ttft_s") is not None]
        fmt_cost = f"${median(costs):.5f}" if costs else "—"
        fmt_time = f"{median(times):.1f}s" if times else "—"
        fmt_ttft = f"{median(ttfts):.2f}s" if ttfts else "—"
        lines.append(f"| `{model}` | {len(passed)} | {len(rs)} | {len(passed)/len(rs):.0%} | {fmt_time} | {fmt_cost} | {fmt_ttft} |")

    lines += ["", "## Per-task runs", "", "| task | model | result | wall | cost | detail |", "|---|---|---|---:|---:|---|"]
    for r in results:
        cost = f"${r['cost']:.5f}" if r.get("cost") is not None else "—"
        detail = (r.get("error") or r.get("verify_tail") or "").replace("\n", " ").replace("|", "\\|")[:160]
        lines.append(f"| `{r['task']}` | `{r['model']}` | **{r['status']}** | {r.get('wall_s', 0):.1f}s | {cost} | {detail} |")
    return "\n".join(lines) + "\n"


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--models", help="comma-separated provider/model list; required unless --verify-only")
    ap.add_argument("--tasks", help="comma-separated task ids (default: all)")
    ap.add_argument("--runs", type=int, default=1, help="repetitions per task/model")
    ap.add_argument("--verify-only", action="store_true", help="validate task setup/checkers without calling any model")
    ap.add_argument("--keep-failures", action="store_true", help="retain failed worktrees and print their paths")
    args = ap.parse_args()

    selected = set(args.tasks.split(",")) if args.tasks else None
    suite = tasks(selected)
    if not args.verify_only and not args.models:
        ap.error("--models is required unless --verify-only")
    started = datetime.now(timezone.utc).isoformat(timespec="seconds")

    if args.verify_only:
        for task in suite:
            tmp, _work, _protected = setup_worktree(task, False)
            shutil.rmtree(tmp, ignore_errors=True)
            print(f"PASS setup/checker: {task['id']}")
        print(f"{len(suite)} task(s) have intentionally failing initial checks.")
        return

    models = [m.strip() for m in args.models.split(",") if m.strip()]
    results = []
    total = len(suite) * len(models) * args.runs
    index = 0
    for model in models:
        for task in suite:
            for run in range(1, args.runs + 1):
                index += 1
                print(f"[{index}/{total}] {model} × {task['id']} run {run}/{args.runs}", file=sys.stderr)
                r = one_run(task, model, args.keep_failures)
                results.append(r)
                print(f"  → {r['status']} ({r.get('wall_s', 0):.1f}s)", file=sys.stderr)

    RESULTS.mkdir(parents=True, exist_ok=True)
    stamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    payload = {"started": started, "runs": args.runs, "results": results}
    json_path = RESULTS / f"{stamp}.json"
    md_path = RESULTS / f"{stamp}.md"
    json_path.write_text(json.dumps(payload, indent=2) + "\n")
    report = render(results, started)
    md_path.write_text(report)
    (RESULTS / "latest.md").write_text(report)
    print("\n" + report)
    print(f"Saved {json_path} and {md_path}", file=sys.stderr)


if __name__ == "__main__":
    main()
