# Runtime Overhead

generated: 2026-08-19T07:41:58.174Z
node: v24.11.1 platform: win32

| events | vanilla ms | evolve ms | per-event overhead ns | p95 ns | queue |
|---|---|---|---|---|---|
| 1000 | 0.09 | 5.8 | 1427 | 3100 | 200 |
| 10000 | 0.3 | 52.53 | 1306 | 2700 | 200 |

verdict: PASS

1000 events: evolve=5.8ms vanilla=0.09ms overhead≈1427ns/event p95=3100ns queue≤200; 10000 events: evolve=52.53ms vanilla=0.3ms overhead≈1306ns/event p95=2700ns queue≤200

