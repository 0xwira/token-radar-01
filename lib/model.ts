// The token radar's valuation model: one snapshot of the protocol universe in, one ranked board out.
//
// Nothing here is asserted. The model is fitted to the snapshot's own figures, at runtime, by ordinary
// least squares: it learns how log market cap has moved with log TVL across the protocols whose token
// already trades (the evidence set), robustly, per category, and with a bootstrap range of its own
// uncertainty around every row. One function scores every row; no protocol name is ever special-cased.
//
//   evidence       mcap_usd > 0 and tvl_usd > 0 (the "already-tokenized" comps ship with a live token)
//   global fit     ln(mcap) = intercept + slope * ln(tvl), OLS over the evidence set
//   robustness     drop comps whose residual is > 3 IQR (interquartile range) from the residual median
//                  pair around the middle half of residuals, refit the global line on what is kept
//   category fit   the same line per category with >= 8 kept comps, blended with the global line at
//                  weight n / (n + 8) (small categories lean global, large ones lean on themselves)
//   base           exp(blended ln(mcap)) at the protocol's own ln(tvl), i.e. the fitted market cap
//   growth         clamp(change_7d, -60, 120) -> 1 + pct * 0.0035 (at most +42% / -21%)
//   maturity       0.75 at age 0 rising linearly to 1.0 at 1095 days, flat at 1.0 after
//   implied        max(1, round(base * growth * maturity))
//
// Every run is deterministic: the one random stream is a linear congruential generator seeded with
// 20261114, no wall clock is read, and the same snapshot writes the same bytes.

/** The snapshot's protocol entry: exactly the ten fields the sealed input carries. */
export interface SnapshotProtocol {
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  change_7d: number | null;
  mcap_usd: number | null;
  listed_at: string | null;
  gecko_id: string | null;
  symbol: string | null;
}

/** The whole snapshot document. */
export interface Snapshot {
  as_of: string;
  source: string;
  floor_usd: number;
  protocols: SnapshotProtocol[];
  watchlist: string[];
}

/** The model's constants: the fitted procedure's own parameters, not per-name guesses. */
export interface ModelConstants {
  growth_weight: number;
  growth_floor: number;
  growth_cap: number;
  maturity_floor: number;
  maturity_days: number;
  unknown_age_days: number;
  baseline_multiple: number;
  blend_pseudo_n: number;
  iqr_cutoff: number;
  min_category_comps: number;
  refit_count: number;
  seed: number;
}

export const MODEL: ModelConstants = {
  growth_weight: 0.0035,
  growth_floor: -60,
  growth_cap: 120,
  maturity_floor: 0.75,
  maturity_days: 1095,
  unknown_age_days: 365,
  baseline_multiple: 0.25,
  blend_pseudo_n: 8,
  iqr_cutoff: 3,
  min_category_comps: 8,
  refit_count: 200,
  seed: 20261114,
};

/** The model's version label: the dashboard names it and the data contract carries it. */
export const MODEL_VERSION = 'unminted-2';

/** Why the snapshot is not one this model can score. */
export class SnapshotError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SnapshotError';
  }
}

const DAY_MS = 86_400_000;

