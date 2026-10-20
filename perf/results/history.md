# Performance history

Raw numbers of every load-test step, copied from the k6 console output of the runs. The per-run JSON files in this
folder (`<scenario>.json`) are overwritten by each run, so they only contain the **final** configuration; this file keeps
the earlier steps so that the improvements in the README can be traced.

- **Machine:** Windows laptop, Docker Desktop (8 CPUs, 3.7 GB). Service, PostgreSQL and k6 on the same machine.
- **Tool:** k6 (`grafana/k6:latest`) via `docker compose --profile perf run --rm k6 run -e SCENARIO=… /perf/load.js`
- **Load:** 50 virtual users unless a step says otherwise. Every run ended with `VERIFY OK` (no limit exceeded, account
  total = sum of its users) and `accepted_units` equal to the server's total, unless stated.
- **req/s** below = iterations ÷ test duration (30 s unless stated). Run-to-run variation on this machine is about ±20 %.
- Latencies are `http_req_duration` of `POST /v1/consume`.

## Step 0: first working version

1 process (pool 20), logging on, 17 queries per request, 50 VUs, 30 s.

| Scenario | Iterations | req/s | p50 | p90 | p95 | p99 | max | Check |
|---|---:|---:|---:|---:|---:|---:|---:|---|
| hot_account | 1,466 | ~49 | 924 ms | 1.44 s | 1.65 s | 2.08 s | 2.8 s | server total 1,466 = accepted 1,466 |
| distributed | 2,249 | ~75 | 630 ms | 771 ms | 840 ms | 961 ms | 1.34 s | 2,249 = 2,249 |
| hot_user | 1,900 | ~63 | 814 ms | 913 ms | 945 ms | 1.04 s | 1.05 s | 1,900 = 1,900 |
| limit_account | 5,000 (85.8 s) | ~58 | 831 ms | 1.06 s | 1.18 s | 1.43 s | 1.63 s | **exactly 1,000** accepted, 4,000 rejected |
| retry_storm | 5,000 (20.7 s) | ~242 | 171 ms | 266 ms | 326 ms | 746 ms | 2.69 s | **exactly 200** counted, 4,800 replays |
| limit_user | – | – | – | – | – | – | – | not run: a bug in the test script (`maxPerRequest` 100 above the monthly limit 80); fixed afterwards |

## Step 1: does it scale with concurrency? (diagnosis)

Same version as step 0, scenario `distributed`, 15 s.

| Virtual users | Iterations | p50 | p95 |
|---:|---:|---:|---:|
| 1 | 953 | 10.8 ms | 21.3 ms |
| 10 | 1,196 | 105 ms | 172 ms |
| 50 | 1,312 | 534 ms | 725 ms |

Throughput stayed at about 60 req/s from 1 to 50 users while latency grew: a serial resource. `docker stats` during
the 50-user run:

| Container | CPU (two samples) |
|---|---|
| service (Node) | 80 %, 98 % |
| db (PostgreSQL) | 113 %, 73 % |
| k6 | 14 %, 13 % |

Conclusion: the Node process was at about one full core: **CPU-bound**, not waiting on locks.

## Step 2: fewer queries per request (17 → 13)

`distributed`, 10 VUs, 15 s, logging on.

| Version | Iterations | p50 | p95 |
|---|---:|---:|---:|
| step 0 (17 queries) | 1,196 | 105 ms | 172 ms |
| step 2 (13 queries) | 2,322 | 57 ms | 94 ms |

## Step 3: logging and durability experiments

Same load as step 2 (`distributed`, 10 VUs, 15 s), one change at a time:

| Change | Iterations | p50 | p95 | Decision |
|---|---:|---:|---:|---|
| none (logging on) | 2,322 | 57 ms | 94 ms | – |
| `LOG_LEVEL=silent` | 3,824 | 34 ms | 64 ms | **kept** (option, off by default) |
| `synchronous_commit=off` (logging on) | 2,821 | 48 ms | 75 ms | **rejected**: only +21 % and can lose accepted decisions after a crash |

## Step 4: 50 VUs after steps 2 and 3 (1 process, `LOG_LEVEL=silent`, 15 s)

| Scenario | Iterations | p50 | p95 | p99 | service CPU | db CPU |
|---|---:|---:|---:|---:|---|---|
| distributed | 3,978 | 172 ms | 259 ms | 313 ms | 129 %, 96 % | 65 %, 91 % |
| hot_account | 2,547 | 195 ms | 763 ms | 1.2 s | 67 %, 45 %, 50 % | ~60 % |

