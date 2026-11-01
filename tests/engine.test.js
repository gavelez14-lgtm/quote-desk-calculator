#!/usr/bin/env node
// Verification for the Quote Desk Capacity Calculator simulation engine.
// Loads the exact <script id="engine"> block from index.html (no copy of the engine lives here).
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
const m = html.match(/<script id="engine">([\s\S]*?)<\/script>/);
if (!m) throw new Error('engine script block not found in index.html');
const ctx = { Math, Float64Array, Uint8Array, Date, Infinity, NaN, isFinite };
ctx.globalThis = ctx;
vm.createContext(ctx);
vm.runInContext(m[1], ctx);
const E = ctx.QDEngine;

let pass = 0, fail = 0;
const rows = [];
function check(name, ok, detail) {
  (ok ? pass++ : fail++);
  rows.push(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  —  ' + detail : ''}`);
}
const pct = (x) => (x * 100).toFixed(1) + '%';

// ---------------------------------------------------------------- Erlang C
function erlangC(c, a) { // a = lambda/mu (offered load in servers)
  let term = 1, sum = 1;
  for (let k = 1; k < c; k++) { term *= a / k; sum += term; }
  const last = term * a / c;            // a^c / c!
  const top = last * c / (c - a);
  return top / (sum + top);
}

// Single-stage M/M/c check. Uses the full engine with the other stage switched off,
// exponential service, no revisions, no starting backlog, a long horizon, and a warm-up cut.
function mmcCheck(stage, c, rho, meanH) {
  const H = 5.5, weeks = 1500, warmWeeks = 50, reps = 6;
  const lambdaPerHour = rho * c / meanH;
  const p = E.withDefaults({
    weekly: lambdaPerHour * 5 * H, open: 0, mixS: 100, mixT: 0, mixE: 0,
    hS: stage === 'quote' ? meanH : 0, intakeMin: stage === 'intake' ? meanH * 60 : 0,
    revRate: 0, nIntake: stage === 'intake' ? c : 1, nQuoters: stage === 'quote' ? c : 1,
    hoursPerDay: H, weeks, dist: 'exp', seed: 7
  });
  const T = weeks * 5 * H, warm = warmWeeks * 5 * H;
  let n = 0, sumW = 0, nWait = 0;
  for (let r = 0; r < reps; r++) {
    const J = E.generateJobs(p, r);
    const res = E.simulate(J, p.nIntake, p.nQuoters, p, { collect: true });
    for (let i = 0; i < J.n; i++) {
      const a = J.arr[i];
      if (a < warm || a >= T) continue;
      const w = stage === 'intake' ? res.start1[i] - a : res.start2[i] - a;
      n++; sumW += w; if (w > 1e-9) nWait++;
    }
  }
  const mu = 1 / meanH, a = lambdaPerHour / mu;
  const C = erlangC(c, a), Wq = C / (c * mu - lambdaPerHour);
  const simWq = sumW / n, simPw = nWait / n;
  const errW = Math.abs(simWq - Wq) / Wq, errP = Math.abs(simPw - C) / C;
  return { stage, c, rho, Wq, simWq, C, simPw, errW, errP, n };
}

const tol = 0.05;
const mmcCases = [
  ['quote', 1, 0.70, 3], ['quote', 3, 0.85, 3], ['quote', 7, 0.80, 2.3], ['quote', 10, 0.90, 4],
  ['intake', 1, 0.80, 25 / 60], ['intake', 2, 0.90, 25 / 60]
];
rows.push('--- Erlang C (M/M/c) vs simulation: mean wait in queue Wq, probability of waiting P(W>0) ---');
for (const cs of mmcCases) {
  const r = mmcCheck(...cs);
  check(`M/M/${r.c} ${r.stage} stage, ρ=${r.rho}`,
    r.errW < tol && r.errP < tol,
    `Wq analytic ${r.Wq.toFixed(3)} h vs sim ${r.simWq.toFixed(3)} h (${pct(r.errW)} off); ` +
    `P(wait) analytic ${pct(r.C)} vs sim ${pct(r.simPw)} (${pct(r.errP)} off); n=${r.n.toLocaleString()}`);
}

// ---------------------------------------------------------------- Default load arithmetic
rows.push('--- Default scenario ---');
const L = E.loads(E.withDefaults({}));
check('Default quoting load ≈ 78.9%', Math.abs(L.quote - 151.8 / 192.5) < 1e-9, pct(L.quote));
check('Default intake load ≈ 90.9%', Math.abs(L.intake - 25 / 27.5) < 1e-9, pct(L.intake));

const t0 = Date.now();
const R = E.run({});
const ms = Date.now() - t0;
check('Default run completes quickly (< 3 s in Node)', ms < 3000, `${ms} ms`);
check('Default bottleneck flagged as intake', R.bottleneck === 'intake', R.bottleneck);
rows.push(`      baseline:  on-time ${pct(R.base.onTime)}, mean ${R.base.meanTat.toFixed(2)} d, P90 ${R.base.p90Tat.toFixed(2)} d, open at wk13 ${R.base.endBacklog}`);
rows.push(`      +1 intake: on-time ${pct(R.plusIntake.onTime)}, mean ${R.plusIntake.meanTat.toFixed(2)} d, P90 ${R.plusIntake.p90Tat.toFixed(2)} d, open at wk13 ${R.plusIntake.endBacklog}`);
rows.push(`      +1 quoter: on-time ${pct(R.plusQuoter.onTime)}, mean ${R.plusQuoter.meanTat.toFixed(2)} d, P90 ${R.plusQuoter.p90Tat.toFixed(2)} d, open at wk13 ${R.plusQuoter.endBacklog}`);
rows.push(`      staff needed for 90%: ${R.need ? R.need.c1 + ' intake + ' + R.need.c2 + ' quoters (' + pct(R.need.onTime) + ')' : 'not reachable'}`);
rows.push(`      verdict: "${R.verdict}"`);

// ---------------------------------------------------------------- Reproducibility
const R2 = E.run({});
check('Same inputs + seed give identical results',
  R2.base.onTime === R.base.onTime && R2.base.p90Tat === R.base.p90Tat && R2.plusQuoter.onTime === R.plusQuoter.onTime);

// ---------------------------------------------------------------- Sanity: zero demand
rows.push('--- Sanity checks ---');
const Z = E.run({ weekly: 0, open: 0 });
const zMax = Math.max(...Z.base.backlog.p90);
check('0 RFQs (and 0 open) → 0 backlog every day', zMax === 0 && Z.base.count === 0, `max open = ${zMax}, quotes = ${Z.base.count}`);
const Z2 = E.run({ weekly: 0, open: 30 });
check('0 new RFQs, 30 open → backlog drains to 0', Z2.base.endBacklog === 0 && Z2.base.backlog.p50[0] === 30,
  `start ${Z2.base.backlog.p50[0]}, week-13 ${Z2.base.endBacklog}`);

// ---------------------------------------------------------------- Sanity: overload
function weekly(bl) { const out = []; for (let w = 1; w <= 13; w++) out.push(bl[w * 5]); return out; }
const O = E.run({ nQuoters: 5 }); // quoting load = 151.8 / 137.5 = 110%
const ow = weekly(O.base.backlog.p50);
let growing = true; for (let i = 4; i < 13; i++) if (ow[i] <= ow[i - 1]) growing = false;
check(`Quoting load ${pct(O.loads.quote)} → backlog grows every week (wk4→wk13)`, growing && ow[12] > ow[3] * 1.5,
  `median open by week: ${ow.join(', ')}`);
const O2 = E.run({ nIntake: 1, intakeMin: 33 }); // intake load = 33/27.5*... = 120%
const ow2 = weekly(O2.base.backlog.p50);
let growing2 = true; for (let i = 4; i < 13; i++) if (ow2[i] <= ow2[i - 1]) growing2 = false;
check(`Intake load ${pct(O2.loads.intake)} → backlog grows every week (wk4→wk13)`, growing2 && ow2[12] > ow2[3] * 1.5,
  `median open by week: ${ow2.join(', ')}`);
const U = E.run({ nIntake: 2, nQuoters: 10 });
const uw = weekly(U.base.backlog.p50);
check('Comfortable load (45% / 55%) → backlog stays flat', Math.max(...uw.slice(3)) - Math.min(...uw.slice(3)) <= 4,
  `median open by week: ${uw.join(', ')}`);

// ---------------------------------------------------------------- Sanity: more staff never worse
// Same random RFQs across staffing levels (common random numbers), so differences are purely due to staffing.
rows.push('--- Monotonicity: adding staff should not make results worse ---');
const sweeps = [
  {}, { weekly: 40 }, { weekly: 80 }, { weekly: 100, intakeMin: 15 }, { mixS: 30, mixT: 40, mixE: 30 },
  { cv: 2 }, { cv: 0.3 }, { revRate: 50 }, { slaDays: 1 }, { slaDays: 5 }, { open: 150 }, { hoursPerDay: 4 }
];
const v = { quoter: { n: 0, bad: 0, worst: '' }, intakeOk: { n: 0, bad: 0, maxDrop: 0, maxRise: 0, worst: '' },
            intakeOver: { n: 0, bad: 0, maxDrop: 0, worst: '' }, any: { n: 0, bad: 0 }, newRfq: { n: 0, maxDrop: 0, worst: '' } };
for (const s of sweeps) {
  const p = E.withDefaults(Object.assign({ reps: 200 }, s));
  const L = E.loads(p);
  const jobs = []; for (let r = 0; r < p.reps; r++) jobs.push(E.generateJobs(p, r));
  const memo = {};
  const sc = (a, b) => memo[a + ',' + b] || (memo[a + ',' + b] = E.runScenario(jobs, a, b, p, true));
  for (let c1 = 1; c1 <= 3; c1++) for (let c2 = 4; c2 <= 11; c2++) for (const [d1, d2] of [[1, 0], [0, 1]]) {
    if (c1 + d1 > 3 || c2 + d2 > 11) continue;
    const a = sc(c1, c2), b = sc(c1 + d1, c2 + d2);
    const drop = a.onTime - b.onTime, rise = (b.meanTat - a.meanTat) / a.meanTat;
    const worse = drop > 1e-12 || rise > 1e-12;
    const desc = `${JSON.stringify(s)} ${c1}+${c2}→${c1 + d1}+${c2 + d2}: on-time ${pct(a.onTime)}→${pct(b.onTime)}, mean ${a.meanTat.toFixed(2)}→${b.meanTat.toFixed(2)} d`;
    v.any.n++; if (worse) v.any.bad++;
    if (d1) { v.newRfq.n++; const nd = a.onTimeNew - b.onTimeNew; if (nd > v.newRfq.maxDrop) { v.newRfq.maxDrop = nd; v.newRfq.worst = desc + ` (new RFQs ${pct(a.onTimeNew)}→${pct(b.onTimeNew)})`; } }
    if (d2) { v.quoter.n++; if (worse) { v.quoter.bad++; v.quoter.worst = desc; } continue; }
    const quoteOverAfter = L.at(c1 + 1, c2).quote >= 1;
    const g = quoteOverAfter ? v.intakeOver : v.intakeOk;
    g.n++;
    if (worse) {
      g.bad++;
      if (drop > g.maxDrop) { g.maxDrop = drop; g.worst = desc; }
      if (g.maxRise !== undefined && rise > g.maxRise) g.maxRise = rise;
    }
  }
}
check(`+1 quoter never makes on-time % or mean turnaround worse (${v.quoter.n} comparisons)`,
  v.quoter.bad === 0, `${v.quoter.bad} cases worse${v.quoter.worst ? '; e.g. ' + v.quoter.worst : ''}`);
check(`+1 intake, quoting under 100% after hire: never worse beyond noise (≤0.1 pt on-time, ≤0.5% mean) (${v.intakeOk.n} comparisons)`,
  v.intakeOk.maxDrop <= 0.001 && v.intakeOk.maxRise <= 0.005,
  `${v.intakeOk.bad} cases slightly worse; max on-time drop ${(v.intakeOk.maxDrop * 100).toFixed(2)} pt, max mean rise ${(v.intakeOk.maxRise * 100).toFixed(2)}%`);
check(`+1 intake never lowers on-time % for NEW RFQs beyond noise (≤0.1 pt), even when overloaded (${v.newRfq.n} comparisons)`,
  v.newRfq.maxDrop <= 0.001, `max drop ${(v.newRfq.maxDrop * 100).toFixed(2)} pt${v.newRfq.worst ? '; worst: ' + v.newRfq.worst : ''}`);
rows.push(`NOTE  Strict "any hire never worse": ${v.any.bad} of ${v.any.n} comparisons worse. Every one is a +1 intake case.`);
rows.push(`NOTE  +1 intake while quoting stays ≥100% overloaded: ${v.intakeOver.bad} of ${v.intakeOver.n} worse; max on-time drop ${(v.intakeOver.maxDrop * 100).toFixed(2)} pt (${v.intakeOver.worst}).`);
rows.push('      Cause: revisions and already-open RFQs skip intake. When intake is the jam they bypass the queue; relieving');
rows.push('      intake moves the queue into quoting, where they must now wait. New RFQs still improve. This is a property');
rows.push('      of the model as specified, not a coding error. See the report.');

// What-if columns and staff-needed respect the goal
check('Staff-needed result actually meets the goal', R.need && R.need.onTime >= 0.9, R.need && pct(R.need.onTime));
const dec = E.runScenario(Array.from({ length: 200 }, (_, r) => E.generateJobs(E.withDefaults({}), r)),
  R.need.c1, R.need.c2 - 1, E.withDefaults({}), false);
const dec1 = R.need.c1 > 1 ? E.runScenario(Array.from({ length: 200 }, (_, r) => E.generateJobs(E.withDefaults({}), r)),
  R.need.c1 - 1, R.need.c2, E.withDefaults({}), false) : { onTime: 0 };
check('Staff-needed is minimal (removing anyone drops below goal)', dec.onTime < 0.9 && dec1.onTime < 0.9,
  `−1 quoter: ${pct(dec.onTime)}, −1 intake: ${pct(dec1.onTime)}`);

console.log(rows.join('\n'));
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
