# Data, statistics and the absence of prediction

## What the product computes

From recorded rounds (chronological, de-duplicated):

- **Descriptive statistics**: count, min/max, median, 10th/25th/75th/90th percentiles, share of rounds reaching 1.5×, 2×, 5×, 10×, longest and current run below 2×, and a 7-bucket distribution.
- **Pattern check (evaluation framework)**: `evaluateStreakRule` tests the "it's due" belief. After *k* consecutive rounds below 2×, is the next round ≥ 2× more often than other rounds? It compares the two groups with a two-sided two-proportion z-test, requires at least 30 rounds in each group before giving a verdict, and uses p < 0.01 as the bar. The text always states the sample sizes.
- **AI explanation (optional)**: the backend sends the statistics above (never raw page data or user identity) to the configured model with a system instruction that forbids predictions, betting advice and "edge" language, and asks it to state the sample size. The panel labels the output "AI-generated … Not a prediction."

## What it deliberately does not do

- There is **no prediction engine**. The previous project's KNN + LLM "prediction", "confidence %" and BET/SKIP advice were not carried over: there was no validation, the confidence figure was the model's self-report, and crash games are designed so that past rounds carry no information about the next one.
- No accuracy, win-rate or confidence figures are shown anywhere.
- No simulated data is presented as real. The deterministic pseudo-random sequence in `shared/test/analysis.test.js` exists only to check that the test reports "no significant difference" on independent data.

## Why this is the honest design

For a provably fair crash game with house edge *e*, P(result ≥ m) ≈ (1 − e)/m for every round, independent
of history. A single statistic that looks unusual in a finite sample is expected now and then. That is
why the pattern check uses a strict threshold, minimum sample sizes and cautious wording, and why even a
"difference detected" result is described as possible chance, not as an edge.

If a predictive feature is ever proposed, the minimum bar is: pre-registered rule, out-of-sample
evaluation on rounds recorded after the rule was fixed, correction for the number of rules tried, and
a comparison against the base rate. That is the evaluation this framework is built to run.
