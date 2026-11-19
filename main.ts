// The token radar-01 entry (Node 22, standard library only, erasable TypeScript: run `node main.ts`).
//
// It reads the sealed snapshot from /input/snapshot.json (or --input <file|directory>), fits the valuation
// model in lib/model.ts to the snapshot's own figures, ranks every pre-token protocol and scores it, then
// writes board.json and data.js into the output directory (--output, else $MAKEFUN_OUTPUT_DIR, else
// /output), copies this repository's dashboard/ and screenshots/ beside them, and writes dossier.json last
// with the vendored make.fun library. The files load relative to this module, so it runs from any
// working directory: `node main.ts`, `node .`, `node /abs/path/main.ts`.
//
// Outside the grader's container, MAKEFUN_OUTPUT_DIR stands in for /output:
//   mkdir -p out && MAKEFUN_OUTPUT_DIR=out node main.ts --input /home/hatch/workspace/makefun/token-radar-kit/token-radar-01-kit/input

import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { boardIssue, buildRadar, dataScript, parseSnapshot, type RadarData } from './lib/model.ts';
import { buildDossier } from './vendor/makefun-board.ts';

const here = fileURLToPath(new URL('.', import.meta.url));

/** The scorer's own caps (reference/gate.json): the text cap shapes the bytes; the rest only refuse. */
const TEXT_MAX_BYTES = 65_536;
const SCREENSHOT_CAPS = { max: 4, max_bytes: 524_288 };
const DASHBOARD_CAPS = { max_files: 400, max_bytes: 4_194_304 };
const IMAGE_NAME = /^[A-Za-z0-9_][A-Za-z0-9._-]{0,127}$/;
const MIN_SCREENSHOTS = 3;
const MIN_ROWS = 100;
const MAX_ROWS = 4_000;

/** --name <value> out of the arguments, or the fallback. */
function arg(name: string, fallback: string | null): string | null {
  const at = process.argv.indexOf(`--${name}`);
  if (at >= 0 && at + 1 < process.argv.length) return process.argv[at + 1]!;
  const eq = process.argv.find((a) => a.startsWith(`--${name}=`));
  if (eq !== undefined) return eq.slice(name.length + 3);
  return fallback;
}

/** The snapshot path: a --input file stands as it is, a directory holds snapshot.json, /input is a directory. */
function snapshotPath(input: string): string {
  const full = resolve(input);
  try {
    if (statSync(full).isFile()) return full;
  } catch {
    // fall through to the directory spelling, which reports its own miss below
  }
  return join(full, 'snapshot.json');
}

const inputArg = arg('input', '/input')!;
const inputFile = inputArg.endsWith('.json') ? resolve(inputArg) : snapshotPath(inputArg);
if (!existsSync(inputFile)) {
  process.stderr.write(`token radar: no snapshot at ${inputFile}: pass --input <snapshot.json|directory> or mount the sealed /input\n`);
  process.exit(2);
}
const out = resolve(arg('output', process.env.MAKEFUN_OUTPUT_DIR ?? '/output')!);

const snapshot = parseSnapshot(readFileSync(inputFile, 'utf8'));
const { board, radar } = buildRadar(snapshot);
const issue = boardIssue(board, snapshot);
if (issue !== null) {
  process.stderr.write(`token radar: the model wrote a board the gate refuses: ${issue}\n`);
  process.exit(1);
}
if (board.length < MIN_ROWS || board.length > MAX_ROWS) {
  process.stderr.write(`token radar: the board has ${board.length} rows: the gate takes ${MIN_ROWS} to ${MAX_ROWS}\n`);
  process.exit(1);
}
if (snapshot.watchlist.length !== radar.watchlist_size) {
  process.stderr.write(`token radar: the board's watchlist size ${radar.watchlist_size} does not match the snapshot's ${snapshot.watchlist.length}\n`);
  process.exit(1);
}

/** Copy one directory's regular files into `to`, skipping names that start with a dot. */
function copyFiles(from: string, to: string): string[] {
  if (!existsSync(from)) return [];
  mkdirSync(to, { recursive: true });
  const copied: string[] = [];
  for (const name of readdirSync(from).sort()) {
    if (name.startsWith('.')) continue;
    const path = join(from, name);
    if (!statSync(path).isFile()) continue;
    copyFileSync(path, join(to, name));
    copied.push(name);
  }
  return copied;
}

mkdirSync(out, { recursive: true });
writeFileSync(join(out, 'board.json'), `${JSON.stringify({ rows: board }, null, 2)}\n`);
writeFileSync(join(out, 'data.js'), dataScript(radar));

const dashboardFiles = copyFiles(join(here, 'dashboard'), join(out, 'dashboard'));
const shots = copyFiles(join(here, 'screenshots'), join(out, 'screenshots'));
if (shots.length < MIN_SCREENSHOTS) {
  process.stderr.write(
    `token radar: screenshots/ holds ${shots.length} image${shots.length === 1 ? '' : 's'}: hand in ${MIN_SCREENSHOTS}, the board, a detail view and a filtered view\n`,
  );
  process.exit(1);
}
for (const name of shots) {
  if (!IMAGE_NAME.test(name)) {
    process.stderr.write(`token radar: screenshots/${name}: a name is letters, digits and . _ -, 1 to 128 characters\n`);
    process.exit(1);
  }
}
if (dashboardFiles.length === 0) {
  process.stderr.write('token radar: dashboard/ holds no files: the page is what the judge reads\n');
  process.exit(1);
}

// The dossier is written last: the scorer rebuilds it from this /output and compares bytes.
const dossier = buildDossier(out, {
  text_max_bytes: TEXT_MAX_BYTES,
  screenshots: SCREENSHOT_CAPS,
  dashboard: DASHBOARD_CAPS,
});
writeFileSync(join(out, 'dossier.json'), dossier);

const p: RadarData = radar;
process.stdout.write(
  `token radar: ${snapshot.protocols.length} protocols in the snapshot, ${p.watchlist_size} on the watchlist, ${p.board_size} rows scored (${p.early_size} early, ${p.live_size} live set aside)\n` +
    `token radar: proof, ${p.proof.comps} comps against a flat ${p.proof.baseline_multiple} multiple and ${p.proof.refit_count} refits: ` +
    `fitted global slope ${p.proof.global_slope} intercept ${p.proof.global_intercept}\n` +
    `token radar: holdout median abs log error fitted ${p.proof.holdout_model} vs flat ${p.proof.holdout_baseline}; ` +
    `walk-forward fitted ${p.proof.walkforward_model} vs flat ${p.proof.walkforward_baseline}\n` +
    `token radar: wrote ${[...['board.json', 'data.js'], ...shots.map((s) => `screenshots/${s}`), ...dashboardFiles.map((f) => `dashboard/${f}`), 'dossier.json']
      .map((f) => join(out, f))
      .join(', ')}\n`,
);