`distributed` is still CPU-bound on Node (more than one full core). `hot_account` is **not**: the CPU is half idle, and
throughput is limited by the lock on the shared account counter.

## Step 5: first run with 4 processes (also account counter locked last)

50 VUs, `LOG_LEVEL=silent`, 15 s.

| Scenario | Iterations | p50 | p95 | p99 |
|---|---:|---:|---:|---:|
| distributed, 4 workers | 4,743 | 130 ms | 300 ms | 412 ms |
| distributed, 1 worker (pool 10) | 3,048 | 235 ms | 312 ms | 378 ms |
| hot_account, 4 workers | 2,203 | 204 ms | 1.1 s | 2.0 s |

A single run per setting was too noisy to decide, so step 6 repeats it with 3 runs each.

## Step 6: controlled comparison, 1 vs 4 processes

50 VUs, `LOG_LEVEL=silent`, 20 s per run, one short warm-up run discarded, 3 runs per setting.

| Workers | Scenario | Run | Iterations | req/s | p50 | p95 | p99 |
|---:|---|---:|---:|---:|---:|---:|---:|
| 1 | distributed | 1 | 3,751 | 188 | 249 ms | 383 ms | 437 ms |
| 1 | distributed | 2 | 4,499 | 225 | 218 ms | 264 ms | 297 ms |
| 1 | distributed | 3 | 4,517 | 226 | 194 ms | 336 ms | 643 ms |
| 4 | distributed | 1 | 7,958 | 398 | 115 ms | 195 ms | 264 ms |
| 4 | distributed | 2 | 8,137 | 407 | 112 ms | 199 ms | 259 ms |
| 4 | distributed | 3 | 8,615 | 431 | 107 ms | 184 ms | 234 ms |
| 1 | hot_account | 1 | 3,076 | 154 | 277 ms | 514 ms | 1.72 s |
| 1 | hot_account | 2 | 3,045 | 152 | 276 ms | 511 ms | 1.52 s |
| 1 | hot_account | 3 | 3,308 | 165 | 271 ms | 484 ms | 637 ms |
| 4 | hot_account | 1 | 3,355 | 168 | 216 ms | 846 ms | 1.34 s |
| 4 | hot_account | 2 | 3,335 | 167 | 219 ms | 804 ms | 1.17 s |
| 4 | hot_account | 3 | 3,045 | 152 | 224 ms | 936 ms | 1.51 s |

Medians: `distributed` **225 → 407 req/s (1.8×)**; `hot_account` **154 → 167 req/s** (no real change; its p95 gets
worse, about 500 → 860 ms, because more requests wait on the same row). Every run ended with `VERIFY OK`.

## Step 7: final configuration

4 workers (pool 10 each), `LOG_LEVEL=silent`, 50 VUs, 30 s. All six scenarios, all `VERIFY OK`.

| Scenario | Iterations | req/s | p50 | p95 | p99 | Check |
|---|---:|---:|---:|---:|---:|---|
| distributed | 12,056 | ~402 | 113 ms | 213 ms | 315 ms | 12,056 = 12,056 |
| hot_account | 4,672 | ~156 | 243 ms | 864 ms | 1.29 s | 4,672 = 4,672 |
| hot_user | 4,110 | ~137 | 359 ms | 485 ms | 599 ms | 4,110 = 4,110 |
| limit_account | 5,000 | – | 233 ms | 546 ms | 725 ms | **exactly 1,000** accepted, 4,000 rejected |
| limit_user (separate run, 43.5 s) | 5,000 | – | 265 ms | 1.07 s | 2.48 s | **exactly 800** (80 per user), 4,200 rejected |
| retry_storm | 5,000 | ~1,000 | 38 ms | 77 ms | 359 ms | **exactly 200** counted, 4,800 replays |

## Summary: first version → final

| Scenario | req/s | p50 | p95 |
|---|---|---|---|
| distributed | 75 → 402 (≈ 5.4×) | 630 → 113 ms | 840 → 213 ms |
| hot_account | 49 → 156 (≈ 3.2×) | 924 → 243 ms | 1.65 s → 864 ms |
| hot_user | 63 → 137 (≈ 2.2×) | 814 → 359 ms | 945 → 485 ms |
| retry_storm | 242 → ~1,000 (≈ 4×) | 171 → 38 ms | 326 → 77 ms |

Where the gain came from: fewer queries per request (about ×2), no request logging (about +65 %), several processes
(×1.8 for many accounts, nothing for one hot account). The limit of one hot account (about 150 req/s) is the row lock on
the shared counter, not CPU.