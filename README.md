# Quote Desk Capacity Calculator

A free, single-file web tool for engineered-to-order quoting teams. It shows where your RFQ turnaround target breaks, and what one more intake admin or one more quoter actually buys you.

- `index.html`: the whole app (vanilla JS plus Chart.js from cdnjs). No build step and no backend.
- Scenario inputs live in the URL query string, so links are shareable.

## Tests

```bash
node tests/engine.test.js            # Erlang C check, sanity checks, monotonicity (~75 s)
node tests/browser.test.js           # headless Chromium smoke test (needs Playwright)
```