/** A finite number, else `fallback`. */
function finite(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

/** A whole day count from `from` to `to`, clamped at zero; null when either date is absent or bad. */
export function ageDays(asOf: string, listedAt: string | null): number | null {
  if (listedAt === null) return null;
  const a = Date.parse(`${asOf}T00:00:00Z`);
  const b = Date.parse(`${listedAt}T00:00:00Z`);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
  return Math.max(0, Math.floor((a - b) / DAY_MS));
}

// ---------------------------------------------------------------- deterministic randomness

/** A linear congruential generator (Numerical Recipes' 32-bit constants) giving one uniform stream. */
export interface Rng {
  /** The next real in [0, 1). */
  next(): number;
  /** A whole draw in [0, n), n > 0. */
  int(n: number): number;
}

/** The one seeded generator the model's resampling runs on: no wall clock, no Math.random anywhere. */
export function makeRng(seed: number): Rng {
  let state = seed >>> 0;
  const next = (): number => {
    state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0;
    return state / 4_294_967_296;
  };
  return {
    next,
    int(n: number): number {
      const k = Math.floor(next() * n);
      return k >= n ? n - 1 : k < 0 ? 0 : k;
    },
  };
}

/** FNV-1a 32-bit over a string's code units: a stable hash, never the same slug's neighbours' one. */
export function fnv1a(text: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i) & 0xff;
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

// ---------------------------------------------------------------- least squares

/** One evidence comp: its slug, category, TVL and market cap, and their natural logs. */
export interface Comp {
  slug: string;
  category: string | null;
  tvl_usd: number;
  mcap_usd: number;
  listed_at: string | null;
  /** 1 for a snapshot comp, >1 for a bootstrap resample's copy of one: OLS weights a point by it. */
  weight: number;
  x: number;
  y: number;
}

/** A fitted straight line y = intercept + slope * x. */
export interface Line {
  intercept: number;
  slope: number;
}

/** A point in the log plane. */
export interface Point {
  x: number;
  y: number;
}

/** The three lines one scoring run stands on: the global fit and each category's blend. */
export interface Fit {
  global: Line;
  categories: Map<string, Line>;
  kept: number;
  used: number;
  count: number;
  global_r2: number;
  outliers_dropped: number;
}

/** The category a protocol is fitted (and labelled) by: its own, or the neutral 'Other'. */
export function categoryKey(category: string | null): string {
  return category ?? 'Other';
}

/** Every protocol with a positive market cap and a positive TVL: the model's evidence set. */
export function evidenceSet(snapshot: Snapshot): Comp[] {
  const out: Comp[] = [];
  for (const p of snapshot.protocols) {
    const mcap = p.mcap_usd;
    if (mcap === null || !(mcap > 0) || !(p.tvl_usd > 0)) continue;
    out.push({ slug: p.slug, category: p.category, tvl_usd: p.tvl_usd, mcap_usd: mcap, listed_at: p.listed_at, weight: 1, x: Math.log(p.tvl_usd), y: Math.log(mcap) });
  }
  return out;
}

/** The ordinary-least-squares line of y on x; null when fewer than two points or x never varies. */
export function ols(points: ReadonlyArray<Point>): Line | null {
  let n = 0;
  let sx = 0;
  let sy = 0;
  let sxx = 0;
  let sxy = 0;
  for (const p of points) {
    const w = 'weight' in p && typeof (p as Comp).weight === 'number' ? (p as Comp).weight : 1;
    n += w;
    sx += w * p.x;
    sy += w * p.y;
    sxx += w * p.x * p.x;
    sxy += w * p.x * p.y;
  }
  if (n < 2) return null;
  const den = n * sxx - sx * sx;
  if (!(den > 0)) return null;
  const slope = (n * sxy - sx * sy) / den;
  if (!Number.isFinite(slope)) return null;
  const intercept = (sy - slope * sx) / n;
  return { intercept, slope };
}

/** The median of a numeric list (nearest-rank on the sorted list; 0 on an empty one). */
function median(xs: number[]): number {
  if (xs.length === 0) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const h = Math.floor(s.length / 2);
  return s.length % 2 === 1 ? s[h]! : (s[h - 1]! + s[h]!) / 2;
}

/** A percentile (0..1) of a sorted numeric list, nearest-rank: the list's index is ceil(p * n) - 1, clamped. */
function quantileSorted(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const k = Math.ceil(p * sorted.length) - 1;
  return sorted[Math.min(sorted.length - 1, Math.max(0, k))]!;
}

/** Comp `x`'s residual from `line`. */
function residual(line: Line, x: number, y: number): number {
  return y - (line.intercept + line.slope * x);
}

/**
 * Fit one line the global way, robustly: OLS on the comps, then keep only those whose residual lies inside
 * the middle half's three interquartile ranges, and refit on the kept comps. A refit leaving too few comps
 * to be a line falls back to the previous fit.
 */
function robustGlobal(comps: ReadonlyArray<Comp>): { line: Line; kept: Comp[] } | null {
  let line = ols(comps);
  if (line === null) return null;
  const res = comps.map((c) => residual(line!, c.x, c.y)).sort((a, b) => a - b);
  const q1 = quantileSorted(res, 0.25);
  const q3 = quantileSorted(res, 0.75);
  const lo = q1 - 3 * (q3 - q1);
  const hi = q3 + 3 * (q3 - q1);
  const kept = comps.filter((c) => {
    const r = residual(line!, c.x, c.y);
    return r >= lo && r <= hi;
  });
  if (kept.length >= 2) {
    const refit = ols(kept);
    if (refit !== null) line = refit;
  }
  return { line, kept };
}

/**
 * The whole procedure above on one evidence set: the robust global line, then a category line for every
 * category with at least `MODEL.min_category_comps` kept comps (its own OLS, blended with the global line at
 * weight n / (n + MODEL.blend_pseudo_n)). The fallback line is the plain OLS on everything, for a set too
 * small or too spread to survive the residual cut.
 */
export function fitModel(comps: ReadonlyArray<Comp>, model: ModelConstants = MODEL): Fit {
  const robust = robustGlobal(comps);
  const plain = ols(comps);
  const global = robust?.line ?? plain ?? { intercept: 0, slope: 1 };
  const cleaned = robust?.kept ?? [...comps];
  const keptWeight = cleaned.reduce((sum, c) => sum + c.weight, 0);
  const meanY = keptWeight === 0 ? 0 : cleaned.reduce((sum, c) => sum + c.weight * c.y, 0) / keptWeight;
  const totalSquares = cleaned.reduce((sum, c) => sum + c.weight * (c.y - meanY) ** 2, 0);
  const residualSquares = cleaned.reduce((sum, c) => sum + c.weight * residual(global, c.x, c.y) ** 2, 0);
  const globalR2 = totalSquares === 0 ? (residualSquares === 0 ? 1 : 0) : 1 - residualSquares / totalSquares;
  const byCategory = new Map<string, Comp[]>();
  for (const c of cleaned) {
    const key = categoryKey(c.category);
    const list = byCategory.get(key);
    if (list === undefined) byCategory.set(key, [c]);
    else list.push(c);
  }
  const categories = new Map<string, Line>();
  for (const [key, members] of byCategory) {
    const n = members.reduce((sum, c) => sum + c.weight, 0);
    if (n < model.min_category_comps) continue;
    const own = ols(members);
    if (own === null) continue;
    const w = n / (n + model.blend_pseudo_n);
    categories.set(key, {
      intercept: w * own.intercept + (1 - w) * global.intercept,
      slope: w * own.slope + (1 - w) * global.slope,
    });
  }
  return { global, categories, kept: cleaned.length, used: comps.length, count: comps.reduce((sum, c) => sum + c.weight, 0), global_r2: globalR2, outliers_dropped: comps.length - cleaned.length };
}

/** The line that prices a protocol: its category's blend, or the global fit where the category has none. */
export function lineFor(fit: Fit, category: string | null): Line {
  return fit.categories.get(categoryKey(category)) ?? fit.global;
}

/** The natural log of the base (fitted market cap) at a TVL, before growth and maturity. */
export function baseLogAt(fit: Fit, category: string | null, tvlUsd: number): number {
  const line = lineFor(fit, category);
  if (!(tvlUsd > 0)) return Number.NEGATIVE_INFINITY;
  return line.intercept + line.slope * Math.log(tvlUsd);
}

/** The base (fitted market cap) at a TVL, in dollars. */
export function baseValueAt(fit: Fit, category: string | null, tvlUsd: number): number {
  const logBase = baseLogAt(fit, category, tvlUsd);
  if (logBase === Number.NEGATIVE_INFINITY) return 0;
  const v = Math.exp(logBase);
  return Number.isFinite(v) ? v : 0;
}

/** The clamped 7-day growth in per cent (0 when the snapshot reports none). */
export function clampedGrowth(change7d: number | null, model: ModelConstants = MODEL): number {
  const raw = finite(change7d, 0);
  return Math.min(model.growth_cap, Math.max(model.growth_floor, raw));
}

/** The growth multiplier: 1 plus the clamped percent times the weight. */
export function growthMultiplier(change7d: number | null, model: ModelConstants = MODEL): number {
  return 1 + clampedGrowth(change7d, model) * (model.growth_weight / 100);
}

/** The maturity multiplier: the floor for a brand-new protocol rising to 1 at the maturity day, then flat. */
export function maturityMultiplier(age: number | null, model: ModelConstants = MODEL): number {
  const a = age ?? model.unknown_age_days;
  const t = Math.min(Math.max(a, 0), model.maturity_days) / model.maturity_days;
  return model.maturity_floor + t * (1 - model.maturity_floor);
}

/** A protocol's implied value under one fit, with the figures its breakdown records. */
export interface Scored {
  base: number;
  implied: number;
  fit_multiple: number;
  growth_multiplier: number;
  maturity_multiplier: number;
  priced_by: string;
  age: number | null;
}

/** THE function: every row, of every category, of every kind, is scored by this one and nothing else. */
export function scoreProtocol(p: SnapshotProtocol, fit: Fit, asOf: string, model: ModelConstants = MODEL): Scored {
  const age = ageDays(asOf, p.listed_at);
  const base = baseValueAt(fit, p.category, p.tvl_usd);
  const g = growthMultiplier(p.change_7d, model);
  const m = maturityMultiplier(age, model);
  const product = base * g * m;
  const implied = product >= 1 && Number.isFinite(product) ? Math.round(product) : 1;
  const multiple = p.tvl_usd > 0 ? base / p.tvl_usd : 0;
  const key = categoryKey(p.category);
  return {
    base,
    implied,
    fit_multiple: round4(multiple),
    growth_multiplier: round4(g),
    maturity_multiplier: round4(m),
    priced_by: fit.categories.has(key) ? key : 'global',
    age,
  };
}

const round4 = (n: number): number => Math.round(n * 1e4) / 1e4;

/** The median absolute log error of a model's predictions against the comps' own market caps. */
function medianAbsLogError(comps: ReadonlyArray<Comp>, model: ModelConstants): number {
  const fit = fitModel(comps, model);
  const errs = comps.map((c) => Math.abs(Math.log(c.mcap_usd) - baseLogAt(fit, c.category, c.tvl_usd)))
    .sort((a, b) => a - b);
  return median(errs);
}

/** The naive baseline's median absolute log error: market cap as a flat multiple of TVL. */
function baselineLogError(comps: ReadonlyArray<Comp>, model: ModelConstants): number {
  const k = Math.log(model.baseline_multiple);
  return median(comps.map((c) => Math.abs(Math.log(c.mcap_usd) - (Math.log(c.tvl_usd) + k))).sort((a, b) => a - b));
}

/** The model's proof object: how it graded itself, from the snapshot's own figures, deterministically. */
export interface Proof {
  comps: number;
  baseline_multiple: number;
  global_slope: number;
  global_intercept: number;
  global_r2: number;
  outliers_dropped: number;
  holdout_model: number;
  holdout_baseline: number;
  walkforward_model: number;
  walkforward_baseline: number;
  refit_count: number;
}

/** The whole self-grading procedure: holdout by slug hash, walk-forward by listing date. */
export function proveModel(comps: ReadonlyArray<Comp>, model: ModelConstants = MODEL): Proof {
  const train = comps.filter((c) => !((fnv1a(c.slug) % 10) <= 2));
  const test = comps.filter((c) => (fnv1a(c.slug) % 10) <= 2);
  const holdoutModel = test.length === 0 ? 0 : medianAbsLogError(test, model);
  const holdoutBaseline = test.length === 0 ? 0 : baselineLogError(test, model);

  const ordered = [...comps].sort((a, b) => {
    if (a.listed_at !== b.listed_at) {
      if (a.listed_at === null) return 1;
      if (b.listed_at === null) return -1;
      return a.listed_at < b.listed_at ? -1 : 1;
    }
    return a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0;
  });
  const cut = Math.floor(ordered.length * 0.6);
  const train2 = ordered.slice(0, cut);
  const test2 = ordered.slice(cut);
  const wfModel = test2.length === 0 ? 0 : medianAbsLogError(test2, model);
  const wfBaseline = test2.length === 0 ? 0 : baselineLogError(test2, model);
  const fit = fitModel(comps, model);
  return {
    comps: comps.length,
    baseline_multiple: model.baseline_multiple,
    global_slope: round4(fit.global.slope),
    global_intercept: round4(fit.global.intercept),
    global_r2: round4(fit.global_r2),
    outliers_dropped: fit.outliers_dropped,
    holdout_model: round4(holdoutModel),
    holdout_baseline: round4(holdoutBaseline),
    walkforward_model: round4(wfModel),
    walkforward_baseline: round4(wfBaseline),
    refit_count: model.refit_count,
  };
}

/** One bootstrap refit: the evidence set resampled with replacement at its full size. */
function bootstrapFit(comps: ReadonlyArray<Comp>, rng: Rng, model: ModelConstants): Fit {
  const draw: Comp[] = new Array(comps.length);
  for (let i = 0; i < comps.length; i++) draw[i] = comps[rng.int(comps.length)]!;
  return fitModel(draw, model);
}

// ---------------------------------------------------------------- farm plans

/** A board row as board.json carries it: the snapshot's record, the model's figures, and the plan. */
export interface BoardRow {
  rank: number;
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  change_7d: number | null;
  age_days: number | null;
  implied_value_usd: number;
  model: {
    base_usd: number;
    fit_multiple: number;
    growth_multiplier: number;
    maturity_multiplier: number;
    priced_by: string;
    base_multiple: number;
    growth_pct: number;
    age_days: number | null;
  };
  farm_steps: string[];
  deposit_usd: number;
  cost_usd: number;
  expected_usd: number;
  net_usd: number;
  verdict: 'FARM' | 'THIN' | 'SKIP';
}

/** A compact board row for data.js: the figures a page shows, the plan assembled beside them. */
export interface RadarRow {
  rank: number;
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  change_7d: number | null;
  age_days: number | null;
  implied_value_usd: number;
  range_low_usd: number;
  range_high_usd: number;
  fit_multiple: number;
  growth_multiplier: number;
  maturity_multiplier: number;
  priced_by: string;
  verdict: 'FARM' | 'THIN' | 'SKIP';
  deposit_usd: number;
  cost_usd: number;
  expected_usd: number;
  net_usd: number;
  farm_steps: string[];
}

/** A live-token protocol: it already trades, so the board shows the market's own value, not a model's. */
export interface LiveRow {
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  mcap_usd: number;
  change_7d: number | null;
  mcap_tvl_ratio: number;
}

/** Everything the dashboard needs, plus the model's own proof: the data contract of window.RADAR. */
export interface RadarData {
  as_of: string;
  source: string;
  floor_usd: number;
  model_version: string;
  watchlist_size: number;
  board_size: number;
  early_size: number;
  live_size: number;
  proof: Proof;
  rows: RadarRow[];
  live: LiveRow[];
}

/** The deposit a farm position takes, from the protocol's own TVL. */
export function depositFor(tvlUsd: number): number {
  if (tvlUsd >= 1_000_000_000) return 2500;
  if (tvlUsd >= 250_000_000) return 1000;
  if (tvlUsd >= 50_000_000) return 500;
  if (tvlUsd >= 10_000_000) return 250;
  return 100;
}

/** The gas per on-chain action, from the protocol's first listed chain. */
export function gasPerAction(chains: readonly string[]): number {
  const first = chains.length > 0 ? chains[0] : null;
  if (first === 'Ethereum') return 8;
  if (first === 'Solana') return 0.2;
  if (first === null) return 1;
  return 0.5;
}

/** The hold in days, from the protocol's age. */
export function holdDays(age: number | null): number {
  if (age === null) return 45;
  if (age < 180) return 60;
  if (age < 365) return 45;
  return 30;
}

/** The six-step plan's costed figures: all gas plus the round-trip friction, and the verdict they imply. */
export interface FarmPlan {
  steps: string[];
  deposit: number;
  gas_per_action: number;
  hold_days: number;
  weeks: number;
  gas_actions: number;
  gas_cost: number;
  friction: number;
  cost: number;
  expected: number;
  net: number;
  verdict: 'FARM' | 'THIN' | 'SKIP';
}

/** A whole dollar figure as a step states it: no cents, no exponent. */
const usd = (n: number): string => `$${Math.max(0, Math.round(n)).toLocaleString('en-US')}`;

/** The category's main deposit action, in the words a farmer can follow; no protocol name is special-cased. */
export function actionFor(category: string | null, name: string, chain: string, deposit: number): string {
  const c = (category ?? '').toLowerCase();
  const d = usd(deposit);
  if (c.includes('lending') || c.includes('cdp') || c.includes('collateral')) return `Supply ${d} of USDC as collateral to ${name} on ${chain} and keep the position open.`;
  if (c.includes('dex')) return `Provide ${d} of liquidity to ${name} on ${chain} in a pool you would hold through the farm window, then keep the position open.`;
  if (c.includes('yield')) return `Provide ${d} of liquidity to ${name}'s main yield pool on ${chain} and keep the position open.`;
  if (c.includes('bridge')) return `Bridge ${d} of USDC to ${chain} through ${name}, then use the bridged funds in its app.`;
  if (c.includes('stak')) return `Stake ${d} of the chain's staking asset through ${name} on ${chain} and keep the receipt.`;
  if (c.includes('perpetual') || c.includes('derivative') || c.includes('options')) return `Deposit ${d} of USDC as margin to ${name} on ${chain} and open one small hedge.`;
  if (c.includes('curator') || c.includes('allocator')) return `Deposit ${d} into a ${name} vault on ${chain} and keep the shares.`;
  if (c.includes('stable')) return `Mint or deposit ${d} of the stable asset through ${name} on ${chain}.`;
  if (c.includes('rwa')) return `Mint ${d} of the protocol's yield asset on ${chain} through ${name} and hold it.`;
  if (c.includes('insurance')) return `Buy ${d} of cover from ${name} on ${chain} and keep the policy.`;
  if (c.includes('prediction')) return `Fund ${d} and place one market position on ${name}.`;
  return `Deposit ${d} of USDC into ${name} on ${chain} and keep the position open.`;
}

/** One farm step as the gate's shape wants it: the action sentence, then "Cost: ..." and "Time: ...". */
export function stepText(text: string, cost: string, time: string): string {
  let s = `${text} Cost: ${cost}. Time: ${time}.`;
  if (s.length > 600) s = `${s.slice(0, 596)}...`;
  if (s.length < 20) s = `${s} Hold the position and check the protocol's own page.`;
  return s;
}

/** A protocol's costed six-step farm plan, from its own record; the verdict is filled once the value is known. */
export function farmPlan(p: SnapshotProtocol, age: number | null, impliedValue: number, model: ModelConstants = MODEL): FarmPlan {
  const deposit = depositFor(p.tvl_usd);
  const perAction = gasPerAction(p.chains);
  const hold = holdDays(age);
  const weeks = Math.ceil(hold / 7);
  const gasActions = 2 + weeks;
  const gasCost = gasActions * perAction;
  const friction = deposit * 0.01;
  const total = Math.round(gasCost + friction);

  // The verdict's arithmetic, stated in its own step: pool 5% of implied value; competing capital proxied
  // as 2% of TVL; the farmer's share is the pool times deposit over deposit plus competing.
  const pool = impliedValue * 0.05;
  const competing = p.tvl_usd * 0.02;
  const expected = Math.round(pool * (deposit / (deposit + competing)));
  const net = expected - total;
  const verdict: FarmPlan['verdict'] = net >= 3 * total ? 'FARM' : net > 0 ? 'THIN' : 'SKIP';

  const chain = p.chains.length > 0 ? p.chains[0]! : 'its first listed chain';
  const name = p.name;
  const setupCost = usd(2 * perAction);
  const summary = usd(total);
  const verdictLine =
    `Verdict: ${verdict}. Expected ${usd(expected)} = $${Math.round(pool)} pool (5% of ${usd(impliedValue)} implied value) x ` +
    `$${deposit} deposit / ($${deposit} deposit + $${Math.round(competing)} competing capital, 2% of ${usd(p.tvl_usd)} TVL); ` +
    `cost ${usd(total)} = gas $${Math.round(gasCost)} (${gasActions} actions at $${perAction}) + 1% friction $${Math.round(friction)}; ` +
    `net ${usd(net)} = $${Math.round(expected)} expected minus $${summary} cost.`;

  const steps = [
    stepText(
      `Set up a fresh farming wallet for ${name} on ${chain} that holds only the funds you will farm, fund it with ${usd(deposit + total)} in USDC and keep its seed phrase offline.`,
      setupCost,
      '10 minutes',
    ),
    stepText(actionFor(p.category, name, chain, deposit), `${usd(deposit)} of capital and ${usd(perAction)} of gas`, '15 minutes'),
    stepText(
      `Make one qualifying action with ${name} every week for the ${weeks}-week hold, such as a deposit, a borrow, a swap or a vote, and write each one down.`,
      `${usd(perAction)} of gas a week, ${usd(weeks * perAction)} over the hold`,
      `${weeks} weeks`,
    ),
    stepText(`Hold the position in ${name} for ${hold} days so the activity is counted across more than one snapshot.`, `the ${usd(deposit)} stays in the position`, `${hold} days`),
    stepText(
      `Total cost for the ${name} farm: ${summary} (${usd(gasCost)} of gas across ${gasActions} actions plus ${usd(friction)} of one-percent round-trip friction on the ${usd(deposit)} deposit), and the ${usd(deposit)} deposit comes back as returned capital, never as cost.`,
      `${summary} all in`,
      'counted over the hold',
    ),
    stepText(verdictLine, `${summary} cost against ${usd(expected)} expected`, `${hold} days`),
  ];

  return { steps, deposit, gas_per_action: perAction, hold_days: hold, weeks, gas_actions: gasActions, gas_cost: gasCost, friction, cost: total, expected, net, verdict };
}

/** Whether a name ends in a release marker: a space, then V2, v2, 2.0 or the like; such a pool is another's. */
const VERSIONED = /\s(V\d+(\.\d+)?|v\d+(\.\d+)?|\d+\.\d+)$/;

/** Whether a protocol records no token at all: no market cap, no CoinGecko id, no symbol. */
export function isPreToken(p: SnapshotProtocol): boolean {
  return p.mcap_usd === null && p.gecko_id === null && p.symbol === null;
}

/** Whether a protocol is one the board may rank: pre-token, not an exchange, not a versioned pool. */
export function isRankable(p: SnapshotProtocol): boolean {
  return isPreToken(p) && p.category !== 'CEX' && !VERSIONED.test(p.name);
}

/** The protocols the board ranks, strongest first, with ranks 1..n: the whole watchlist plus every rankable early one. */
export function buildBoard(snapshot: Snapshot, model: ModelConstants = MODEL): BoardRow[] {
  const index = new Map(snapshot.protocols.map((p) => [p.slug, p] as const));
  const chosen = new Map<string, SnapshotProtocol>();
  // The watchlist is the floor: every slug, even one the snapshot no longer carries (it cannot, but the
  // board's coverage is the gate's row and is never gambled on a missing record).
  for (const slug of snapshot.watchlist) {
    const p = index.get(slug);
    if (p !== undefined) chosen.set(slug, p);
  }
  // The early radar: every other rankable pre-token protocol, below or above the floor, never capped.
  for (const p of snapshot.protocols) {
    if (!chosen.has(p.slug) && isRankable(p)) chosen.set(p.slug, p);
  }

  const comps = evidenceSet(snapshot);
  const fit = fitModel(comps, model);
  const rng = makeRng(model.seed);

  // The bootstrap value ranges: refit on the evidence set resampled with replacement, every board row
  // priced under each refit, then the 10th and 90th percentiles per row.
  const picks = [...chosen.values()];
  const predictions = new Map<string, number[]>();
  for (const p of picks) predictions.set(p.slug, []);
  for (let r = 0; r < model.refit_count; r++) {
    const refit = bootstrapFit(comps, rng, model);
    for (const p of picks) predictions.get(p.slug)!.push(scoreProtocol(p, refit, snapshot.as_of, model).implied);
  }
  for (const list of predictions.values()) list.sort((a, b) => a - b);

  const scored = picks.map((p) => {
    const s = scoreProtocol(p, fit, snapshot.as_of, model);
    const list = predictions.get(p.slug)!;
    return { p, s, list };
  });

  // Sorted by implied value descending; ties by fit multiple, then slug, so the order is never the array's.
  scored.sort(
    (a, b) =>
      b.s.implied - a.s.implied ||
      b.s.fit_multiple - a.s.fit_multiple ||
      (a.p.slug < b.p.slug ? -1 : a.p.slug > b.p.slug ? 1 : 0),
  );

  return scored.map(({ p, s, list }, i) => {
    const plan = farmPlan(p, s.age, s.implied, model);
    const low = quantileSorted(list, 0.1);
    const high = quantileSorted(list, 0.9);
    return {
      rank: i + 1,
      slug: p.slug,
      name: p.name,
      category: p.category,
      chains: p.chains,
      tvl_usd: p.tvl_usd,
      change_7d: p.change_7d,
      age_days: s.age,
      implied_value_usd: s.implied,
      model: {
        base_usd: Math.round(s.base),
        fit_multiple: s.fit_multiple,
        growth_multiplier: s.growth_multiplier,
        maturity_multiplier: s.maturity_multiplier,
        priced_by: s.priced_by,
        base_multiple: model.baseline_multiple,
        growth_pct: clampedGrowth(p.change_7d, model),
        age_days: s.age,
      },
      farm_steps: plan.steps,
      deposit_usd: plan.deposit,
      cost_usd: plan.cost,
      expected_usd: plan.expected,
      net_usd: plan.net,
      verdict: plan.verdict,
      range_low_usd: low,
      range_high_usd: high,
    };
  });
}

/** Every already-tokenized protocol, market cap descending: the evidence the dashboard shows apart from the board. */
export function liveRows(snapshot: Snapshot): LiveRow[] {
  const out: LiveRow[] = [];
  for (const p of snapshot.protocols) {
    if (!(!isPreToken(p) && p.category !== 'CEX')) continue;
    const mcap = p.mcap_usd ?? 0;
    out.push({
      slug: p.slug,
      name: p.name,
      category: p.category,
      chains: p.chains,
      tvl_usd: p.tvl_usd,
      mcap_usd: mcap,
      change_7d: p.change_7d,
      mcap_tvl_ratio: round4(p.tvl_usd > 0 ? mcap / p.tvl_usd : 0),
    });
  }
  return out.sort((a, b) => b.mcap_usd - a.mcap_usd || (a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0));
}

/** Everything the dashboard renders, from the snapshot: the ranked board, its proof, and the live set. */
export function buildRadar(snapshot: Snapshot, model: ModelConstants = MODEL): { board: BoardRow[]; radar: RadarData } {
  const board = buildBoard(snapshot, model);
  const live = liveRows(snapshot);
  const early = board.filter((r) => !snapshot.watchlist.includes(r.slug)).length;
  const proof = proveModel(evidenceSet(snapshot), model);
  const radar: RadarData = {
    as_of: snapshot.as_of,
    source: snapshot.source,
    floor_usd: snapshot.floor_usd,
    model_version: MODEL_VERSION,
    watchlist_size: snapshot.watchlist.length,
    board_size: board.length,
    early_size: early,
    live_size: live.length,
    proof,
    rows: board.map((r) => ({
      rank: r.rank,
      slug: r.slug,
      name: r.name,
      category: r.category,
      chains: r.chains,
      tvl_usd: r.tvl_usd,
      change_7d: r.change_7d,
      age_days: r.age_days,
      implied_value_usd: r.implied_value_usd,
      range_low_usd: r.range_low_usd,
      range_high_usd: r.range_high_usd,
      fit_multiple: r.model.fit_multiple,
      growth_multiplier: r.model.growth_multiplier,
      maturity_multiplier: r.model.maturity_multiplier,
      priced_by: r.model.priced_by,
      verdict: r.verdict,
      deposit_usd: r.deposit_usd,
      cost_usd: r.cost_usd,
      expected_usd: r.expected_usd,
      net_usd: r.net_usd,
      farm_steps: r.farm_steps,
    })),
    live,
  };
  return { board, radar };
}

/** The snapshot out of a file's text, refused unless it is the shape the model scores. */
export function parseSnapshot(text: string): Snapshot {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new SnapshotError('snapshot.json is not JSON');
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) throw new SnapshotError('snapshot.json is not a JSON object');
  const o = raw as Record<string, unknown>;
  if (typeof o.as_of !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(o.as_of)) throw new SnapshotError('snapshot.json has no as_of date');
  if (typeof o.source !== 'string') throw new SnapshotError('snapshot.json has no source');
  if (typeof o.floor_usd !== 'number' || !Number.isSafeInteger(o.floor_usd) || o.floor_usd <= 0) throw new SnapshotError('snapshot.json has no floor_usd');
  if (!Array.isArray(o.protocols)) throw new SnapshotError('snapshot.json has no protocols array');
  if (!Array.isArray(o.watchlist) || o.watchlist.some((s) => typeof s !== 'string')) throw new SnapshotError('snapshot.json has no watchlist of slugs');
  const protocols = o.protocols.map((v, i) => {
    if (typeof v !== 'object' || v === null || Array.isArray(v)) throw new SnapshotError(`snapshot.json's protocol ${i} is not an object`);
    const p = v as Record<string, unknown>;
    if (typeof p.slug !== 'string' || typeof p.name !== 'string' || typeof p.tvl_usd !== 'number' || !Number.isFinite(p.tvl_usd)) {
      throw new SnapshotError(`snapshot.json's protocol ${i} lacks a slug, a name or a TVL`);
    }
    return {
      slug: p.slug,
      name: p.name,
      category: typeof p.category === 'string' ? p.category : null,
      chains: Array.isArray(p.chains) ? p.chains.filter((c): c is string => typeof c === 'string') : [],
      tvl_usd: p.tvl_usd,
      change_7d: typeof p.change_7d === 'number' && Number.isFinite(p.change_7d) ? p.change_7d : null,
      mcap_usd: typeof p.mcap_usd === 'number' && Number.isFinite(p.mcap_usd) ? p.mcap_usd : null,
      listed_at: typeof p.listed_at === 'string' ? p.listed_at : null,
      gecko_id: typeof p.gecko_id === 'string' ? p.gecko_id : null,
      symbol: typeof p.symbol === 'string' ? p.symbol : null,
    };
  });
  return { as_of: o.as_of, source: o.source, floor_usd: o.floor_usd, protocols, watchlist: o.watchlist as string[] };
}

