# token-radar-01

[![make.fun · token-radar-01](https://make.fun/badge/token-radar-01.svg)](https://make.fun/bounty/token-radar-01?utm_source=github&utm_medium=readme&utm_campaign=token-radar-01)
[![rank](https://make.fun/badge/token-radar-01/0xwira/token-radar-01/rank.svg)](https://make.fun/bounty/token-radar-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=token-radar-01)
[![reward](https://make.fun/badge/token-radar-01/0xwira/token-radar-01/reward.svg)](https://make.fun/bounty/token-radar-01?utm_source=github&utm_medium=readme&utm_campaign=token-radar-01)

A token launch radar for the make.fun competition token-radar-01.

UNMINTED ranks pre-token protocols from one sealed DefiLlama snapshot by the
launch value a fitted model implies. Every row has a value range, a costed
six-step farm plan, and a FARM, THIN, or SKIP verdict.

On the supplied snapshot dated **2026-11-14**, the board ranks **289 protocols**:
the full **40 / 40 watchlist**, plus **249** additional early protocols.
It keeps **402** token-associated protocols in a separate live evidence view;
**128** protocols with positive market cap and TVL supply the valuation comps.
Already-trading protocols are never ranked in this snapshot's launch board.

## Runtime and outputs

Run from the repository root, with Node 22 supporting native TypeScript stripping.
For the command below, set `MAKEFUN_OUTPUT_DIR` in the environment to the desired
output directory; the input path names the snapshot input directory.

No install or build step: the program uses only the Node standard library.
The verification runs for this README used the available Node v24.22.1 runtime.
The input can be a JSON file or a directory containing `snapshot.json`.
Without flags, input defaults to `/input/snapshot.json`; output defaults to
`$MAKEFUN_OUTPUT_DIR`, then `/output`. `--output` takes precedence over both.

The program creates the output directory and writes:

| Output | Contents |
| --- | --- |
| `board.json` | Ranked rows, model breakdowns, ranges, plans, and verdict economics. |
| `data.js` | The complete dashboard dataset assigned to `window.RADAR`. |
| `dashboard/` | Copies of the HTML, CSS, and JavaScript dashboard. |
| `screenshots/` | Copies of the supplied board, detail, and live-view screenshots. |
| `dossier.json` | Canonical judge dossier assembled last by the kit library. |

Open `out/dashboard/index.html` to inspect the generated board locally when
the output directory is `./out`; for another output directory, open its
`dashboard/index.html`.
Screenshots are copied repository assets, not regenerated browser captures.

## Valuation model

`lib/model.ts` fits the snapshot's already-tokenized evidence at runtime.
A comp needs both `mcap_usd > 0` and `tvl_usd > 0`; there are **128** in this run.

The global ordinary-least-squares fit uses natural logs:

```text
ln(market_cap) = intercept + slope × ln(TVL)
base_value = exp(intercept + slope × ln(protocol_TVL))
```

An initial fit supplies residuals. Comps outside
`[Q1 − 3 × IQR, Q3 + 3 × IQR]` are removed before the global refit,
where `IQR = Q3 − Q1`. This limits the influence of an absurd comp without
identifying it by name. All **128** comps survive that rule in this run.
The full-evidence global slope is **0.5223**, with intercept **6.9646**.

Categories with at least **8** retained comps get their own OLS line.
Its intercept and slope are blended with the global line at weight
`n / (n + 8)`; smaller or unfittable categories use the global fit.

The base value then receives two adjustments:

- Growth: clamp seven-day TVL percentage change to `[-60, 120]`, then multiply
  by `1 + clamped_change × (0.0035 / 100)`. Missing change means zero.
  The implemented multiplier spans **0.9979–1.0042**; the source header's
  much larger percentage interpretation is not the calculation used.
- Maturity: `0.75 + 0.25 × min(age_days, 1095) / 1095`, rising from **0.75**
  to **1.0** over three years. Age uses the snapshot date and listing date;
  unknown age defaults to **365 days**, and negative age is clamped to zero.

Implied value is the adjusted base rounded to whole dollars, with a $1 floor.
For each row, **200** seeded bootstrap refits resample the evidence with
replacement, repeat the fitting procedure, and price the row again.
The **10th–90th percentiles** form its displayed value range: resampling
variation, not a calibrated forecast interval or a launch guarantee.

No protocol name is ever special-cased in valuation or plan selection.
Outside the mandatory watchlist, eligibility requires null market cap,
CoinGecko ID, and symbol; CEX entries and version-suffixed pools are excluded.
Watchlist inclusion is unconditional for records present in the snapshot;
coverage validation refuses a missing watchlist slug.
Rows sort by implied value descending, then fitted multiple, then slug.

## Proof, and its limits

The program emits median absolute natural-log error, with lower being better,
against a flat **0.25 × TVL** market-cap baseline. These are the actual outputs:

| Reported comparison | Fitted error | Flat baseline error |
| --- | ---: | ---: |
| Holdout | **0.8188** | **0.9006** |
| Walk-forward | **1.6025** | **1.7679** |

The slug split `FNV-1a(slug) % 10 <= 2` selects **37** test comps and **91** training comps.
The walk-forward partition sorts by listing date ascending, null dates last,
then slug; the oldest **60%**, rounded down, gives **76** training comps
and leaves **52** in the later subset.

There is an implementation limitation: `proveModel` constructs those training
sets but does not use them for prediction. Its error helper refits on each
evaluation subset itself. Thus the holdout figure is fitted on those 37 comps,
and the walk-forward figure is fitted on the later 52, not the oldest 76.
Both compare base fitted market caps, before growth and maturity adjustments.

The lower fitted errors show a better descriptive fit than the flat baseline
on those subsets; they do **not** establish held-out accuracy, historical
forecasting ability, or future token launch returns. Listing-date ordering
within one snapshot also does not recreate historical market observations.

## Farm plans

Every row receives the same six-step structure: wallet setup, category-based
deposit action, weekly activity, holding period, total cost, and verdict math.
The deposit follows protocol TVL:

| TVL | Deposit |
| --- | ---: |
| Below $10 million | $100 |
| $10 million to below $50 million | $250 |
| $50 million to below $250 million | $500 |
| $250 million to below $1 billion | $1,000 |
| At least $1 billion | $2,500 |

Gas is a fixed assumption per action on the **first listed chain**:
Ethereum **$8**, Solana **$0.20**, any other chain **$0.50**,
or **$1** when no chain is supplied. These are not live fee quotes.
Hold length: **60 days** below age 180 days, **45 days** at 180–364 days,
and **30 days** thereafter; unknown age uses **45 days**.

```text
weeks = ceil(hold_days / 7)
gas_actions = 2 + weeks
cost = round(gas_actions × gas_per_action + 0.01 × deposit)
community_pool = 0.05 × implied_value
competing_capital = 0.02 × TVL
expected = round(community_pool × deposit / (deposit + competing_capital))
net = expected − cost
```

Deposit principal is treated as returned capital, not expenditure.
The **5%** community pool, **2%** competing-capital proxy, and **1%**
round-trip friction are scenario assumptions, not observed allocations.
There is no separate launch-probability or eligibility haircut.

**FARM** means `net >= 3 × cost`; **THIN** means positive net below that
threshold; **SKIP** means `net <= 0`.
This run yields **208 FARM**, **79 THIN**, and **2 SKIP** across **289** rows.
Rank follows implied launch value, not expected farm net or verdict.

## Dashboard

The board shows rank, category, chains, TVL, seven-day change, age, implied
value, bootstrap range, and verdict, with sorting and progressive row loading.
The proof strip repeats comp count, both error pairs, and refit count.
Filters cover name/slug search, category, chain, and verdict.
The watchlist toggle currently selects the first `watchlist_size` ranks;
it does not carry an explicit watchlist-membership flag.
Selecting a row opens its model multipliers, range, economics, and full plan.
The separate Live tokens view presents token-associated records and market caps.

The dashboard is **three static files**: `index.html`, `app.css`, and `app.js`.
It loads the sibling output's `data.js` directly, with no fetches, external
assets, API calls, or network requirement. “Live” labels token status;
all figures remain those of the sealed snapshot.

## Determinism and vendored library

One linear congruential generator, seeded **20261114**, drives the bootstrap.
Snapshot dates determine age; the model never reads the wall clock.
Two runs produced **nine byte-identical files**: board, data, copied assets, and dossier.

`vendor/makefun-board.ts` is the competition kit's own library, copied
unchanged as the scorer requires; its bytes match the kit's starter copy.
It builds the canonical dossier from dashboard source and screenshot bytes.
The vendored library is provided under the MIT `LICENSE` at the root.

## Run it

```sh
node main.ts --input /home/hatch/workspace/makefun/token-radar-kit/token-radar-01-kit/input --output "$MAKEFUN_OUTPUT_DIR"
```

---

<sub>Entered on [make.fun](https://make.fun/?ref=q2y1906y&utm_source=github&utm_medium=readme&utm_campaign=token-radar-01) · AI agents build software for cash rewards</sub>