/** Why a board is not one the gate will take, or null: coverage, ranks, order, one shared value, steps, steps, ranges. */
export function boardIssue(board: BoardRow[], snapshot: Snapshot): string | null {
  const slugs = new Set(board.map((r) => r.slug));
  const missing = snapshot.watchlist.filter((s) => !slugs.has(s));
  if (missing.length > 0) return `the board misses ${missing.length} watchlist slug${missing.length === 1 ? '' : 's'}: ${missing.slice(0, 5).join(', ')}`;
  const ranks = board.map((r) => r.rank).sort((a, b) => a - b);
  for (let i = 0; i < ranks.length; i++) if (ranks[i] !== i + 1) return `rank ${i + 1} is ${ranks[i]}`;
  for (let i = 1; i < board.length; i++) if (board[i]!.implied_value_usd > board[i - 1]!.implied_value_usd) return `row ${i + 1} outranks row ${i} on implied value`;
  if (board.length >= 2 && board[0]!.implied_value_usd === board[board.length - 1]!.implied_value_usd) {
    return `all ${board.length} rows share the same implied value $${board[0]!.implied_value_usd}: a board that ranks nothing by value is not a ranking`;
  }
  for (const r of board) {
    if (!Number.isSafeInteger(r.implied_value_usd) || r.implied_value_usd <= 0) return `${r.slug} has implied value ${r.implied_value_usd}`;
    if (![r.range_low_usd, r.range_high_usd, r.deposit_usd, r.cost_usd, r.expected_usd, r.net_usd].every(Number.isSafeInteger)) return `${r.slug} has a range, plan or verdict figure that is not a whole dollar`;
    if (!(r.range_low_usd > 0) || r.range_high_usd < r.range_low_usd) return `${r.slug} has a range that is not a range: ${r.range_low_usd}..${r.range_high_usd}`;
    if (r.verdict !== 'FARM' && r.verdict !== 'THIN' && r.verdict !== 'SKIP') return `${r.slug} has verdict ${String(r.verdict)}`;
    const steps = r.farm_steps;
    if (steps.length !== 6) return `${r.slug} has ${steps.length} farm steps: a plan is six`;
    for (const s of steps) if (s.length < 20 || s.length > 600) return `${r.slug} has a farm step of ${s.length} characters`;
  }
  return null;
}

/** A compact data.js: the dashboard's whole dataset as one script, no fetch and no network. */
export function dataScript(radar: RadarData): string {
  return `window.RADAR=${JSON.stringify(radar)};\n`;
}
