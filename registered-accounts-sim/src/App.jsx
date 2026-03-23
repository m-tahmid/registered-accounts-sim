import { useState, useMemo, useEffect, useRef } from "react";
import logoSrc from "../images/logo.png";

function useWindowWidth() {
  const [w, setW] = useState(() => (typeof window !== "undefined" ? window.innerWidth : 1280));
  useEffect(() => {
    const h = () => setW(window.innerWidth);
    window.addEventListener("resize", h);
    return () => window.removeEventListener("resize", h);
  }, []);
  return w;
}

// Ontario 2026 combined federal + provincial marginal brackets
const BRACKETS = [
  [17000, 0.00], [49958, 0.2005], [57375, 0.2415],
  [100392, 0.3148], [111733, 0.3748], [150000, 0.4341],
  [155625, 0.4441], [220000, 0.4897], [Infinity, 0.5353],
];

function getMarginalRate(income) {
  if (income <= 0) return 0;
  for (const [limit, rate] of BRACKETS) if (income <= limit) return rate;
  return 0.5353;
}

function calcTax(income) {
  if (income <= 0) return 0;
  let tax = 0, prev = 0;
  for (const [limit, rate] of BRACKETS) {
    if (income <= prev) break;
    tax += (Math.min(income, limit) - prev) * rate;
    prev = limit;
  }
  return tax;
}

function getRRSPLimit(income) {
  return Math.min(Math.max(income, 0) * 0.18, 31560);
}

function fmt(n, compact = false) {
  if (!isFinite(n) || isNaN(n)) return "$0";
  if (compact && Math.abs(n) >= 1000000) return "$" + (n / 1000000).toFixed(2) + "M";
  if (compact && Math.abs(n) >= 1000) return "$" + Math.round(n / 1000) + "K";
  return "$" + Math.round(n).toLocaleString("en-CA");
}

function pct(n) { return (n * 100).toFixed(1) + "%"; }

function runSimulation(incomePhases, withdrawalPhases, returnRate, splitCount, existingRRSPRoom = 0, existingRRSPBal = 0) {
  // Build year-by-year income schedule
  const incomeSchedule = [];
  for (const p of incomePhases) {
    for (let y = 0; y < p.years; y++) incomeSchedule.push(p.income);
  }
  const totalYears = incomeSchedule.length;
  if (totalYears === 0) return null;

  // ── S1: RRSP — claim refund immediately every year ──────────────────────────
  // Invest: RRSP contribution + refund (marginalRate × contrib) both go into RRSP
  const s1Years = [];
  let s1Bal = existingRRSPBal;
  for (let i = 0; i < totalYears; i++) {
    const income = incomeSchedule[i];
    const roomContrib = i === 0 ? existingRRSPRoom : 0;
    const contrib = getRRSPLimit(income) + roomContrib;
    const marginal = getMarginalRate(income);
    const refund = contrib * marginal;
    const invested = contrib + refund;
    const growth = (s1Bal + invested) * returnRate;
    s1Bal = (s1Bal + invested) * (1 + returnRate);
    s1Years.push({ year: i+1, income, contrib, refund, invested, growth, balance: s1Bal, marginal });
  }

  // ── S2: RRSP — hold deductions, claim evenly in highest-income years ────────
  // Contribute every year. During low/mid years: do NOT claim deduction (pool grows).
  // Once in highest-income phase: claim equal share of prior pool each year + that year's contrib.
  // This maximizes refund rate (highest marginal) without any single-year lump-sum spike.
  const maxIncome = Math.max(...incomeSchedule);
  const highIndices = incomeSchedule.reduce((a, inc, i) => { if (inc === maxIncome) a.push(i); return a; }, []);
  const highPhaseStart = highIndices.length > 0 ? highIndices[0] : totalYears;
  const numHighYears = highIndices.length;

  let poolBeforeHigh = highPhaseStart > 0 ? existingRRSPRoom : 0;
  for (let i = 0; i < highPhaseStart; i++) poolBeforeHigh += getRRSPLimit(incomeSchedule[i]);
  const priorClaimPerYear = numHighYears > 0 ? poolBeforeHigh / numHighYears : 0;

  const s2Years = [];
  let s2Bal = existingRRSPBal, deductionPool = 0;
  for (let i = 0; i < totalYears; i++) {
    const income = incomeSchedule[i];
    const roomContrib = i === 0 ? existingRRSPRoom : 0;
    const contrib = getRRSPLimit(income) + roomContrib;
    const isHigh = income === maxIncome;
    deductionPool += contrib;

    let claimed = 0, refund = 0;
    if (isHigh) {
      const priorClaim = Math.min(priorClaimPerYear, Math.max(deductionPool - contrib, 0));
      claimed = Math.min(priorClaim + contrib, deductionPool);
      const taxableIncome = Math.max(income - claimed, 0);
      refund = calcTax(income) - calcTax(taxableIncome);
      deductionPool -= claimed;
    }

    const growth = (s2Bal + contrib + refund) * returnRate;
    s2Bal = (s2Bal + contrib) * (1 + returnRate);
    if (refund > 0) s2Bal += refund * (1 + returnRate);

    s2Years.push({
      year: i+1, income, contrib, refund, claimed,
      taxableIncome: income - claimed,
      growth, balance: s2Bal,
      marginal: getMarginalRate(Math.max(income - claimed, 0)),
      deductionPool,
    });
  }
  if (deductionPool > 1) {
    const lastInc = incomeSchedule[totalYears - 1];
    const extraRefund = calcTax(lastInc) - calcTax(Math.max(lastInc - deductionPool, 0));
    s2Bal += extraRefund;
    s2Years[totalYears-1].claimed += deductionPool;
    s2Years[totalYears-1].refund += extraRefund;
    s2Years[totalYears-1].deductionPool = 0;
  }

  // ── S3: Non-reg — invest same dollar amount as RRSP contribution ────────────
  // Fair comparison: both scenarios use the same gross dollars (RRSP room amount).
  // Non-reg person invests that amount into a taxable account each year.
  // No deduction, no refund. Cost base = everything invested. 
  // On withdrawal: only the GAIN portion is taxed, at 50% inclusion rate.
  const s3Years = [];
  let nrFMV = 0, nrCost = 0;
  for (let i = 0; i < totalYears; i++) {
    const income = incomeSchedule[i];
    const roomContrib = i === 0 ? existingRRSPRoom : 0;
    const contrib = getRRSPLimit(income) + roomContrib;
    const growth = (nrFMV + contrib) * returnRate;
    nrCost += contrib;
    nrFMV = (nrFMV + contrib) * (1 + returnRate);
    s3Years.push({
      year: i+1, income, grossContrib: contrib, afterTax: contrib,
      growth, balance: nrFMV, costBase: nrCost, gain: nrFMV - nrCost,
      marginal: getMarginalRate(income),
    });
  }

  // ── Withdrawal simulation ───────────────────────────────────────────────────
  // Model: each year, withdraw requested amount from account.
  // Tax is calculated ONLY on that year's withdrawal amount.
  // Remaining balance grows at returnRate between withdrawals.
  // After all scheduled withdrawals, any leftover balance is taxed as a final lump.
  const withdrawSchedule = [];
  for (const p of withdrawalPhases) {
    for (let y = 0; y < p.years; y++) withdrawSchedule.push(p.annualAmount);
  }

  // ── Until-depletion simulations ─────────────────────────────────────────────
  // Uses the same annual withdrawal amount as the first withdrawal phase,
  // keeps withdrawing until balance hits zero.
  const annualWithdrawal = withdrawSchedule.length > 0 ? withdrawSchedule[0] : 0;

  const simRRSPDepletion = (startBal) => {
    let bal = startBal;
    let totalTax = 0;
    const wYears = [];
    let yr = 1;
    while (bal > 0 && yr <= 200) {
      const startBalance = bal;
      const withdrawn = Math.min(annualWithdrawal, bal);
      const perPerson = withdrawn / splitCount;
      const taxThisYear = calcTax(perPerson) * splitCount;
      const netInHand = withdrawn - taxThisYear;
      totalTax += taxThisYear;
      bal -= withdrawn;
      bal = Math.max(bal, 0) * (1 + returnRate);
      wYears.push({ year: yr, withdrawal: withdrawn, tax: taxThisYear, net: netInHand, effectiveRate: withdrawn > 0 ? taxThisYear/withdrawn : 0, marginalRate: getMarginalRate(perPerson), startBalance, endBalance: bal });
      yr++;
    }
    return { wYears, totalTax, yearsToDepletion: wYears.length, totalWithdrawn: wYears.reduce((a,y)=>a+y.withdrawal,0), totalNet: wYears.reduce((a,y)=>a+y.net,0) };
  };

  const simNRDepletion = (startFMV, startCost) => {
    let fmv = startFMV, cost = startCost;
    let totalTax = 0;
    const wYears = [];
    let yr = 1;
    while (fmv > 0 && yr <= 200) {
      const startBalance = fmv;
      const withdrawn = Math.min(annualWithdrawal, fmv);
      const gainFrac = fmv > 0 ? Math.max(fmv - cost, 0) / fmv : 0;
      const gainPortion = withdrawn * gainFrac;
      const principalPortion = withdrawn - gainPortion;
      const taxablePerPerson = (gainPortion * 0.5) / splitCount;
      const taxThisYear = getMarginalRate(taxablePerPerson) * taxablePerPerson * splitCount;
      const netInHand = withdrawn - taxThisYear;
      totalTax += taxThisYear;
      cost = Math.max(cost - principalPortion, 0);
      fmv -= withdrawn;
      fmv = Math.max(fmv, 0) * (1 + returnRate);
      wYears.push({ year: yr, withdrawal: withdrawn, tax: taxThisYear, net: netInHand, effectiveRate: withdrawn > 0 ? taxThisYear/withdrawn : 0, marginalRate: getMarginalRate(taxablePerPerson), gainPortion, startBalance, endBalance: fmv });
      yr++;
    }
    return { wYears, totalTax, yearsToDepletion: wYears.length, totalWithdrawn: wYears.reduce((a,y)=>a+y.withdrawal,0), totalNet: wYears.reduce((a,y)=>a+y.net,0) };
  };

  const d1 = simRRSPDepletion(s1Bal);
  const d2 = simRRSPDepletion(s2Bal);
  const d3 = simNRDepletion(nrFMV, nrCost);

  const simRRSPWithdrawals = (startBal) => {
    let bal = startBal;
    let totalTax = 0;
    const wYears = [];
    for (let i = 0; i < withdrawSchedule.length; i++) {
      const startBalance = bal;
      // Grow balance at start of year before withdrawal (beginning-of-year growth)
      // Actually: end-of-year model — withdraw first, remainder grows
      const requested = withdrawSchedule[i];
      const withdrawn = Math.min(requested, Math.max(bal, 0));
      // Tax only on what's actually withdrawn, split across persons
      const perPerson = withdrawn / splitCount;
      const taxThisYear = calcTax(perPerson) * splitCount;
      const netInHand = withdrawn - taxThisYear;
      totalTax += taxThisYear;
      bal -= withdrawn;
      bal = Math.max(bal, 0) * (1 + returnRate); // remainder grows
      wYears.push({
        year: i+1,
        withdrawal: withdrawn,
        tax: taxThisYear,
        net: netInHand,
        effectiveRate: withdrawn > 0 ? taxThisYear / withdrawn : 0,
        marginalRate: getMarginalRate(perPerson),
        startBalance,
        endBalance: bal,
      });
    }
    // Final balance: tax it as a lump withdrawal
    let finalTax = 0;
    if (bal > 0) {
      const perPerson = bal / splitCount;
      finalTax = calcTax(perPerson) * splitCount;
      totalTax += finalTax;
    }
    const afterTax = startBal - totalTax + (bal - (bal > 0 ? bal : 0));
    // Correct after-tax: total money received net of tax
    // = sum of all net withdrawals + (finalBal - finalTax)
    const totalNetWithdrawals = wYears.reduce((a, y) => a + y.net, 0);
    const finalNet = Math.max(bal - finalTax, 0);
    return {
      afterTax: totalNetWithdrawals + finalNet,
      netWithdrawals: totalNetWithdrawals,
      tax: totalTax,
      wYears,
      finalBalance: bal,
      finalTax,
    };
  };

  const simNRWithdrawals = (startFMV, startCost) => {
    let fmv = startFMV;
    let cost = startCost;
    let totalTax = 0;
    const wYears = [];
    for (let i = 0; i < withdrawSchedule.length; i++) {
      const startBalance = fmv;
      const requested = withdrawSchedule[i];
      const withdrawn = Math.min(requested, Math.max(fmv, 0));
      // Gain fraction of this withdrawal
      const gainFrac = fmv > 0 ? Math.max(fmv - cost, 0) / fmv : 0;
      const gainPortion = withdrawn * gainFrac;
      const principalPortion = withdrawn - gainPortion;
      // Tax: 50% of gain included in income, taxed at marginal rate per person
      const taxablePerPerson = (gainPortion * 0.5) / splitCount;
      const taxThisYear = getMarginalRate(taxablePerPerson) * taxablePerPerson * splitCount;
      const netInHand = withdrawn - taxThisYear;
      totalTax += taxThisYear;
      // Update cost base proportionally
      cost = Math.max(cost - principalPortion, 0);
      fmv -= withdrawn;
      fmv = Math.max(fmv, 0) * (1 + returnRate);
      // Grow cost base too (new cost base for new year = old remaining cost, gains compound untaxed)
      wYears.push({
        year: i+1,
        withdrawal: withdrawn,
        tax: taxThisYear,
        net: netInHand,
        effectiveRate: withdrawn > 0 ? taxThisYear / withdrawn : 0,
        marginalRate: getMarginalRate(taxablePerPerson),
        gainPortion,
        startBalance,
        endBalance: fmv,
      });
    }
    // Final balance: tax remaining gain
    let finalTax = 0;
    if (fmv > 0) {
      const gainFrac = fmv > 0 ? Math.max(fmv - cost, 0) / fmv : 0;
      const gainPortion = fmv * gainFrac;
      const taxablePerPerson = (gainPortion * 0.5) / splitCount;
      finalTax = getMarginalRate(taxablePerPerson) * taxablePerPerson * splitCount;
      totalTax += finalTax;
    }
    const totalNetWithdrawals = wYears.reduce((a, y) => a + y.net, 0);
    const finalNet = Math.max(fmv - finalTax, 0);
    return {
      afterTax: totalNetWithdrawals + finalNet,
      netWithdrawals: totalNetWithdrawals,
      tax: totalTax,
      wYears,
      finalBalance: fmv,
      finalTax,
    };
  };

  const r1 = simRRSPWithdrawals(s1Bal);
  const r2 = simRRSPWithdrawals(s2Bal);
  const r3 = simNRWithdrawals(nrFMV, nrCost);
  const totalContrib = incomeSchedule.reduce((a, inc) => a + getRRSPLimit(inc), 0) + existingRRSPRoom;

  return {
    s1: { label: "RRSP — Claim Immediately", gross: s1Bal, afterTax: r1.afterTax, tax: r1.tax, contrib: totalContrib, years: s1Years, wYears: r1.wYears, finalBalance: r1.finalBalance, finalTax: r1.finalTax, depletion: d1, color: "#4fc3f7" },
    s2: { label: "RRSP — Optimized Deferred", gross: s2Bal, afterTax: r2.afterTax, tax: r2.tax, contrib: totalContrib, years: s2Years, wYears: r2.wYears, finalBalance: r2.finalBalance, finalTax: r2.finalTax, depletion: d2, color: "#a78bfa" },
    s3: { label: "Non-Reg — Same Contribution", gross: nrFMV, afterTax: r3.afterTax, tax: r3.tax, contrib: nrCost, years: s3Years, wYears: r3.wYears, finalBalance: r3.finalBalance, finalTax: r3.finalTax, depletion: d3, color: "#34d399" },
    incomeSchedule,
  };
}

// ─── TFSA ─────────────────────────────────────────────────────────────────────

const TFSA_LIMITS = {
  2009: 5000, 2010: 5000, 2011: 5000, 2012: 5000,
  2013: 5500, 2014: 5500, 2015: 10000,
  2016: 5500, 2017: 5500, 2018: 5500,
  2019: 6000, 2020: 6000, 2021: 6000, 2022: 6000,
  2023: 6500, 2024: 7000, 2025: 7000, 2026: 7000,
};
const TFSA_FUTURE_ANNUAL = 7000;
const CURRENT_YEAR = new Date().getFullYear();

function getTFSAEligibleYear(birthYear, residentSinceYear) {
  const ageEligible = birthYear + 18;
  const residentEligible = residentSinceYear ?? ageEligible;
  return Math.max(2009, Math.max(ageEligible, residentEligible));
}

function getTFSAAccumulatedRoom(birthYear, residentSinceYear) {
  const eligibleYear = getTFSAEligibleYear(birthYear, residentSinceYear);
  let room = 0;
  for (let y = eligibleYear; y <= CURRENT_YEAR; y++) {
    room += TFSA_LIMITS[y] ?? TFSA_FUTURE_ANNUAL;
  }
  return room;
}

function runTFSASimulation(birthYear, residentSinceYear, contribPhases, withdrawalPhases, returnRate, existingBal = 0) {
  const accumulatedRoom = getTFSAAccumulatedRoom(birthYear, residentSinceYear);
  const eligibleYear = getTFSAEligibleYear(birthYear, residentSinceYear);

  const contribSchedule = [];
  for (const p of contribPhases) for (let y = 0; y < p.years; y++) contribSchedule.push(p.annualAmount);
  const totalYears = contribSchedule.length;
  if (totalYears === 0) return null;

  let bal = existingBal, availableRoom = accumulatedRoom;
  const accumYears = [];
  for (let i = 0; i < totalYears; i++) {
    const calYear = CURRENT_YEAR + i + 1;
    const newRoom = i === 0 ? 0 : (calYear >= eligibleYear ? (TFSA_LIMITS[calYear] ?? TFSA_FUTURE_ANNUAL) : 0);
    availableRoom += newRoom;
    const contrib = Math.min(contribSchedule[i], availableRoom);
    availableRoom -= contrib;
    const growth = (bal + contrib) * returnRate;
    bal = (bal + contrib) * (1 + returnRate);
    accumYears.push({ year: i + 1, calYear, contribution: contrib, roomLeft: availableRoom, newRoom, growth, balance: bal });
  }
  const finalAccumBal = bal;

  const withdrawSchedule = [];
  for (const p of withdrawalPhases) for (let y = 0; y < p.years; y++) withdrawSchedule.push(p.annualAmount);
  let wBal = finalAccumBal;
  const wYears = [];
  for (let i = 0; i < withdrawSchedule.length; i++) {
    const startBalance = wBal;
    const withdrawn = Math.min(withdrawSchedule[i], Math.max(wBal, 0));
    wBal = Math.max(wBal - withdrawn, 0) * (1 + returnRate);
    wYears.push({ year: i + 1, withdrawal: withdrawn, net: withdrawn, startBalance, endBalance: wBal });
  }

  const annualWithdrawal = withdrawSchedule.length > 0 ? withdrawSchedule[0] : 0;
  let dBal = finalAccumBal;
  const depYears = [];
  for (let yr = 1; dBal > 0 && yr <= 200; yr++) {
    const startBalance = dBal;
    const withdrawn = Math.min(annualWithdrawal, dBal);
    dBal = Math.max(dBal - withdrawn, 0) * (1 + returnRate);
    depYears.push({ year: yr, withdrawal: withdrawn, net: withdrawn, startBalance, endBalance: dBal });
  }

  return {
    accumulatedRoom, eligibleYear, finalAccumBal, accumYears, wYears,
    finalWBal: wBal,
    totalContrib: accumYears.reduce((a, y) => a + y.contribution, 0),
    totalWithdrawn: wYears.reduce((a, y) => a + y.withdrawal, 0),
    depletion: {
      wYears: depYears, yearsToDepletion: depYears.length,
      totalNet: depYears.reduce((a, y) => a + y.net, 0),
    },
  };
}

// ─── RESP ─────────────────────────────────────────────────────────────────────

const RESP_COLOR = "#f472b6";
const CESG_ANNUAL_CONTRIB_MAX = 2500;
const CESG_ANNUAL_MAX = 500;
const CESG_LIFETIME_MAX = 7200;
const RESP_CONTRIB_LIFETIME_MAX = 50000;

function runRESPSimulation(childBirthYear, contribPhases, returnRate, existingBal = 0, existingCESG = 0, existingContrib = 0) {
  const contribSchedule = [];
  for (const p of contribPhases) for (let y = 0; y < p.years; y++) contribSchedule.push(p.annualAmount);
  const totalYears = contribSchedule.length;
  if (totalYears === 0) return null;

  let bal = existingBal;
  let totalContributed = existingContrib;
  let cesgTotal = existingCESG;
  const accumYears = [];

  // Pre-birth rows: show from current year with $0 contribution
  const contribStartYear = Math.max(CURRENT_YEAR + 1, childBirthYear);
  for (let calYear = CURRENT_YEAR + 1; calYear < contribStartYear; calYear++) {
    const childAge = calYear - childBirthYear;
    const growth = bal * returnRate;
    bal = bal * (1 + returnRate);
    accumYears.push({ year: calYear - CURRENT_YEAR, calYear, childAge, contribution: 0, cesg: 0, growth, balance: bal, totalCESG: cesgTotal, totalContrib: totalContributed });
  }

  for (let i = 0; i < totalYears; i++) {
    const calYear = contribStartYear + i;
    const childAge = calYear - childBirthYear;
    const contrib = Math.min(contribSchedule[i], Math.max(RESP_CONTRIB_LIFETIME_MAX - totalContributed, 0));
    totalContributed += contrib;

    let cesg = 0;
    if (childAge <= 17 && cesgTotal < CESG_LIFETIME_MAX && contrib > 0) {
      cesg = Math.min(Math.min(contrib, CESG_ANNUAL_CONTRIB_MAX) * 0.20, CESG_LIFETIME_MAX - cesgTotal);
      cesgTotal += cesg;
    }

    const growth = (bal + contrib + cesg) * returnRate;
    bal = (bal + contrib + cesg) * (1 + returnRate);
    accumYears.push({ year: calYear - CURRENT_YEAR, calYear, childAge, contribution: contrib, cesg, growth, balance: bal, totalCESG: cesgTotal, totalContrib: totalContributed });
  }

  const newContrib = totalContributed - existingContrib;
  const newCESG = cesgTotal - existingCESG;
  const contribPortion = Math.min(totalContributed, bal);
  const eapPortion = Math.max(bal - totalContributed, 0);

  return { accumYears, finalBal: bal, totalContrib: newContrib, newCESG, totalCESG: cesgTotal, contribPortion, eapPortion };
}

function runNonRegRESP(childBirthYear, contribPhases, returnRate, existingBal = 0, existingContrib = 0) {
  const contribSchedule = [];
  for (const p of contribPhases) for (let y = 0; y < p.years; y++) contribSchedule.push(p.annualAmount);
  if (contribSchedule.length === 0) return null;

  const contribStartYear = Math.max(CURRENT_YEAR + 1, childBirthYear);
  let bal = existingBal;
  let totalContributed = existingContrib;

  for (let calYear = CURRENT_YEAR + 1; calYear < contribStartYear; calYear++) {
    bal = bal * (1 + returnRate);
  }
  for (const contrib of contribSchedule) {
    totalContributed += contrib;
    bal = (bal + contrib) * (1 + returnRate);
  }

  const newContrib = totalContributed - existingContrib;
  const gain = Math.max(bal - existingBal - newContrib, 0);
  return { finalBal: bal, totalContrib: newContrib, gain };
}

// ─── UI Components ────────────────────────────────────────────────────────────

function NumInput({ value, onChange, prefix, suffix, step = 1000, min = 0, max = Infinity, width = 140 }) {
  const [local, setLocal] = useState(String(value));
  const isFocused = useRef(false);

  useEffect(() => {
    if (!isFocused.current) setLocal(String(value));
  }, [value]);

  const commit = raw => {
    const n = parseFloat(raw);
    if (!isFinite(n)) { setLocal(String(value)); return; }
    const clamped = Math.min(max === Infinity ? n : max, Math.max(min, n));
    setLocal(String(clamped));
    onChange(clamped);
  };

  const btnStyle = {
    display: "flex", flexDirection: "column", justifyContent: "center",
    background: "#12122a", border: "1px solid #252540", cursor: "pointer",
    padding: "0 5px", gap: 1, alignSelf: "stretch",
  };
  const arrowStyle = { color: "#444", fontSize: 8, lineHeight: 1, userSelect: "none" };
  return (
    <div style={{ display: "inline-flex", alignItems: "stretch", background: "#0a0a18", border: "1px solid #252540", borderRadius: 6, overflow: "hidden" }}>
      {prefix && (
        <span style={{ display: "flex", alignItems: "center", paddingLeft: 10, color: "#555", fontSize: 14, fontFamily: "monospace", pointerEvents: "none", background: "#0a0a18" }}>{prefix}</span>
      )}
      <input
        type="number"
        value={local}
        min={min}
        max={max === Infinity ? undefined : max}
        step={step}
        onChange={e => setLocal(e.target.value)}
        onFocus={() => { isFocused.current = true; }}
        onBlur={() => { isFocused.current = false; commit(local); }}
        onKeyDown={e => { if (e.key === "Enter") { commit(local); e.currentTarget.blur(); } }}
        style={{
          background: "#0a0a18", border: "none",
          color: "#e0e0e0", fontFamily: "'Space Mono',monospace", fontSize: 15,
          padding: prefix ? "9px 6px 9px 4px" : "9px 6px 9px 12px",
          width: width - (suffix ? 52 : 32), outline: "none", boxSizing: "border-box", minWidth: 0,
        }}
      />
      {suffix && (
        <span style={{ display: "flex", alignItems: "center", paddingRight: 8, color: "#555", fontSize: 12, fontFamily: "monospace", pointerEvents: "none", background: "#0a0a18", whiteSpace: "nowrap" }}>{suffix}</span>
      )}
      <div style={{ display: "flex", flexDirection: "column", borderLeft: "1px solid #252540" }}>
        <button onClick={() => onChange(Math.min(max === Infinity ? value + step : max, Math.max(min, value + step)))} style={{ ...btnStyle, borderRadius: 0, borderBottom: "1px solid #252540", flex: 1 }}>
          <span style={arrowStyle}>▲</span>
        </button>
        <button onClick={() => onChange(Math.max(min, value - step))} style={{ ...btnStyle, borderRadius: 0, flex: 1 }}>
          <span style={arrowStyle}>▼</span>
        </button>
      </div>
    </div>
  );
}

function PhaseRow({ phase, index, onUpdate, onRemove, canRemove, type, hint, amountStep }) {
  const isMobile = useWindowWidth() < 640;
  const isIncome = type === "income";
  const val = isIncome ? phase.income : phase.annualAmount;
  const field = isIncome ? "income" : "annualAmount";
  const hintText = isIncome ? `${fmt(getRRSPLimit(val))}/yr · ${pct(getMarginalRate(val))}` : (hint ?? "");
  const step = amountStep ?? 5000;
  if (isMobile) {
    return (
      <div style={{ marginBottom: 10 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <span style={{ fontSize: 12, color: "#3a3a5a", fontFamily: "'Space Mono',monospace", minWidth: 38 }}>Ph {index + 1}</span>
          <NumInput value={val} onChange={v => onUpdate(index, field, v)} prefix="$" step={step} width={130} />
          <span style={{ fontSize: 13, color: "#3a3a5a" }}>×</span>
          <NumInput value={phase.years} onChange={v => onUpdate(index, "years", Math.max(1, v))} suffix="yrs" step={1} min={1} width={100} />
          <div style={{ marginLeft: "auto" }}>
            {canRemove && (
              <button onClick={() => onRemove(index)} style={{ background: "transparent", border: "1px solid #2a1818", borderRadius: 4, color: "#ff6b6b66", cursor: "pointer", fontSize: 13, padding: "4px 9px", fontFamily: "monospace" }}>✕</button>
            )}
          </div>
        </div>
        {hintText && <div style={{ fontSize: 11, color: "#444", fontFamily: "'Space Mono',monospace", paddingLeft: 46, marginTop: 4 }}>{hintText}</div>}
      </div>
    );
  }
  return (
    <div style={{ display: "grid", gridTemplateColumns: "56px 150px 14px 105px 1fr 28px", alignItems: "center", gap: 10, marginBottom: 10 }}>
      <span style={{ fontSize: 13, color: "#3a3a5a", fontFamily: "'Space Mono',monospace" }}>Ph {index + 1}</span>
      <NumInput value={val} onChange={v => onUpdate(index, field, v)} prefix="$" step={step} width={150} />
      <span style={{ fontSize: 13, color: "#3a3a5a", textAlign: "center" }}>×</span>
      <NumInput value={phase.years} onChange={v => onUpdate(index, "years", Math.max(1, v))} suffix="yrs" step={1} min={1} width={105} />
      <span style={{ fontSize: 13, color: "#444", fontFamily: "'Space Mono',monospace" }}>{hintText}</span>
      <div>
        {canRemove && (
          <button onClick={() => onRemove(index)} style={{ background: "transparent", border: "1px solid #2a1818", borderRadius: 4, color: "#ff6b6b66", cursor: "pointer", fontSize: 13, padding: "4px 9px", fontFamily: "monospace" }}>✕</button>
        )}
      </div>
    </div>
  );
}

function ResultCard({ data, rank, max }) {
  const isMobile = useWindowWidth() < 640;
  const pctBar = max > 0 ? (data.afterTax / max) * 100 : 0;
  const gain = data.afterTax - data.contrib;
  return (
    <div style={{ background: "linear-gradient(135deg,#0c0c1c,#10101e)", border: `1px solid ${data.color}1a`, borderLeft: `3px solid ${data.color}`, borderRadius: 10, padding: isMobile ? "16px 14px" : "24px 28px", position: "relative" }}>
      {rank === 1 && <span style={{ position: "absolute", top: 14, right: 18, background: data.color, color: "#000", fontSize: 11, fontWeight: 700, fontFamily: "'Space Mono',monospace", padding: "4px 12px", borderRadius: 20, letterSpacing: 1.5 }}>BEST</span>}
      <div style={{ fontSize: 12, color: data.color, letterSpacing: 3, marginBottom: 16, fontFamily: "'Space Mono',monospace", textTransform: "uppercase" }}>{data.label}</div>
      <div style={{ display: "grid", gridTemplateColumns: isMobile ? "1fr 1fr" : "repeat(3,1fr)", gap: 18, marginBottom: 16 }}>
        {[["Accum. Balance", data.gross, "#bbb"], ["Remaining Bal", data.finalBalance, "#666"]].map(([l, v, c]) => (
          <div key={l} style={{ minWidth: 0 }}>
            <div style={{ fontSize: 12, color: "#3a3a5a", marginBottom: 4, fontFamily: "'Space Mono',monospace" }}>{l}</div>
            <div style={{ fontSize: isMobile ? 18 : 26, fontFamily: "'Playfair Display',serif", color: c, fontWeight: 700, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{fmt(v)}</div>
          </div>
        ))}
      </div>
      <div style={{ background: "#0a0a16", borderRadius: 3, height: 5, overflow: "hidden", marginBottom: 10 }}>
        <div style={{ width: `${pctBar}%`, height: "100%", background: data.color, transition: "width 0.5s" }} />
      </div>
    </div>
  );
}

function WithdrawalTable({ results }) {
  const [activeScenario, setActiveScenario] = useState("s1");
  const [viewMode, setViewMode] = useState("scheduled"); // "scheduled" | "depletion"
  const scenarios = [
    { key: "s1", data: results.s1 },
    { key: "s2", data: results.s2 },
    { key: "s3", data: results.s3 },
  ];
  const active = scenarios.find(s => s.key === activeScenario);
  const { data } = active;
  const isNR = activeScenario === "s3";

  const isDepletion = viewMode === "depletion";
  const depletionData = data.depletion || {};
  const wYears = isDepletion ? (depletionData.wYears || []) : (data.wYears || []);

  const thStyle = {
    fontSize: 12, color: "#444", fontFamily: "'Space Mono',monospace",
    letterSpacing: 1, padding: "10px 16px", textAlign: "right",
    borderBottom: "1px solid #1a1a2e", whiteSpace: "nowrap",
  };
  const tdStyle = {
    fontSize: 14, fontFamily: "'Space Mono',monospace",
    padding: "9px 16px", textAlign: "right",
    borderBottom: "1px solid #111120",
  };

  const totalWithdrawn = wYears.reduce((a, y) => a + y.withdrawal, 0);
  const totalTax = wYears.reduce((a, y) => a + y.tax, 0);
  const avgEffRate = totalWithdrawn > 0 ? totalTax / totalWithdrawn : 0;

  return (
    <div style={{ background: "#0b0b1a", border: "1px solid #1c1c32", borderRadius: 12, overflow: "hidden" }}>
      {/* Scenario tabs */}
      <div style={{ display: "flex", borderBottom: "1px solid #1c1c32" }}>
        {scenarios.map(({ key, data: d }) => (
          <button key={key} onClick={() => setActiveScenario(key)} style={{
            flex: 1, padding: "16px 10px", cursor: "pointer", fontFamily: "'Space Mono',monospace",
            fontSize: 13, letterSpacing: 1, transition: "all 0.2s", border: "none",
            borderBottom: activeScenario === key ? `2px solid ${d.color}` : "2px solid transparent",
            background: activeScenario === key ? `${d.color}0d` : "transparent",
            color: activeScenario === key ? d.color : "#444",
          }}>
            {d.label.split("—")[0].trim()}<br />
            <span style={{ fontSize: 11, opacity: 0.7 }}>{d.label.split("—")[1]?.trim()}</span>
          </button>
        ))}
      </div>
      {/* View mode toggle */}
      <div style={{ display: "flex", gap: 10, padding: "12px 18px", borderBottom: "1px solid #111120" }}>
        {[["scheduled", "Scheduled Withdrawals"], ["depletion", "Until Depletion"]].map(([mode, label]) => (
          <button key={mode} onClick={() => setViewMode(mode)} style={{
            padding: "7px 18px", borderRadius: 5, cursor: "pointer",
            fontFamily: "'Space Mono',monospace", fontSize: 12, letterSpacing: 1, transition: "all 0.2s",
            border: viewMode === mode ? `1px solid ${data.color}` : "1px solid #252540",
            background: viewMode === mode ? `${data.color}15` : "transparent",
            color: viewMode === mode ? data.color : "#444",
          }}>{label}{mode === "depletion" && depletionData.yearsToDepletion ? ` (${depletionData.yearsToDepletion} yrs)` : ""}</button>
        ))}
      </div>
      <div style={{ overflowX: "auto", maxHeight: 520, overflowY: "auto" }}>
        <table style={{ width: "100%", borderCollapse: "collapse" }}>
          <thead style={{ position: "sticky", top: 0, background: "#0b0b1a", zIndex: 1 }}>
            <tr>
              <th style={{ ...thStyle, textAlign: "left" }}>YR</th>
              <th style={{ ...thStyle, color: "#666" }}>START BAL</th>
              <th style={thStyle}>WITHDRAWAL</th>
              {isNR && <th style={{ ...thStyle, color: "#34d39966" }}>GAIN PORTION</th>}
              <th style={{ ...thStyle, color: "#ff6b6b88" }}>TAX PAID</th>
              <th style={{ ...thStyle, color: "#ff6b6b55" }}>EFF. RATE</th>
              <th style={{ ...thStyle, color: "#666" }}>MARGINAL</th>
              <th style={{ ...thStyle, color: data.color }}>NET IN HAND</th>
              <th style={{ ...thStyle, color: "#555" }}>END BAL</th>
            </tr>
          </thead>
          <tbody>
            {wYears.map((y, i) => {
              const isHighlight = i % 2 === 0;
              const rowStyle = { ...tdStyle, background: isHighlight ? "#0a0a17" : "transparent" };
              return (
                <tr key={i}>
                  <td style={{ ...rowStyle, textAlign: "left", color: "#555" }}>{y.year}</td>
                  <td style={{ ...rowStyle, color: "#555" }}>{fmt(y.startBalance)}</td>
                  <td style={{ ...rowStyle, color: "#ccc" }}>{fmt(y.withdrawal)}</td>
                  {isNR && <td style={{ ...rowStyle, color: "#34d39955" }}>{fmt(y.gainPortion || 0)}</td>}
                  <td style={{ ...rowStyle, color: "#ff6b6b88" }}>{fmt(y.tax)}</td>
                  <td style={{ ...rowStyle, color: y.effectiveRate > 0.3 ? "#ff6b6b" : y.effectiveRate > 0.15 ? "#ffa07a" : "#888" }}>
                    {(y.effectiveRate * 100).toFixed(1)}%
                  </td>
                  <td style={{ ...rowStyle, color: "#555" }}>{(y.marginalRate * 100).toFixed(1)}%</td>
                  <td style={{ ...rowStyle, color: data.color, fontWeight: 700 }}>{fmt(y.net)}</td>
                  <td style={{ ...rowStyle, color: "#555" }}>{fmt(y.endBalance)}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <div style={{ padding: "18px 22px", borderTop: "1px solid #1a1a2e", display: "flex", gap: 28, flexWrap: "wrap" }}>
        {(isDepletion ? [
          ["Years to Depletion", null, data.color, `${depletionData.yearsToDepletion} yrs`],
          ["Total Withdrawn", depletionData.totalWithdrawn, "#ccc"],
          ["Avg Eff. Rate", null, "#ff6b6b55", (avgEffRate * 100).toFixed(1) + "%"],
          ["Total Net Received", depletionData.totalNet, data.color],
        ] : [
          ["Total Withdrawn", totalWithdrawn, "#ccc"],
          ["Avg Eff. Rate", null, "#ff6b6b55", (avgEffRate * 100).toFixed(1) + "%"],
          ["Remaining Balance", data.finalBalance || 0, "#555"],
          ["Tax on Remainder", data.finalTax || 0, "#ff6b6b44"],
        ]).map(([l, v, c, override]) => (
          <div key={l}>
            <div style={{ fontSize: 12, color: "#2a2a48", fontFamily: "'Space Mono',monospace", marginBottom: 4 }}>{l}</div>
            <div style={{ fontSize: 18, fontFamily: "'Playfair Display',serif", color: c, fontWeight: 700 }}>
              {override !== undefined ? override : fmt(v)}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

function YearlyTable({ results }) {
  const [activeScenario, setActiveScenario] = useState("s1");
  const scenarios = [
    { key: "s1", data: results.s1 },
    { key: "s2", data: results.s2 },
    { key: "s3", data: results.s3 },
  ];
  const active = scenarios.find(s => s.key === activeScenario) ?? scenarios[0];
  const { data } = active;
  const isNR = activeScenario === "s3";
  const isS2 = activeScenario === "s2";

  const thStyle = { fontSize: 12, color: "#444", fontFamily: "'Space Mono',monospace", letterSpacing: 1, padding: "10px 16px", textAlign: "right", borderBottom: "1px solid #1a1a2e", whiteSpace: "nowrap" };
  const tdStyle = { fontSize: 14, fontFamily: "'Space Mono',monospace", padding: "9px 16px", textAlign: "right", borderBottom: "1px solid #111120" };

  return (
    <div style={{ background: "#0b0b1a", border: "1px solid #1c1c32", borderRadius: 12, overflow: "hidden" }}>
      {/* Tabs */}
      <div style={{ display: "flex", borderBottom: "1px solid #1c1c32" }}>
        {scenarios.map(({ key, data: d }) => (
          <button key={key} onClick={() => setActiveScenario(key)} style={{
            flex: 1, padding: "16px 10px", cursor: "pointer", fontFamily: "'Space Mono',monospace",
            fontSize: 13, letterSpacing: 1, transition: "all 0.2s", border: "none",
            borderBottom: activeScenario === key ? `2px solid ${d.color}` : "2px solid transparent",
            background: activeScenario === key ? `${d.color}0d` : "transparent",
            color: activeScenario === key ? d.color : "#444",
          }}>{d.label.split("—")[0].trim()}<br /><span style={{ fontSize: 11, opacity: 0.7 }}>{d.label.split("—")[1]?.trim()}</span></button>
        ))}
      </div>

      {/* Table */}
      <div style={{ overflowX: "auto", maxHeight: 520, overflowY: "auto" }}>
        <table style={{ width: "100%", borderCollapse: "collapse" }}>
          <thead style={{ position: "sticky", top: 0, background: "#0b0b1a", zIndex: 1 }}>
            <tr>
              <th style={{ ...thStyle, textAlign: "left" }}>YR</th>
              <th style={thStyle}>INCOME</th>
              <th style={thStyle}>{isNR ? "GROSS CONTRIB" : "CONTRIB"}</th>
              {!isNR && <th style={{ ...thStyle, color: data.color }}>REFUND</th>}
              {isS2 && <th style={{ ...thStyle, color: "#a78bfa88" }}>CLAIMED</th>}
              {isS2 && <th style={{ ...thStyle, color: "#555" }}>POOL LEFT</th>}
              <th style={thStyle}>GROWTH</th>
              <th style={{ ...thStyle, color: data.color }}>BALANCE</th>
              {isNR && <th style={thStyle}>COST BASE</th>}
              {isNR && <th style={{ ...thStyle, color: "#34d39988" }}>UNREALISED GAIN</th>}
              <th style={thStyle}>MARGINAL</th>
            </tr>
          </thead>
          <tbody>
            {data.years.map((y, i) => {
              const isHighlight = i % 2 === 0;
              const rowStyle = { ...tdStyle, background: isHighlight ? "#0a0a17" : "transparent" };
              return (
                <tr key={i}>
                  <td style={{ ...rowStyle, textAlign: "left", color: "#555" }}>{y.year}</td>
                  <td style={{ ...rowStyle, color: "#888" }}>{fmt(y.income)}</td>
                  <td style={rowStyle}>{fmt(isNR ? y.grossContrib : y.contrib)}</td>
                  {!isNR && <td style={{ ...rowStyle, color: y.refund > 0 ? data.color : "#333" }}>{fmt(y.refund)}</td>}
                  {isS2 && <td style={{ ...rowStyle, color: y.claimed > 0 ? "#a78bfa" : "#333" }}>{fmt(y.claimed)}</td>}
                  {isS2 && <td style={{ ...rowStyle, color: "#444" }}>{fmt(y.deductionPool)}</td>}
                  <td style={{ ...rowStyle, color: "#556" }}>{fmt(y.growth)}</td>
                  <td style={{ ...rowStyle, color: data.color, fontWeight: 700 }}>{fmt(y.balance)}</td>
                  {isNR && <td style={{ ...rowStyle, color: "#556" }}>{fmt(y.costBase)}</td>}
                  {isNR && <td style={{ ...rowStyle, color: "#34d39966" }}>{fmt(y.gain)}</td>}
                  <td style={{ ...rowStyle, color: "#555" }}>{pct(y.marginal)}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {/* Footer summary */}
      <div style={{ padding: "18px 22px", borderTop: "1px solid #1a1a2e", display: "flex", gap: 28, flexWrap: "wrap" }}>
        {[
          ["Final Balance", data.gross],
          ["Total Contrib", data.contrib],
        ].map(([l, v]) => (
          <div key={l}>
            <div style={{ fontSize: 12, color: "#333", fontFamily: "'Space Mono',monospace", marginBottom: 4 }}>{l}</div>
            <div style={{ fontSize: 18, fontFamily: "'Playfair Display',serif", color: l === "never" ? data.color : "#888", fontWeight: 700 }}>{fmt(v)}</div>
          </div>
        ))}
      </div>
    </div>
  );
}

// ─── TFSA Components ─────────────────────────────────────────────────────────

const TFSA_COLOR = "#f59e0b";

function TFSAAccumTable({ results }) {
  const thStyle = { fontSize: 12, color: "#444", fontFamily: "'Space Mono',monospace", letterSpacing: 1, padding: "10px 16px", textAlign: "right", borderBottom: "1px solid #1a1a2e", whiteSpace: "nowrap" };
  const tdStyle = { fontSize: 14, fontFamily: "'Space Mono',monospace", padding: "9px 16px", textAlign: "right", borderBottom: "1px solid #111120" };
  return (
    <div style={{ background: "#0b0b1a", border: "1px solid #1c1c32", borderRadius: 12, overflow: "hidden" }}>
      <div style={{ overflowX: "auto", maxHeight: 520, overflowY: "auto" }}>
        <table style={{ width: "100%", borderCollapse: "collapse" }}>
          <thead style={{ position: "sticky", top: 0, background: "#0b0b1a", zIndex: 1 }}>
            <tr>
              <th style={{ ...thStyle, textAlign: "left" }}>YR</th>
              <th style={thStyle}>NEW ROOM</th>
              <th style={{ ...thStyle, color: TFSA_COLOR }}>CONTRIBUTION</th>
              <th style={thStyle}>ROOM LEFT</th>
              <th style={thStyle}>GROWTH</th>
              <th style={{ ...thStyle, color: TFSA_COLOR }}>BALANCE</th>
            </tr>
          </thead>
          <tbody>
            {results.accumYears.map((y, i) => {
              const rowStyle = { ...tdStyle, background: i % 2 === 0 ? "#0a0a17" : "transparent" };
              return (
                <tr key={i}>
                  <td style={{ ...rowStyle, textAlign: "left", color: "#555" }}>{y.year}</td>
                  <td style={{ ...rowStyle, color: "#555" }}>{fmt(i === 0 ? results.accumulatedRoom : y.newRoom)}</td>
                  <td style={{ ...rowStyle, color: TFSA_COLOR }}>{fmt(y.contribution)}</td>
                  <td style={{ ...rowStyle, color: "#444" }}>{fmt(y.roomLeft)}</td>
                  <td style={{ ...rowStyle, color: "#556" }}>{fmt(y.growth)}</td>
                  <td style={{ ...rowStyle, color: TFSA_COLOR, fontWeight: 700 }}>{fmt(y.balance)}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <div style={{ padding: "18px 22px", borderTop: "1px solid #1a1a2e", display: "flex", gap: 28, flexWrap: "wrap" }}>
        {[["Final Balance", results.finalAccumBal, TFSA_COLOR], ["Total Contributed", results.totalContrib, "#888"]].map(([l, v, c]) => (
          <div key={l}>
            <div style={{ fontSize: 12, color: "#333", fontFamily: "'Space Mono',monospace", marginBottom: 4 }}>{l}</div>
            <div style={{ fontSize: 18, fontFamily: "'Playfair Display',serif", color: c, fontWeight: 700 }}>{fmt(v)}</div>
          </div>
        ))}
      </div>
    </div>
  );
}

function TFSAWithdrawalTable({ results }) {
  const [viewMode, setViewMode] = useState("scheduled");
  const isDepletion = viewMode === "depletion";
  const wYears = isDepletion ? results.depletion.wYears : results.wYears;
  const depData = results.depletion;
  const thStyle = { fontSize: 12, color: "#444", fontFamily: "'Space Mono',monospace", letterSpacing: 1, padding: "10px 16px", textAlign: "right", borderBottom: "1px solid #1a1a2e", whiteSpace: "nowrap" };
  const tdStyle = { fontSize: 14, fontFamily: "'Space Mono',monospace", padding: "9px 16px", textAlign: "right", borderBottom: "1px solid #111120" };
  return (
    <div style={{ background: "#0b0b1a", border: "1px solid #1c1c32", borderRadius: 12, overflow: "hidden" }}>
      <div style={{ display: "flex", gap: 10, padding: "12px 18px", borderBottom: "1px solid #111120" }}>
        {[["scheduled", "Scheduled Withdrawals"], ["depletion", "Until Depletion"]].map(([mode, label]) => (
          <button key={mode} onClick={() => setViewMode(mode)} style={{
            padding: "7px 18px", borderRadius: 5, cursor: "pointer",
            fontFamily: "'Space Mono',monospace", fontSize: 12, letterSpacing: 1, transition: "all 0.2s",
            border: viewMode === mode ? `1px solid ${TFSA_COLOR}` : "1px solid #252540",
            background: viewMode === mode ? `${TFSA_COLOR}15` : "transparent",
            color: viewMode === mode ? TFSA_COLOR : "#444",
          }}>{label}{mode === "depletion" && depData.yearsToDepletion ? ` (${depData.yearsToDepletion} yrs)` : ""}</button>
        ))}
      </div>
      <div style={{ overflowX: "auto", maxHeight: 520, overflowY: "auto" }}>
        <table style={{ width: "100%", borderCollapse: "collapse" }}>
          <thead style={{ position: "sticky", top: 0, background: "#0b0b1a", zIndex: 1 }}>
            <tr>
              <th style={{ ...thStyle, textAlign: "left" }}>YR</th>
              <th style={{ ...thStyle, color: "#666" }}>START BAL</th>
              <th style={thStyle}>WITHDRAWAL</th>
              <th style={{ ...thStyle, color: "#2a2a3a" }}>TAX</th>
              <th style={{ ...thStyle, color: TFSA_COLOR }}>NET IN HAND</th>
              <th style={{ ...thStyle, color: "#555" }}>END BAL</th>
            </tr>
          </thead>
          <tbody>
            {wYears.map((y, i) => {
              const rowStyle = { ...tdStyle, background: i % 2 === 0 ? "#0a0a17" : "transparent" };
              return (
                <tr key={i}>
                  <td style={{ ...rowStyle, textAlign: "left", color: "#555" }}>{y.year}</td>
                  <td style={{ ...rowStyle, color: "#555" }}>{fmt(y.startBalance)}</td>
                  <td style={{ ...rowStyle, color: "#ccc" }}>{fmt(y.withdrawal)}</td>
                  <td style={{ ...rowStyle, color: "#2a2a3a" }}>$0</td>
                  <td style={{ ...rowStyle, color: TFSA_COLOR, fontWeight: 700 }}>{fmt(y.net)}</td>
                  <td style={{ ...rowStyle, color: "#555" }}>{fmt(y.endBalance)}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <div style={{ padding: "18px 22px", borderTop: "1px solid #1a1a2e", display: "flex", gap: 28, flexWrap: "wrap" }}>
        {(isDepletion ? [
          ["Years to Depletion", null, TFSA_COLOR, `${depData.yearsToDepletion} yrs`],
          ["Total Net Received", depData.totalNet, TFSA_COLOR],
        ] : [
          ["Total Withdrawn", results.totalWithdrawn, "#ccc"],
          ["Tax Paid", null, "#2a2a3a", "$0"],
          ["Remaining Balance", results.finalWBal, "#555"],
        ]).map(([l, v, c, override]) => (
          <div key={l}>
            <div style={{ fontSize: 12, color: "#2a2a48", fontFamily: "'Space Mono',monospace", marginBottom: 4 }}>{l}</div>
            <div style={{ fontSize: 18, fontFamily: "'Playfair Display',serif", color: c, fontWeight: 700 }}>
              {override !== undefined ? override : fmt(v)}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

function PersonTFSA({ color, label, birthYear, setBirthYear, residentSince, setResidentSince, contribPhases, setContribPhases, withdrawalPhases, setWithdrawalPhases, existingBal, setExistingBal, results, panelStyle }) {
  const isMobile = useWindowWidth() < 640;
  const isNarrow = useWindowWidth() < 900;
  const updateContrib = (i, f, v) => setContribPhases(phases => {
    const next = phases.map((x, j) => j === i ? { ...x, [f]: v } : x);
    if (!results) return next;
    const eligibleYr = results.eligibleYear;
    let avail = results.accumulatedRoom;
    let elapsed = 0;
    return next.map((p, j) => {
      for (let y = 1; y <= p.years; y++) {
        const yr = CURRENT_YEAR + elapsed + y;
        if (yr >= eligibleYr) avail += TFSA_LIMITS[yr] ?? TFSA_FUTURE_ANNUAL;
      }
      const cap = p.years > 0 ? Math.floor(avail / p.years) : 0;
      const amount = j > i ? Math.min(p.annualAmount, cap) : p.annualAmount;
      avail = Math.max(0, avail - amount * p.years);
      elapsed += p.years;
      return j > i ? { ...p, annualAmount: amount } : p;
    });
  });
  const updateWithdraw = (i, f, v) => setWithdrawalPhases(phases => {
    const next = phases.map((x, j) => j === i ? { ...x, [f]: v } : x);
    if (!results?.finalAccumBal) return next;
    let bal = results.finalAccumBal;
    return next.map((p, j) => {
      const cap = p.years > 0 ? Math.floor(bal / p.years) : 0;
      const amount = j > i ? Math.min(p.annualAmount, cap) : p.annualAmount;
      bal = Math.max(0, bal - amount * p.years);
      return j > i ? { ...p, annualAmount: amount } : p;
    });
  });

  // Auto-clamp phase 1 contribution when accumulated room changes (birth year / residency)
  useEffect(() => {
    if (!results?.accumulatedRoom || results.eligibleYear > CURRENT_YEAR) return;
    setContribPhases(phases => phases.map((x, i) => {
      if (i !== 0) return x;
      const cap = Math.floor(results.accumulatedRoom / x.years);
      return x.annualAmount > cap ? { ...x, annualAmount: cap } : x;
    }));
  }, [results?.accumulatedRoom]); // eslint-disable-line react-hooks/exhaustive-deps

  // Auto-clamp phase 1 withdrawal when final balance changes
  useEffect(() => {
    if (!results?.finalAccumBal) return;
    setWithdrawalPhases(phases => phases.map((x, i) => {
      if (i !== 0) return x;
      const cap = Math.floor(results.finalAccumBal / x.years);
      return x.annualAmount > cap ? { ...x, annualAmount: cap } : x;
    }));
  }, [results?.finalAccumBal]); // eslint-disable-line react-hooks/exhaustive-deps
  const isSince18 = residentSince === null;

  return (
    <div style={{ marginBottom: 48 }}>
      <div style={{ fontSize: 13, color, letterSpacing: 3, fontFamily: "'Space Mono',monospace", marginBottom: 18, paddingBottom: 10, borderBottom: `1px solid ${color}20` }}>{label}</div>

      {/* Identity + residency */}
      <div style={{ display: "flex", gap: 20, alignItems: "flex-end", marginBottom: 20, flexWrap: "wrap" }}>
        <div>
          <div style={{ fontSize: 12, color: "#3a3a5a", letterSpacing: 2, marginBottom: 9, fontFamily: "'Space Mono',monospace" }}>BIRTH YEAR</div>
          <NumInput value={birthYear} onChange={v => setBirthYear(Math.max(1950, Math.min(CURRENT_YEAR - 10, v)))} step={1} min={1950} width={120} />
        </div>
        <div>
          <div style={{ fontSize: 12, color: "#3a3a5a", letterSpacing: 2, marginBottom: 9, fontFamily: "'Space Mono',monospace" }}>CANADIAN RESIDENT SINCE 18?</div>
          <div style={{ display: "flex", gap: 8 }}>
            {[["yes", "Yes"], ["no", "No — entered later"]].map(([k, l]) => (
              <button key={k} onClick={() => setResidentSince(k === "yes" ? null : (birthYear + 20))} style={{
                padding: "9px 16px", borderRadius: 6, cursor: "pointer",
                fontFamily: "'Space Mono',monospace", fontSize: 12, transition: "all 0.2s",
                border: (k === "yes") === isSince18 ? `1px solid ${color}` : "1px solid #252540",
                background: (k === "yes") === isSince18 ? `${color}15` : "transparent",
                color: (k === "yes") === isSince18 ? color : "#888",
              }}>{l}</button>
            ))}
          </div>
        </div>
        {!isSince18 && (
          <div>
            <div style={{ fontSize: 12, color: "#3a3a5a", letterSpacing: 2, marginBottom: 9, fontFamily: "'Space Mono',monospace" }}>
              {residentSince > CURRENT_YEAR ? "WILL BE RESIDENT IN (YEAR)" : "RESIDENT SINCE (YEAR)"}
            </div>
            <NumInput value={residentSince} onChange={v => setResidentSince(Math.max(2009, v))} step={1} min={2009} max={CURRENT_YEAR + 50} width={120} />
          </div>
        )}
        <div>
          <div style={{ fontSize: 12, color: "#3a3a5a", letterSpacing: 2, marginBottom: 9, fontFamily: "'Space Mono',monospace" }}>EXISTING BALANCE</div>
          <NumInput value={existingBal} onChange={setExistingBal} prefix="$" step={5000} min={0} width={160} />
        </div>
        {results && (
          <>
            <div style={{ padding: "12px 18px", background: "#0b0b1a", border: `1px solid ${color}30`, borderRadius: 8 }}>
              <div style={{ fontSize: 11, color: "#3a3a5a", fontFamily: "'Space Mono',monospace", marginBottom: 3 }}>ELIGIBLE SINCE</div>
              <div style={{ fontSize: 20, fontFamily: "'Playfair Display',serif", color: "#888", fontWeight: 700 }}>{results.eligibleYear}</div>
            </div>
            <div style={{ padding: "12px 18px", background: "#0b0b1a", border: `1px solid ${color}30`, borderRadius: 8 }}>
              <div style={{ fontSize: 11, color: "#3a3a5a", fontFamily: "'Space Mono',monospace", marginBottom: 3 }}>
                {results.eligibleYear > CURRENT_YEAR ? `ROOM STARTS IN ${results.eligibleYear}` : `ACCUMULATED ROOM AS OF ${CURRENT_YEAR}`}
              </div>
              <div style={{ fontSize: 20, fontFamily: "'Playfair Display',serif", color, fontWeight: 700 }}>
                {results.eligibleYear > CURRENT_YEAR ? `${fmt(TFSA_FUTURE_ANNUAL)}/yr` : fmt(results.accumulatedRoom)}
              </div>
            </div>
          </>
        )}
      </div>

      {/* Phase editors */}
      <div style={{ display: "grid", gridTemplateColumns: isNarrow ? "1fr" : "1fr 1fr", gap: 20, marginBottom: 20 }}>
        <div style={panelStyle}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 18 }}>
            <div>
              <div style={{ fontSize: 12, color, letterSpacing: 3, fontFamily: "'Space Mono',monospace" }}>CONTRIBUTIONS</div>
              <div style={{ fontSize: 12, color: "#3a3a5a", fontFamily: "'Space Mono',monospace", marginTop: 4 }}>{contribPhases.reduce((a, p) => a + p.years, 0)} yrs</div>
            </div>
            <button onClick={() => setContribPhases(p => [...p, { annualAmount: 7000, years: 5 }])} style={{ background: `${color}10`, border: `1px solid ${color}30`, borderRadius: 5, color, cursor: "pointer", fontSize: 13, padding: "6px 14px", fontFamily: "'Space Mono',monospace" }}>+ Phase</button>
          </div>
          {(() => {
            const eligibleYr = results?.eligibleYear ?? 9999;
            let avail = results?.accumulatedRoom ?? 0;
            let elapsed = 0;
            return contribPhases.map((p, i) => {
              for (let y = 1; y <= p.years; y++) {
                const yr = CURRENT_YEAR + elapsed + y;
                if (yr >= eligibleYr) avail += TFSA_LIMITS[yr] ?? TFSA_FUTURE_ANNUAL;
              }
              const cap = p.years > 0 ? Math.floor(avail / p.years) : 0;
              const left = Math.max(0, avail - p.annualAmount * p.years);
              avail = left;
              elapsed += p.years;
              const hint = results ? `cap ${fmt(cap)}/yr · ${fmt(left)} left` : null;
              return (
                <PhaseRow key={i} phase={p} index={i} type="withdrawal"
                  onUpdate={updateContrib}
                  onRemove={i2 => setContribPhases(p => p.filter((_, j) => j !== i2))}
                  canRemove={contribPhases.length > 1}
                  hint={hint} maxAmount={results ? cap : undefined} />
              );
            });
          })()}
          <div style={{ marginTop: 14, padding: "10px 14px", background: "#08080f", borderRadius: 6, fontSize: 12, color: "#333", fontFamily: "'Space Mono',monospace", lineHeight: 1.8 }}>
            Unused accumulated room carries forward each year
          </div>
        </div>
        <div style={panelStyle}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 18 }}>
            <div>
              <div style={{ fontSize: 12, color: "#34d399", letterSpacing: 3, fontFamily: "'Space Mono',monospace" }}>WITHDRAWALS</div>
              <div style={{ fontSize: 12, color: "#3a3a5a", fontFamily: "'Space Mono',monospace", marginTop: 4 }}>{withdrawalPhases.reduce((a, p) => a + p.years, 0)} yrs · {fmt(withdrawalPhases.reduce((a, p) => a + p.annualAmount * p.years, 0))} total</div>
            </div>
            <button onClick={() => setWithdrawalPhases(p => [...p, { annualAmount: 40000, years: 10 }])} style={{ background: "#34d39910", border: "1px solid #34d39930", borderRadius: 5, color: "#34d399", cursor: "pointer", fontSize: 13, padding: "6px 14px", fontFamily: "'Space Mono',monospace" }}>+ Phase</button>
          </div>
          {(() => {
            let bal = results?.finalAccumBal ?? 0;
            return withdrawalPhases.map((p, i) => {
              const cap = p.years > 0 ? Math.floor(bal / p.years) : 0;
              const left = Math.max(0, bal - p.annualAmount * p.years);
              bal = left;
              const hint = results ? `cap ${fmt(cap)}/yr · ${fmt(left)} left` : null;
              return (
                <PhaseRow key={i} phase={p} index={i} type="withdrawal"
                  onUpdate={updateWithdraw}
                  onRemove={i2 => setWithdrawalPhases(p => p.filter((_, j) => j !== i2))}
                  canRemove={withdrawalPhases.length > 1}
                  hint={hint} maxAmount={results ? cap : undefined} />
              );
            });
          })()}
          <div style={{ marginTop: 14, padding: "10px 14px", background: "#08080f", borderRadius: 6, fontSize: 12, color: "#333", fontFamily: "'Space Mono',monospace", lineHeight: 1.8 }}>
            All withdrawals tax-free · room restored the following year
          </div>
        </div>
      </div>

      {results && (
        <>
          <div style={{ background: "linear-gradient(135deg,#0c0c1c,#10101e)", border: `1px solid ${color}1a`, borderLeft: `3px solid ${color}`, borderRadius: 10, padding: isMobile ? "16px 14px" : "24px 28px", marginBottom: 20 }}>
            <div style={{ fontSize: 12, color, letterSpacing: 3, marginBottom: 16, fontFamily: "'Space Mono',monospace" }}>TFSA — TAX-FREE SAVINGS ACCOUNT</div>
            <div style={{ display: "grid", gridTemplateColumns: isMobile ? "1fr 1fr" : "repeat(3,1fr)", gap: 18 }}>
              {[["Accum. Balance", results.finalAccumBal, "#bbb"], ["Total Contributed", results.totalContrib, "#666"], ["Tax-Free Gain", results.finalAccumBal - results.totalContrib, color]].map(([l, v, c]) => (
                <div key={l} style={{ minWidth: 0 }}>
                  <div style={{ fontSize: 12, color: "#3a3a5a", marginBottom: 4, fontFamily: "'Space Mono',monospace" }}>{l}</div>
                  <div style={{ fontSize: isMobile ? 18 : 26, fontFamily: "'Playfair Display',serif", color: c, fontWeight: 700, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{fmt(v)}</div>
                </div>
              ))}
            </div>
          </div>
          <div style={{ fontSize: 12, color: "#3a3a5a", letterSpacing: 3, fontFamily: "'Space Mono',monospace", marginBottom: 12 }}>WITHDRAWAL BREAKDOWN</div>
          <TFSAWithdrawalTable results={results} />
          <div style={{ fontSize: 12, color: "#3a3a5a", letterSpacing: 3, fontFamily: "'Space Mono',monospace", marginBottom: 12, marginTop: 28 }}>YEAR-BY-YEAR ACCUMULATION</div>
          <TFSAAccumTable results={results} />
        </>
      )}
    </div>
  );
}

function TFSAPage({ returnRate, setReturnRate }) {
  const isMobile = useWindowWidth() < 640;
  const [birthYear, setBirthYear] = useState(1990);
  const [residentSince, setResidentSince] = useState(null); // null = since 18
  const [contribPhases, setContribPhases] = useState([{ annualAmount: 7000, years: 10 }]);
  const [withdrawalPhases, setWithdrawalPhases] = useState([{ annualAmount: 40000, years: 20 }]);

  const [existingBal, setExistingBal] = useState(0);

  const [showSpouse, setShowSpouse] = useState(false);
  const [spouseBirthYear, setSpouseBirthYear] = useState(1992);
  const [spouseResidentSince, setSpouseResidentSince] = useState(null);
  const [spouseContribPhases, setSpouseContribPhases] = useState([{ annualAmount: 7000, years: 10 }]);
  const [spouseWithdrawalPhases, setSpouseWithdrawalPhases] = useState([{ annualAmount: 40000, years: 20 }]);
  const [spouseExistingBal, setSpouseExistingBal] = useState(0);

  const results = useMemo(
    () => runTFSASimulation(birthYear, residentSince, contribPhases, withdrawalPhases, returnRate / 100, existingBal),
    [birthYear, residentSince, contribPhases, withdrawalPhases, returnRate, existingBal]
  );
  const spouseResults = useMemo(
    () => showSpouse ? runTFSASimulation(spouseBirthYear, spouseResidentSince, spouseContribPhases, spouseWithdrawalPhases, returnRate / 100, spouseExistingBal) : null,
    [spouseBirthYear, spouseResidentSince, spouseContribPhases, spouseWithdrawalPhases, returnRate, showSpouse, spouseExistingBal]
  );
  const panelStyle = { background: "#0b0b1a", border: "1px solid #1c1c32", borderRadius: 12, padding: isMobile ? "16px 14px" : "24px 28px" };

  return (
    <>
      {/* Header */}
      <div style={{ marginBottom: 36 }}>
        <div style={{ fontSize: 12, color: TFSA_COLOR, letterSpacing: 4, marginBottom: 8, fontFamily: "'Space Mono',monospace" }}>TAX-FREE SAVINGS ACCOUNT · CANADIAN 2026</div>
        <h1 style={{ fontFamily: "'Playfair Display',serif", fontSize: isMobile ? 36 : 56, margin: "0 0 8px", fontWeight: 900, lineHeight: 1.05 }}>
          TFSA <span style={{ color: TFSA_COLOR }}>Simulator</span>
        </h1>
        <p style={{ color: "#3a3a5a", fontSize: 13, fontFamily: "'Space Mono',monospace", margin: 0, lineHeight: 1.8 }}>
          Tax-free growth and withdrawals · Room accumulates from age 18 (2009 minimum) while Canadian resident
        </p>
      </div>

      {/* Shared controls */}
      <div style={{ display: "flex", gap: 20, alignItems: "flex-end", marginBottom: 32, flexWrap: "wrap" }}>
        <div>
          <div style={{ fontSize: 12, color: "#3a3a5a", letterSpacing: 2, marginBottom: 9, fontFamily: "'Space Mono',monospace" }}>ANNUAL RETURN</div>
          <NumInput value={returnRate} onChange={setReturnRate} suffix="%" step={0.5} min={0} width={115} />
        </div>
        <button onClick={() => setShowSpouse(s => !s)} style={{
          padding: "10px 20px", borderRadius: 6, cursor: "pointer",
          fontFamily: "'Space Mono',monospace", fontSize: 12, transition: "all 0.2s",
          border: showSpouse ? "1px solid #a78bfa" : "1px solid #252540",
          background: showSpouse ? "#a78bfa15" : "transparent",
          color: showSpouse ? "#a78bfa" : "#444",
        }}>{showSpouse ? "— Remove Spouse" : "+ Add Spouse"}</button>
      </div>

      <PersonTFSA
        color={TFSA_COLOR} label="YOU"
        birthYear={birthYear} setBirthYear={setBirthYear}
        residentSince={residentSince} setResidentSince={setResidentSince}
        contribPhases={contribPhases} setContribPhases={setContribPhases}
        withdrawalPhases={withdrawalPhases} setWithdrawalPhases={setWithdrawalPhases}
        existingBal={existingBal} setExistingBal={setExistingBal}
        results={results} panelStyle={panelStyle}
      />

      {showSpouse && (
        <PersonTFSA
          color="#a78bfa" label="SPOUSE"
          birthYear={spouseBirthYear} setBirthYear={setSpouseBirthYear}
          residentSince={spouseResidentSince} setResidentSince={setSpouseResidentSince}
          contribPhases={spouseContribPhases} setContribPhases={setSpouseContribPhases}
          withdrawalPhases={spouseWithdrawalPhases} setWithdrawalPhases={setSpouseWithdrawalPhases}
          existingBal={spouseExistingBal} setExistingBal={setSpouseExistingBal}
          results={spouseResults} panelStyle={panelStyle}
        />
      )}

      {showSpouse && results && spouseResults && (
        <div style={{ background: "linear-gradient(135deg,#0c0c1c,#10101e)", border: "1px solid #1c1c32", borderRadius: 10, padding: isMobile ? "16px 14px" : "24px 28px", marginTop: 8 }}>
          <div style={{ fontSize: 12, color: "#888", letterSpacing: 3, marginBottom: 16, fontFamily: "'Space Mono',monospace" }}>COMBINED HOUSEHOLD</div>
          <div style={{ display: "grid", gridTemplateColumns: isMobile ? "1fr 1fr" : "repeat(3,1fr)", gap: 18 }}>
            {[
              ["Combined Balance", results.finalAccumBal + spouseResults.finalAccumBal, "#bbb"],
              ["Combined Contributed", results.totalContrib + spouseResults.totalContrib, "#666"],
              ["Combined Tax-Free Gain", (results.finalAccumBal - results.totalContrib) + (spouseResults.finalAccumBal - spouseResults.totalContrib), TFSA_COLOR],
            ].map(([l, v, c]) => (
              <div key={l} style={{ minWidth: 0 }}>
                <div style={{ fontSize: 12, color: "#3a3a5a", marginBottom: 4, fontFamily: "'Space Mono',monospace" }}>{l}</div>
                <div style={{ fontSize: isMobile ? 18 : 26, fontFamily: "'Playfair Display',serif", color: c, fontWeight: 700, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{fmt(v)}</div>
              </div>
            ))}
          </div>
        </div>
      )}
    </>
  );
}

// ─── RESP Components ─────────────────────────────────────────────────────────

function RESPAccumTable({ results }) {
  const thStyle = { fontSize: 12, color: "#444", fontFamily: "'Space Mono',monospace", letterSpacing: 1, padding: "10px 16px", textAlign: "right", borderBottom: "1px solid #1a1a2e", whiteSpace: "nowrap" };
  const tdStyle = { fontSize: 14, fontFamily: "'Space Mono',monospace", padding: "9px 16px", textAlign: "right", borderBottom: "1px solid #111120" };
  return (
    <div style={{ background: "#0b0b1a", border: "1px solid #1c1c32", borderRadius: 12, overflow: "hidden" }}>
      <div style={{ overflowX: "auto", maxHeight: 520, overflowY: "auto" }}>
        <table style={{ width: "100%", borderCollapse: "collapse" }}>
          <thead style={{ position: "sticky", top: 0, background: "#0b0b1a", zIndex: 1 }}>
            <tr>
              <th style={{ ...thStyle, textAlign: "left" }}>YR</th>
              <th style={thStyle}>CHILD AGE</th>
              <th style={{ ...thStyle, color: RESP_COLOR }}>CONTRIBUTION</th>
              <th style={{ ...thStyle, color: "#34d399" }}>CESG</th>
              <th style={thStyle}>GROWTH</th>
              <th style={{ ...thStyle, color: RESP_COLOR }}>BALANCE</th>
              <th style={{ ...thStyle, color: "#34d39966" }}>TOTAL CESG</th>
            </tr>
          </thead>
          <tbody>
            {results.accumYears.map((y, i) => {
              const rowStyle = { ...tdStyle, background: i % 2 === 0 ? "#0a0a17" : "transparent" };
              return (
                <tr key={i}>
                  <td style={{ ...rowStyle, textAlign: "left", color: "#555" }}>{y.year}</td>
                  <td style={{ ...rowStyle, color: "#555" }}>{y.childAge}</td>
                  <td style={{ ...rowStyle, color: RESP_COLOR }}>{fmt(y.contribution)}</td>
                  <td style={{ ...rowStyle, color: y.cesg > 0 ? "#34d399" : "#333" }}>{fmt(y.cesg)}</td>
                  <td style={{ ...rowStyle, color: "#556" }}>{fmt(y.growth)}</td>
                  <td style={{ ...rowStyle, color: RESP_COLOR, fontWeight: 700 }}>{fmt(y.balance)}</td>
                  <td style={{ ...rowStyle, color: "#34d39966" }}>{fmt(y.totalCESG)}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <div style={{ padding: "18px 22px", borderTop: "1px solid #1a1a2e", display: "flex", gap: 28, flexWrap: "wrap" }}>
        {[["Final Balance", results.finalBal, RESP_COLOR], ["Total Contributed", results.totalContrib, "#888"], ["CESG Received", results.newCESG, "#34d399"]].map(([l, v, c]) => (
          <div key={l}>
            <div style={{ fontSize: 12, color: "#333", fontFamily: "'Space Mono',monospace", marginBottom: 4 }}>{l}</div>
            <div style={{ fontSize: 18, fontFamily: "'Playfair Display',serif", color: c, fontWeight: 700 }}>{fmt(v)}</div>
          </div>
        ))}
      </div>
    </div>
  );
}

const RESP_CHILD_COLORS = [RESP_COLOR, "#c084fc", "#fb923c", "#38bdf8"];
const newRESPChild = () => ({ _id: Date.now() + Math.random(), birthYear: CURRENT_YEAR - 3, contribPhases: [{ annualAmount: 2500, years: 14 }], existingBal: 0, existingCESG: 0, existingContrib: 0, schoolYears: 4, studentIncome: 0, spouseIncome: 0, nonRegSplit: false });

function PersonRESP({ color, label, child, onUpdate, onRemove, canRemove, subscriberIncome, returnRate, isMobile, isNarrow }) {
  const { birthYear, contribPhases, existingBal, existingCESG, existingContrib, schoolYears, studentIncome, spouseIncome, nonRegSplit } = child;
  const isFuture = birthYear > CURRENT_YEAR;
  const results = useMemo(
    () => runRESPSimulation(birthYear, contribPhases, returnRate / 100, isFuture ? 0 : existingBal, isFuture ? 0 : existingCESG, isFuture ? 0 : existingContrib),
    [birthYear, contribPhases, returnRate, existingBal, existingCESG, existingContrib, isFuture]
  );
  const nonReg = useMemo(
    () => runNonRegRESP(birthYear, contribPhases, returnRate / 100, isFuture ? 0 : existingBal, isFuture ? 0 : existingContrib),
    [birthYear, contribPhases, returnRate, existingBal, existingContrib, isFuture]
  );

  const setField = (f, v) => onUpdate(f, v);
  const setContribPhases = updater => {
    const next = typeof updater === "function" ? updater(contribPhases) : updater;
    onUpdate("contribPhases", next);
  };

  // Total planned contributions vs 50k limit
  const effectiveExistingContrib = isFuture ? 0 : existingContrib;
  const plannedContrib = contribPhases.reduce((a, p) => a + p.annualAmount * p.years, 0);
  const totalPlanned = effectiveExistingContrib + plannedContrib;
  const overLimit = totalPlanned > RESP_CONTRIB_LIFETIME_MAX;

  const annualEAP = results ? results.eapPortion / Math.max(schoolYears, 1) : 0;
  const eapTaxPerYear = results ? calcTax(studentIncome + annualEAP) - calcTax(studentIncome) : 0;
  const totalEAPTax = eapTaxPerYear * schoolYears;
  const netForEducation = results ? results.contribPortion + results.eapPortion - totalEAPTax : 0;
  const aipIncomeTax = results ? calcTax(subscriberIncome + results.eapPortion) - calcTax(subscriberIncome) : 0;
  const aipPenalty = results ? results.eapPortion * 0.20 : 0;
  const netAIP = results ? results.contribPortion + Math.max(results.eapPortion - aipIncomeTax - aipPenalty, 0) : 0;

  // Non-reg comparison
  const nonRegGain = nonReg ? nonReg.gain : 0;
  const nonRegTaxSolo = nonRegGain * 0.5 * getMarginalRate(subscriberIncome);
  const nonRegTaxSplit = nonRegGain * 0.5 * (getMarginalRate(subscriberIncome) * 0.5 + getMarginalRate(spouseIncome ?? 0) * 0.5);
  const nonRegTax = nonRegSplit ? nonRegTaxSplit : nonRegTaxSolo;
  const nonRegNet = nonReg ? nonReg.finalBal - nonRegTax : 0;
  const respAdvantage = netForEducation - nonRegNet;

  const ageNow = CURRENT_YEAR - birthYear;

  const disabledInputStyle = { opacity: 0.35, pointerEvents: "none" };

  return (
    <div style={{ marginBottom: 32, border: `1px solid ${color}30`, borderLeft: `4px solid ${color}`, borderRadius: 12, background: "#08081a", overflow: "hidden" }}>
      {/* Child header bar */}
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: isMobile ? "14px 16px" : "16px 28px", background: `${color}0d`, borderBottom: `1px solid ${color}20` }}>
        <div style={{ display: "flex", alignItems: "center", gap: 16 }}>
          <div style={{ fontSize: 14, color, letterSpacing: 4, fontFamily: "'Space Mono',monospace", fontWeight: 700 }}>{label}</div>
          {isFuture ? (
            <div style={{ fontSize: 11, color: "#f59e0b", fontFamily: "'Space Mono',monospace", background: "#f59e0b15", border: "1px solid #f59e0b30", borderRadius: 4, padding: "2px 8px" }}>FUTURE CHILD</div>
          ) : (
            <div style={{ fontSize: 11, color: "#3a3a5a", fontFamily: "'Space Mono',monospace" }}>AGE {ageNow}</div>
          )}
        </div>
        {canRemove && (
          <button onClick={onRemove} style={{ background: "transparent", border: "1px solid #2a1818", borderRadius: 4, color: "#ff6b6b88", cursor: "pointer", fontSize: 12, padding: "4px 12px", fontFamily: "monospace" }}>Remove</button>
        )}
      </div>

      <div style={{ padding: isMobile ? "16px" : "24px 28px" }}>

      {/* Child info */}
      <div style={{ display: "flex", gap: 20, alignItems: "flex-end", marginBottom: 24, flexWrap: "wrap" }}>
        <div>
          <div style={{ fontSize: 12, color: "#3a3a5a", letterSpacing: 2, marginBottom: 9, fontFamily: "'Space Mono',monospace" }}>BIRTH YEAR</div>
          <NumInput value={birthYear} onChange={v => setField("birthYear", Math.max(1990, v))} step={1} min={1990} max={CURRENT_YEAR + 20} width={120} />
        </div>
        <div style={isFuture ? disabledInputStyle : {}}>
          <div style={{ fontSize: 12, color: "#3a3a5a", letterSpacing: 2, marginBottom: 9, fontFamily: "'Space Mono',monospace" }}>EXISTING BALANCE {isFuture && <span style={{ color: "#f59e0b" }}>—</span>}</div>
          <NumInput value={isFuture ? 0 : existingBal} onChange={v => !isFuture && setField("existingBal", v)} prefix="$" step={1000} min={0} width={150} />
        </div>
        <div style={isFuture ? disabledInputStyle : {}}>
          <div style={{ fontSize: 12, color: "#3a3a5a", letterSpacing: 2, marginBottom: 9, fontFamily: "'Space Mono',monospace" }}>EXISTING CONTRIBUTIONS {isFuture && <span style={{ color: "#f59e0b" }}>—</span>}</div>
          <NumInput value={isFuture ? 0 : existingContrib} onChange={v => !isFuture && setField("existingContrib", Math.min(v, RESP_CONTRIB_LIFETIME_MAX))} prefix="$" step={1000} min={0} max={RESP_CONTRIB_LIFETIME_MAX} width={150} />
        </div>
        <div style={isFuture ? disabledInputStyle : {}}>
          <div style={{ fontSize: 12, color: "#3a3a5a", letterSpacing: 2, marginBottom: 9, fontFamily: "'Space Mono',monospace" }}>EXISTING CESG {isFuture && <span style={{ color: "#f59e0b" }}>—</span>}</div>
          <NumInput value={isFuture ? 0 : existingCESG} onChange={v => !isFuture && setField("existingCESG", Math.min(v, CESG_LIFETIME_MAX))} prefix="$" step={500} min={0} max={CESG_LIFETIME_MAX} width={140} />
        </div>
        <div style={{ padding: "12px 18px", background: "#0b0b1a", border: `1px solid ${color}30`, borderRadius: 8 }}>
          <div style={{ fontSize: 11, color: "#3a3a5a", fontFamily: "'Space Mono',monospace", marginBottom: 3 }}>CESG REMAINING</div>
          <div style={{ fontSize: 20, fontFamily: "'Playfair Display',serif", color: "#34d399", fontWeight: 700 }}>{fmt(Math.max(CESG_LIFETIME_MAX - (isFuture ? 0 : existingCESG), 0))}</div>
        </div>
      </div>

      {/* Contribution phases */}
      <div style={{ background: "#0b0b1a", border: "1px solid #1c1c32", borderRadius: 12, padding: isMobile ? "16px 14px" : "24px 28px", marginBottom: 20 }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 10 }}>
          <div>
            <div style={{ fontSize: 12, color, letterSpacing: 3, fontFamily: "'Space Mono',monospace" }}>CONTRIBUTIONS</div>
            <div style={{ fontSize: 12, color: "#3a3a5a", fontFamily: "'Space Mono',monospace", marginTop: 4 }}>{contribPhases.reduce((a, p) => a + p.years, 0)} yrs total</div>
          </div>
          <button onClick={() => setContribPhases(p => [...p, { annualAmount: 2500, years: 5 }])} style={{ background: `${color}10`, border: `1px solid ${color}30`, borderRadius: 5, color, cursor: "pointer", fontSize: 13, padding: "6px 14px", fontFamily: "'Space Mono',monospace" }}>+ Phase</button>
        </div>
        {/* 50k lifetime limit bar */}
        <div style={{ marginBottom: 18 }}>
          <div style={{ display: "flex", justifyContent: "space-between", fontSize: 11, fontFamily: "'Space Mono',monospace", color: overLimit ? "#ff6b6b" : "#3a3a5a", marginBottom: 5 }}>
            <span>LIFETIME LIMIT (per child): {fmt(Math.min(totalPlanned, RESP_CONTRIB_LIFETIME_MAX))} / $50,000</span>
            {overLimit && <span style={{ color: "#ff6b6b" }}>exceeds by {fmt(totalPlanned - RESP_CONTRIB_LIFETIME_MAX)}</span>}
          </div>
          <div style={{ height: 6, background: "#1c1c32", borderRadius: 3, overflow: "hidden" }}>
            <div style={{ height: "100%", width: `${Math.min(totalPlanned / RESP_CONTRIB_LIFETIME_MAX * 100, 100)}%`, background: overLimit ? "#ff6b6b" : color, borderRadius: 3, transition: "width 0.3s" }} />
          </div>
        </div>
        {contribPhases.map((p, i) => (
          <PhaseRow
            key={i} phase={p} index={i}
            onUpdate={(idx, f, v) => setContribPhases(phases => {
              const next = phases.map((x, j) => j === idx ? { ...x, [f]: v } : x);
              const phase = next[idx];
              const otherTotal = next.reduce((a, x, j) => j !== idx ? a + x.annualAmount * x.years : a, 0);
              const room = Math.max(0, RESP_CONTRIB_LIFETIME_MAX - effectiveExistingContrib - otherTotal);
              if (f === "annualAmount") {
                // amount changed → clamp years to fit room
                const maxYrs = v > 0 ? Math.max(1, Math.floor(room / v)) : phase.years;
                if (phase.years > maxYrs) next[idx] = { ...phase, years: maxYrs };
              } else if (f === "years") {
                // years changed → clamp amount to fit room
                const maxAmt = v > 0 ? Math.floor(room / v / 500) * 500 : phase.annualAmount;
                if (phase.annualAmount > maxAmt) next[idx] = { ...phase, annualAmount: Math.max(0, maxAmt) };
              }
              return next;
            })}
            onRemove={idx => setContribPhases(phases => phases.filter((_, j) => j !== idx))}
            canRemove={contribPhases.length > 1}
            type="contrib"
            hint={`+ ${fmt(Math.min(p.annualAmount, CESG_ANNUAL_CONTRIB_MAX) * 0.20)} CESG/yr`}
            amountStep={500}
          />
        ))}
      </div>

      {results && (
        <>
          {/* Summary card */}
          <div style={{ background: "linear-gradient(135deg,#0c0c1c,#10101e)", border: `1px solid ${color}1a`, borderLeft: `3px solid ${color}`, borderRadius: 10, padding: isMobile ? "16px 14px" : "24px 28px", marginBottom: 20 }}>
            <div style={{ fontSize: 12, color, letterSpacing: 3, marginBottom: 16, fontFamily: "'Space Mono',monospace" }}>PROJECTED BALANCE</div>
            <div style={{ display: "grid", gridTemplateColumns: isMobile ? "1fr 1fr" : "repeat(4,1fr)", gap: 18 }}>
              {[
                ["Final Balance", results.finalBal, color],
                ["Contributions", results.totalContrib, "#bbb"],
                ["CESG Received", results.newCESG, "#34d399"],
                ["Growth", results.finalBal - existingBal - results.totalContrib - results.newCESG, "#666"],
              ].map(([l, v, c]) => (
                <div key={l} style={{ minWidth: 0 }}>
                  <div style={{ fontSize: 12, color: "#3a3a5a", marginBottom: 4, fontFamily: "'Space Mono',monospace" }}>{l}</div>
                  <div style={{ fontSize: isMobile ? 18 : 26, fontFamily: "'Playfair Display',serif", color: c, fontWeight: 700, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{fmt(v)}</div>
                </div>
              ))}
            </div>
          </div>

          {/* Withdrawal scenarios */}
          <div style={{ fontSize: 12, color: "#3a3a5a", letterSpacing: 3, fontFamily: "'Space Mono',monospace", marginBottom: 14 }}>WITHDRAWAL SCENARIOS</div>
          <div style={{ display: "grid", gridTemplateColumns: isNarrow ? "1fr" : "1fr 1fr", gap: 20, marginBottom: 20 }}>
            <div style={{ background: "#0b0b1a", border: "1px solid #1c1c32", borderRadius: 12, padding: isMobile ? "16px 14px" : "24px 28px", borderLeft: "3px solid #34d399" }}>
              <div style={{ fontSize: 12, color: "#34d399", letterSpacing: 3, fontFamily: "'Space Mono',monospace", marginBottom: 16 }}>FOR EDUCATION (EAP)</div>
              <div style={{ display: "flex", gap: 16, marginBottom: 20, flexWrap: "wrap" }}>
                <div>
                  <div style={{ fontSize: 12, color: "#3a3a5a", letterSpacing: 2, marginBottom: 9, fontFamily: "'Space Mono',monospace" }}>YEARS IN SCHOOL</div>
                  <NumInput value={schoolYears} onChange={v => setField("schoolYears", Math.max(1, v))} suffix="yrs" step={1} min={1} max={10} width={100} />
                </div>
                <div>
                  <div style={{ fontSize: 12, color: "#3a3a5a", letterSpacing: 2, marginBottom: 9, fontFamily: "'Space Mono',monospace" }}>STUDENT OTHER INCOME</div>
                  <NumInput value={studentIncome} onChange={v => setField("studentIncome", v)} prefix="$" step={1000} min={0} width={150} />
                </div>
              </div>
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
                {[
                  ["Contributions (tax-free)", results.contribPortion, "#bbb"],
                  [`EAP /yr (${schoolYears} yrs)`, annualEAP, "#34d39966"],
                  ["Tax on EAP", totalEAPTax, "#ff6b6b66"],
                  ["Net In Hand", netForEducation, "#34d399"],
                ].map(([l, v, c]) => (
                  <div key={l}>
                    <div style={{ fontSize: 11, color: "#3a3a5a", fontFamily: "'Space Mono',monospace", marginBottom: 3 }}>{l}</div>
                    <div style={{ fontSize: 20, fontFamily: "'Playfair Display',serif", color: c, fontWeight: 700 }}>{fmt(v)}</div>
                  </div>
                ))}
              </div>
            </div>

            <div style={{ background: "#0b0b1a", border: "1px solid #1c1c32", borderRadius: 12, padding: isMobile ? "16px 14px" : "24px 28px", borderLeft: "3px solid #ff6b6b" }}>
              <div style={{ fontSize: 12, color: "#ff6b6b", letterSpacing: 3, fontFamily: "'Space Mono',monospace", marginBottom: 16 }}>NOT FOR EDUCATION (AIP)</div>
              <div style={{ fontSize: 12, color: "#3a3a5a", fontFamily: "'Space Mono',monospace", marginBottom: 14, lineHeight: 1.8 }}>
                Grant + growth taxed at subscriber's marginal rate + 20% federal penalty. Or roll up to $50k to RRSP if room available.
              </div>
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
                {[
                  ["Contributions (tax-free)", results.contribPortion, "#bbb"],
                  ["EAP (grant + growth)", results.eapPortion, "#ff6b6b44"],
                  ["Income Tax on AIP", aipIncomeTax, "#ff6b6b66"],
                  ["20% Penalty", aipPenalty, "#ff6b6b66"],
                  ["Net In Hand (AIP)", netAIP, "#ff6b6b"],
                  ["vs Education", netForEducation - netAIP, netForEducation >= netAIP ? "#34d399" : "#ff6b6b"],
                ].map(([l, v, c]) => (
                  <div key={l}>
                    <div style={{ fontSize: 11, color: "#3a3a5a", fontFamily: "'Space Mono',monospace", marginBottom: 3 }}>{l}</div>
                    <div style={{ fontSize: 20, fontFamily: "'Playfair Display',serif", color: c, fontWeight: 700 }}>
                      {fmt(Math.abs(v))}{l === "vs Education" && <span style={{ fontSize: 12, color: "#444", marginLeft: 4 }}>{v >= 0 ? "better" : "better AIP"}</span>}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          </div>

          {/* Non-Reg Comparison */}
          {nonReg && (
            <div style={{ background: "#0b0b1a", border: "1px solid #1c1c32", borderRadius: 12, padding: isMobile ? "16px 14px" : "24px 28px", marginBottom: 20 }}>
              <div style={{ fontSize: 12, color: "#888", letterSpacing: 3, fontFamily: "'Space Mono',monospace", marginBottom: 16 }}>NON-REGISTERED COMPARISON</div>
              {/* Spousal split toggle + spouse income */}
              <div style={{ display: "flex", gap: 20, alignItems: "flex-end", marginBottom: 20, flexWrap: "wrap" }}>
                <div>
                  <div style={{ fontSize: 12, color: "#3a3a5a", letterSpacing: 2, marginBottom: 9, fontFamily: "'Space Mono',monospace" }}>SPOUSAL INCOME SPLIT</div>
                  <button
                    onClick={() => setField("nonRegSplit", !nonRegSplit)}
                    style={{ padding: "8px 16px", borderRadius: 5, border: `1px solid ${nonRegSplit ? "#888" : "#252540"}`, background: nonRegSplit ? "#88888820" : "#0a0a18", color: nonRegSplit ? "#e0e0e0" : "#444", fontFamily: "'Space Mono',monospace", fontSize: 12, cursor: "pointer" }}
                  >{nonRegSplit ? "Split: ON" : "Split: OFF"}</button>
                </div>
                {nonRegSplit && (
                  <div>
                    <div style={{ fontSize: 12, color: "#3a3a5a", letterSpacing: 2, marginBottom: 9, fontFamily: "'Space Mono',monospace" }}>SPOUSE INCOME</div>
                    <NumInput value={spouseIncome ?? 0} onChange={v => setField("spouseIncome", v)} prefix="$" step={5000} min={0} width={160} />
                  </div>
                )}
              </div>
              <div style={{ display: "grid", gridTemplateColumns: isMobile ? "1fr 1fr" : "repeat(4,1fr)", gap: 16 }}>
                {[
                  ["Non-Reg Final Balance", nonReg.finalBal, "#888"],
                  ["Capital Gains Tax", nonRegTax, "#ff6b6b66"],
                  ["Non-Reg Net In Hand", nonRegNet, "#888"],
                  ["RESP Advantage", respAdvantage, respAdvantage >= 0 ? "#34d399" : "#ff6b6b"],
                ].map(([l, v, c]) => (
                  <div key={l}>
                    <div style={{ fontSize: 11, color: "#3a3a5a", fontFamily: "'Space Mono',monospace", marginBottom: 3 }}>{l}</div>
                    <div style={{ fontSize: 20, fontFamily: "'Playfair Display',serif", color: c, fontWeight: 700 }}>
                      {fmt(Math.abs(v))}{l === "RESP Advantage" && <span style={{ fontSize: 11, color: "#444", marginLeft: 6 }}>{respAdvantage >= 0 ? "RESP wins" : "Non-Reg wins"}</span>}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}

          <RESPAccumTable results={results} />
        </>
      )}

      </div>
    </div>
  );
}

function RESPPage({ returnRate, setReturnRate }) {
  const isMobile = useWindowWidth() < 640;
  const isNarrow = useWindowWidth() < 900;
  const [subscriberIncome, setSubscriberIncome] = useState(120000);
  const [children, setChildren] = useState(() => [newRESPChild()]);

  const updateChild = (id, f, v) => setChildren(cs => cs.map(c => c._id === id ? { ...c, [f]: v } : c));
  const addChild = () => setChildren(cs => [...cs, newRESPChild()]);
  const removeChild = id => setChildren(cs => cs.filter(c => c._id !== id));

  const allResults = useMemo(() => children.map(c => {
    const isFuture = c.birthYear > CURRENT_YEAR;
    return runRESPSimulation(c.birthYear, c.contribPhases, returnRate / 100, isFuture ? 0 : c.existingBal, isFuture ? 0 : c.existingCESG, isFuture ? 0 : c.existingContrib);
  }), [children, returnRate]);

  const allNonReg = useMemo(() => children.map(c => {
    const isFuture = c.birthYear > CURRENT_YEAR;
    return runNonRegRESP(c.birthYear, c.contribPhases, returnRate / 100, isFuture ? 0 : c.existingBal, isFuture ? 0 : c.existingContrib);
  }), [children, returnRate]);

  const combined = useMemo(() => {
    let finalBal = 0, totalContrib = 0, newCESG = 0, growth = 0, netInHand = 0, totalTax = 0, nonRegNet = 0;
    allResults.forEach((r, i) => {
      const c = children[i];
      const isFuture = c.birthYear > CURRENT_YEAR;
      finalBal += r.finalBal;
      totalContrib += r.totalContrib;
      newCESG += r.newCESG;
      growth += r.finalBal - (isFuture ? 0 : c.existingBal) - r.totalContrib - r.newCESG;
      const annualEAP = r.eapPortion / Math.max(c.schoolYears, 1);
      const eapTax = (calcTax(c.studentIncome + annualEAP) - calcTax(c.studentIncome)) * c.schoolYears;
      totalTax += eapTax;
      netInHand += r.contribPortion + r.eapPortion - eapTax;
      const nr = allNonReg[i];
      if (nr) {
        const gain = nr.gain;
        const tax = c.nonRegSplit
          ? gain * 0.5 * (getMarginalRate(subscriberIncome) * 0.5 + getMarginalRate(c.spouseIncome ?? 0) * 0.5)
          : gain * 0.5 * getMarginalRate(subscriberIncome);
        nonRegNet += nr.finalBal - tax;
      }
    });
    return { finalBal, totalContrib, newCESG, growth, netInHand, totalTax, nonRegNet, respAdvantage: netInHand - nonRegNet };
  }, [allResults, allNonReg, children, subscriberIncome]);

  return (
    <>
      <div style={{ marginBottom: 36 }}>
        <div style={{ fontSize: 12, color: RESP_COLOR, letterSpacing: 4, marginBottom: 8, fontFamily: "'Space Mono',monospace" }}>REGISTERED EDUCATION SAVINGS PLAN · FEDERAL 2026</div>
        <h1 style={{ fontFamily: "'Playfair Display',serif", fontSize: isMobile ? 36 : 56, margin: "0 0 8px", fontWeight: 900, lineHeight: 1.05 }}>
          RESP <span style={{ color: RESP_COLOR }}>Simulator</span>
        </h1>
        <p style={{ color: "#3a3a5a", fontSize: 13, fontFamily: "'Space Mono',monospace", margin: 0, lineHeight: 1.8 }}>
          20% CESG on first $2,500/yr · $500/yr max · $7,200 lifetime · $50,000 contribution limit per beneficiary
        </p>
      </div>

      {/* Shared controls */}
      <div style={{ display: "flex", gap: 28, alignItems: "flex-end", marginBottom: 28, flexWrap: "wrap", borderBottom: "1px solid #1c1c32", paddingBottom: 24 }}>
        <div>
          <div style={{ fontSize: 12, color: "#3a3a5a", letterSpacing: 2, marginBottom: 9, fontFamily: "'Space Mono',monospace" }}>ANNUAL RETURN</div>
          <NumInput value={returnRate} onChange={setReturnRate} suffix="%" step={0.5} min={0} width={115} />
        </div>
        <div>
          <div style={{ fontSize: 12, color: "#3a3a5a", letterSpacing: 2, marginBottom: 9, fontFamily: "'Space Mono',monospace" }}>SUBSCRIBER INCOME (AIP)</div>
          <NumInput value={subscriberIncome} onChange={setSubscriberIncome} prefix="$" step={5000} min={0} width={160} />
        </div>
        <div style={{ marginLeft: "auto" }}>
          <button onClick={addChild} disabled={children.length >= 4} style={{
            padding: "10px 20px", borderRadius: 6, cursor: children.length >= 4 ? "default" : "pointer",
            fontFamily: "'Space Mono',monospace", fontSize: 12, transition: "all 0.2s",
            border: `1px solid ${RESP_COLOR}50`, background: `${RESP_COLOR}10`, color: children.length >= 4 ? "#444" : RESP_COLOR,
          }}>+ Add Child</button>
        </div>
      </div>

      {/* Combined summary — only show when multiple children */}
      {children.length > 1 && (
        <div style={{ background: "linear-gradient(135deg,#0c0c1c,#10101e)", border: `1px solid ${RESP_COLOR}25`, borderLeft: `4px solid ${RESP_COLOR}`, borderRadius: 12, padding: isMobile ? "16px 14px" : "24px 28px", marginBottom: 32 }}>
          <div style={{ fontSize: 12, color: RESP_COLOR, letterSpacing: 3, marginBottom: 18, fontFamily: "'Space Mono',monospace" }}>ALL CHILDREN · COMBINED TOTALS</div>
          <div style={{ display: "grid", gridTemplateColumns: isMobile ? "1fr 1fr" : "repeat(3,1fr)", gap: 20, marginBottom: 20 }}>
            {[
              ["Total Ending Balance", combined.finalBal, RESP_COLOR],
              ["Net In Hand (Education)", combined.netInHand, "#34d399"],
              ["Total Tax on EAP", combined.totalTax, "#ff6b6b"],
              ["Total Contributions", combined.totalContrib, "#bbb"],
              ["Total CESG", combined.newCESG, "#34d399"],
              ["Total Growth", combined.growth, "#666"],
              ["Non-Reg Net In Hand", combined.nonRegNet, "#888"],
              ["RESP Advantage", combined.respAdvantage, combined.respAdvantage >= 0 ? "#34d399" : "#ff6b6b"],
            ].map(([l, v, c]) => (
              <div key={l}>
                <div style={{ fontSize: 11, color: "#3a3a5a", fontFamily: "'Space Mono',monospace", marginBottom: 4 }}>{l}</div>
                <div style={{ fontSize: isMobile ? 20 : 28, fontFamily: "'Playfair Display',serif", color: c, fontWeight: 700 }}>
                  {fmt(Math.abs(v))}{l === "RESP Advantage" && <span style={{ fontSize: 11, color: "#444", marginLeft: 6 }}>{combined.respAdvantage >= 0 ? "RESP wins" : "Non-Reg wins"}</span>}
                </div>
              </div>
            ))}
          </div>
          {/* Per-child breakdown row */}
          <div style={{ display: "flex", gap: 12, flexWrap: "wrap" }}>
            {children.map((child, i) => {
              const r = allResults[i];
              const color = RESP_CHILD_COLORS[i % RESP_CHILD_COLORS.length];
              return (
                <div key={child._id} style={{ display: "flex", alignItems: "center", gap: 10, background: `${color}0d`, border: `1px solid ${color}25`, borderRadius: 8, padding: "10px 16px", flex: "1 1 160px" }}>
                  <div style={{ width: 8, height: 8, borderRadius: "50%", background: color, flexShrink: 0 }} />
                  <div>
                    <div style={{ fontSize: 11, color, fontFamily: "'Space Mono',monospace", marginBottom: 2 }}>CHILD {i + 1}</div>
                    <div style={{ fontSize: 18, fontFamily: "'Playfair Display',serif", color: "#e0e0e0", fontWeight: 700 }}>{fmt(r.finalBal)}</div>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {children.map((child, i) => (
        <PersonRESP
          key={child._id}
          color={RESP_CHILD_COLORS[i % RESP_CHILD_COLORS.length]}
          label={`CHILD ${i + 1}`}
          child={child}
          onUpdate={(f, v) => updateChild(child._id, f, v)}
          onRemove={() => removeChild(child._id)}
          canRemove={children.length > 1}
          subscriberIncome={subscriberIncome}
          returnRate={returnRate}
          isMobile={isMobile}
          isNarrow={isNarrow}
        />
      ))}
    </>
  );
}

// ─── Withdrawal Optimizer ────────────────────────────────────────────────────

const OPT_COLOR = "#a78bfa";
const INHERIT_COLOR = "#f59e0b";

function runOptimizer({ rrsp, tfsa, nonReg, nonRegCostPct, otherIncome, spouseRRSP, spouseTFSA, spouseNonReg, spouseNonRegCostPct, spouseOtherIncome, targetWithdrawal, years, returnRate, hasSpouse, isEmigrating = false, departureYear = 0, maximizeInheritance = false }) {
  const withholdingRate = 25; // CRA non-resident withholding on RRSP: 25% flat (no treaty countries)
  // Cost basis % = fraction of current balance that is ACB. Gain ratio is constant: (1 - costBasis%).
  const gainRatio = Math.max(0, 1 - nonRegCostPct / 100);
  const gainRatioS = Math.max(0, 1 - spouseNonRegCostPct / 100);
  let rBal = rrsp, tBal = tfsa, nBal = nonReg;
  let rBalS = spouseRRSP, tBalS = spouseTFSA, nBalS = spouseNonReg;
  let deemedPaid = false; // after departure, no further Canadian capital gains on non-reg

  const rows = [];
  let totalDeemedTax = 0;
  let assetsAtDeparture = null;

  for (let yr = 1; yr <= years; yr++) {
    const remYears = years - yr + 1;

    rBal *= (1 + returnRate);
    tBal *= (1 + returnRate);
    nBal *= (1 + returnRate);
    if (hasSpouse) { rBalS *= (1 + returnRate); tBalS *= (1 + returnRate); nBalS *= (1 + returnRate); }

    // Deemed disposition on departure year (RRSP/TFSA exempt; non-reg capital gains taxed)
    let deemedTaxThisYear = 0;
    const isNonResident = isEmigrating && departureYear > 0 && yr >= departureYear;
    if (isEmigrating && departureYear > 0 && yr === departureYear) {
      // Gain = current balance × gain ratio (cost basis % of current balance)
      const selfGain = nBal * gainRatio;
      const spouseGain = hasSpouse ? nBalS * gainRatioS : 0;
      // Incremental tax: gain stacked on top of other income
      deemedTaxThisYear = (calcTax(otherIncome + selfGain * 0.5) - calcTax(otherIncome)) +
                          (hasSpouse ? calcTax(spouseOtherIncome + spouseGain * 0.5) - calcTax(spouseOtherIncome) : 0);
      deemedPaid = true; // ACB resets to FMV — no further Canadian capital gains on this account
      totalDeemedTax = deemedTaxThisYear;
      assetsAtDeparture = {
        rrsp: rBal + (hasSpouse ? rBalS : 0),
        tfsa: tBal + (hasSpouse ? tBalS : 0),
        nonReg: nBal + (hasSpouse ? nBalS : 0),
        deemedTax: deemedTaxThisYear,
      };
    }

    // RRSP: smooth draw over remaining years
    let rrspDraw = Math.min(rBal, rBal / remYears);
    let rrspDrawS = hasSpouse ? Math.min(rBalS, rBalS / remYears) : 0;
    const totalRRSPWant = rrspDraw + rrspDrawS;
    if (totalRRSPWant > targetWithdrawal) {
      const scale = targetWithdrawal / totalRRSPWant;
      rrspDraw *= scale; rrspDrawS *= scale;
    }
    rBal -= rrspDraw; rBalS -= rrspDrawS;

    let gap = targetWithdrawal - rrspDraw - rrspDrawS;

    // Gap fill: normal = TFSA → Non-Reg; inheritance = Non-Reg → TFSA (protect TFSA for heirs)
    let tfsaDraw = 0, tfsaDrawS = 0;
    let nRegDraw = 0, nRegDrawS = 0, nRegGain = 0, nRegGainS = 0;

    const fillFromTFSA = () => {
      const tot = tBal + (hasSpouse ? tBalS : 0);
      if (gap <= 0 || tot <= 0) return;
      const take = Math.min(tot, gap);
      const d = Math.min(tBal, take * (tBal / tot));
      const dS = hasSpouse ? Math.min(tBalS, take - d) : 0;
      tfsaDraw += d; tfsaDrawS += dS;
      tBal -= d; tBalS -= dS;
      gap -= (d + dS);
    };

    const fillFromNonReg = () => {
      const tot = nBal + (hasSpouse ? nBalS : 0);
      if (gap <= 0 || tot <= 0) return;
      const take = Math.min(tot, gap);
      const d = Math.min(nBal, nBal > 0 ? take * (nBal / tot) : 0);
      const dS = hasSpouse ? Math.min(nBalS, take - d) : 0;
      if (nBal > 0 && d > 0) { nRegGain += deemedPaid ? 0 : d * gainRatio; nBal -= d; }
      if (hasSpouse && nBalS > 0 && dS > 0) { nRegGainS += deemedPaid ? 0 : dS * gainRatioS; nBalS -= dS; }
      nRegDraw += d; nRegDrawS += dS;
      gap -= (d + dS);
    };

    if (maximizeInheritance) {
      fillFromNonReg(); // draw Non-Reg first to protect TFSA for tax-free inheritance
      fillFromTFSA();
    } else {
      fillFromTFSA();   // draw TFSA first to minimize current tax (no capital gains)
      fillFromNonReg();
    }

    let selfTax, spouseTax;
    if (isNonResident) {
      // Flat withholding on RRSP only; TFSA and Non-Reg have no Canadian tax as non-resident
      selfTax = rrspDraw * (withholdingRate / 100);
      spouseTax = hasSpouse ? rrspDrawS * (withholdingRate / 100) : 0;
    } else {
      selfTax = calcTax(otherIncome + rrspDraw + nRegGain * 0.5);
      spouseTax = hasSpouse ? calcTax(spouseOtherIncome + rrspDrawS + nRegGainS * 0.5) : 0;
    }

    const totalGross = rrspDraw + tfsaDraw + nRegDraw + rrspDrawS + tfsaDrawS + nRegDrawS;
    const withdrawalTax = selfTax + spouseTax;

    rows.push({
      year: yr,
      rrspDraw, tfsaDraw, nRegDraw,
      rrspDrawS, tfsaDrawS, nRegDrawS,
      selfTax, spouseTax,
      totalTax: withdrawalTax + deemedTaxThisYear,
      deemedTaxThisYear,
      totalGross, shortfall: Math.max(0, gap),
      netReceived: totalGross - withdrawalTax,
      rrspBal: rBal, tfsaBal: tBal, nRegBal: nBal,
      rrspBalS: rBalS, tfsaBalS: tBalS, nRegBalS: nBalS,
      isDeparture: isEmigrating && yr === departureYear && departureYear > 0,
      isNonResident,
    });
  }

  const estateRRSP = rBal + (hasSpouse ? rBalS : 0);
  const estateTFSA = tBal + (hasSpouse ? tBalS : 0);
  const estateNonReg = nBal + (hasSpouse ? nBalS : 0);
  // After deemed disposition, non-reg ACB = FMV, so no further Canadian capital gains
  const estateNRGain = deemedPaid ? 0 : nBal * gainRatio + (hasSpouse ? nBalS * gainRatioS : 0);
  const estateTax = calcTax(estateRRSP + estateNRGain * 0.5);

  return {
    rows,
    finalRRSP: rBal, finalTFSA: tBal, finalNonReg: nBal,
    finalRRSPS: rBalS, finalTFSAS: tBalS, finalNonRegS: nBalS,
    estate: estateRRSP + estateTFSA + estateNonReg,
    estateRRSP, estateTFSA, estateNonReg, estateNRGain,
    estateTax,
    totalTaxPaid: rows.reduce((a, r) => a + r.totalTax, 0),
    totalNetReceived: rows.reduce((a, r) => a + r.netReceived, 0),
    totalWithdrawn: rows.reduce((a, r) => a + r.totalGross, 0),
    totalDeemedTax,
    assetsAtDeparture,
  };
}

function OptimizerPage({ returnRate, setReturnRate }) {
  const isMobile = useWindowWidth() < 640;
  const isNarrow = useWindowWidth() < 900;

  const [hasSpouse, setHasSpouse] = useState(false);
  const [rrsp, setRrsp] = useState(300000);
  const [tfsa, setTfsa] = useState(100000);
  const [nonReg, setNonReg] = useState(0);
  const [nonRegCostPct, setNonRegCostPct] = useState(60);
  const [otherIncome, setOtherIncome] = useState(0);
  const [spouseRRSP, setSpouseRRSP] = useState(200000);
  const [spouseTFSA, setSpouseTFSA] = useState(80000);
  const [spouseNonReg, setSpouseNonReg] = useState(0);
  const [spouseNonRegCostPct, setSpouseNonRegCostPct] = useState(60);
  const [spouseOtherIncome, setSpouseOtherIncome] = useState(0);
  const [targetWithdrawal, setTargetWithdrawal] = useState(80000);
  const [years, setYears] = useState(30);
  const [isEmigrating, setIsEmigrating] = useState(false);
  const [departureYear, setDepartureYear] = useState(10);
  const [maximizeInheritance, setMaximizeInheritance] = useState(false);

  const results = useMemo(() => runOptimizer({
    rrsp, tfsa, nonReg, nonRegCostPct, otherIncome,
    spouseRRSP, spouseTFSA, spouseNonReg, spouseNonRegCostPct, spouseOtherIncome,
    targetWithdrawal, years, returnRate: returnRate / 100, hasSpouse,
    isEmigrating, departureYear, maximizeInheritance,
  }), [rrsp, tfsa, nonReg, nonRegCostPct, otherIncome, spouseRRSP, spouseTFSA, spouseNonReg, spouseNonRegCostPct, spouseOtherIncome, targetWithdrawal, years, returnRate, hasSpouse, isEmigrating, departureYear, maximizeInheritance]);

  const panelStyle = { background: "#0b0b1a", border: "1px solid #1c1c32", borderRadius: 12, padding: isMobile ? "16px 14px" : "24px 28px" };
  const labelStyle = { fontSize: 12, color: "#3a3a5a", letterSpacing: 2, marginBottom: 9, fontFamily: "'Space Mono',monospace" };

  const thStyle = { fontSize: 11, color: "#444", fontFamily: "'Space Mono',monospace", letterSpacing: 1, padding: "10px 12px", textAlign: "right", borderBottom: "1px solid #1a1a2e", whiteSpace: "nowrap" };
  const tdStyle = { fontSize: 13, fontFamily: "'Space Mono',monospace", padding: "8px 12px", textAlign: "right", borderBottom: "1px solid #111120" };

  return (
    <>
      <div style={{ marginBottom: 36 }}>
        <div style={{ fontSize: 12, color: OPT_COLOR, letterSpacing: 4, marginBottom: 8, fontFamily: "'Space Mono',monospace" }}>WITHDRAWAL OPTIMIZER · ONTARIO 2026</div>
        <h1 style={{ fontFamily: "'Playfair Display',serif", fontSize: isMobile ? 36 : 56, margin: "0 0 8px", fontWeight: 900, lineHeight: 1.05 }}>
          Withdrawal <span style={{ color: OPT_COLOR }}>Plan</span>
        </h1>
        <p style={{ color: "#3a3a5a", fontSize: 13, fontFamily: "'Space Mono',monospace", margin: 0, lineHeight: 1.8 }}>
          Optimal draw order: RRSP (smoothed) → TFSA → Non-Reg · Minimizes lifetime tax
        </p>
      </div>

      {/* Shared controls */}
      <div style={{ display: "flex", gap: 24, alignItems: "flex-end", marginBottom: 28, flexWrap: "wrap" }}>
        <div>
          <div style={labelStyle}>ANNUAL RETURN</div>
          <NumInput value={returnRate} onChange={setReturnRate} suffix="%" step={0.5} min={0} width={115} />
        </div>
        <div>
          <div style={labelStyle}>TARGET WITHDRAWAL / YR</div>
          <NumInput value={targetWithdrawal} onChange={setTargetWithdrawal} prefix="$" step={5000} min={0} width={170} />
        </div>
        <div>
          <div style={labelStyle}>NUMBER OF YEARS</div>
          <NumInput value={years} onChange={v => setYears(Math.max(1, Math.round(v)))} suffix="yrs" step={1} min={1} max={60} width={110} />
        </div>
        <div>
          <div style={labelStyle}>INCLUDE SPOUSE</div>
          <button onClick={() => setHasSpouse(s => !s)} style={{
            padding: "9px 18px", borderRadius: 6, border: `1px solid ${hasSpouse ? OPT_COLOR : "#252540"}`,
            background: hasSpouse ? `${OPT_COLOR}15` : "transparent", color: hasSpouse ? OPT_COLOR : "#444",
            fontFamily: "'Space Mono',monospace", fontSize: 12, cursor: "pointer",
          }}>{hasSpouse ? "Spouse: ON" : "Spouse: OFF"}</button>
        </div>
        <div>
          <div style={labelStyle}>MAXIMIZE INHERITANCE?</div>
          <button onClick={() => setMaximizeInheritance(s => !s)} style={{
            padding: "9px 18px", borderRadius: 6, border: `1px solid ${maximizeInheritance ? INHERIT_COLOR : "#252540"}`,
            background: maximizeInheritance ? `${INHERIT_COLOR}15` : "transparent", color: maximizeInheritance ? INHERIT_COLOR : "#444",
            fontFamily: "'Space Mono',monospace", fontSize: 12, cursor: "pointer",
          }}>{maximizeInheritance ? "Inheritance: ON" : "Inheritance: OFF"}</button>
        </div>
        <div>
          <div style={labelStyle}>MOVING ABROAD?</div>
          <button onClick={() => setIsEmigrating(s => !s)} style={{
            padding: "9px 18px", borderRadius: 6, border: `1px solid ${isEmigrating ? "#fb923c" : "#252540"}`,
            background: isEmigrating ? "#fb923c15" : "transparent", color: isEmigrating ? "#fb923c" : "#444",
            fontFamily: "'Space Mono',monospace", fontSize: 12, cursor: "pointer",
          }}>{isEmigrating ? "Emigrating: ON" : "Emigrating: OFF"}</button>
        </div>
        {isEmigrating && (
          <div>
            <div style={labelStyle}>DEPARTURE (YEAR #)</div>
            <NumInput value={departureYear} onChange={v => setDepartureYear(Math.max(1, Math.min(years, Math.round(v))))} suffix="yr" step={1} min={1} max={years} width={110} />
          </div>
        )}
      </div>

      {/* Account inputs */}
      <div style={{ display: "grid", gridTemplateColumns: hasSpouse && !isNarrow ? "1fr 1fr" : "1fr", gap: 16, marginBottom: 28 }}>
        {/* Self */}
        <div style={{ ...panelStyle, borderLeft: `3px solid ${OPT_COLOR}` }}>
          <div style={{ fontSize: 12, color: OPT_COLOR, letterSpacing: 3, fontFamily: "'Space Mono',monospace", marginBottom: 20 }}>SELF</div>
          <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
            {[
              ["RRSP BALANCE", rrsp, setRrsp, 10000],
              ["TFSA BALANCE", tfsa, setTfsa, 10000],
              ["NON-REG BALANCE", nonReg, setNonReg, 10000],
            ].map(([lbl, val, set, step]) => (
              <div key={lbl}>
                <div style={labelStyle}>{lbl}</div>
                <NumInput value={val} onChange={set} prefix="$" step={step} min={0} width={180} />
              </div>
            ))}
            {nonReg > 0 && (
              <div>
                <div style={labelStyle}>COST BASIS % OF BALANCE</div>
                <NumInput value={nonRegCostPct} onChange={setNonRegCostPct} suffix="%" step={5} min={0} max={100} width={120} />
              </div>
            )}
            <div>
              <div style={labelStyle}>OTHER INCOME / YR (CPP, OAS, pension)</div>
              <NumInput value={otherIncome} onChange={setOtherIncome} prefix="$" step={1000} min={0} width={180} />
            </div>
          </div>
        </div>

        {/* Spouse */}
        {hasSpouse && (
          <div style={{ ...panelStyle, borderLeft: "3px solid #c084fc" }}>
            <div style={{ fontSize: 12, color: "#c084fc", letterSpacing: 3, fontFamily: "'Space Mono',monospace", marginBottom: 20 }}>SPOUSE</div>
            <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
              {[
                ["RRSP BALANCE", spouseRRSP, setSpouseRRSP, 10000],
                ["TFSA BALANCE", spouseTFSA, setSpouseTFSA, 10000],
                ["NON-REG BALANCE", spouseNonReg, setSpouseNonReg, 10000],
              ].map(([lbl, val, set, step]) => (
                <div key={lbl}>
                  <div style={labelStyle}>{lbl}</div>
                  <NumInput value={val} onChange={set} prefix="$" step={step} min={0} width={180} />
                </div>
              ))}
              {spouseNonReg > 0 && (
                <div>
                  <div style={labelStyle}>COST BASIS % OF BALANCE</div>
                  <NumInput value={spouseNonRegCostPct} onChange={setSpouseNonRegCostPct} suffix="%" step={5} min={0} max={100} width={120} />
                </div>
              )}
              <div>
                <div style={labelStyle}>OTHER INCOME / YR (CPP, OAS, pension)</div>
                <NumInput value={spouseOtherIncome} onChange={setSpouseOtherIncome} prefix="$" step={1000} min={0} width={180} />
              </div>
            </div>
          </div>
        )}
      </div>

      {/* Summary */}
      {results && (
        <>
          <div style={{ background: "linear-gradient(135deg,#0c0c1c,#10101e)", border: `1px solid ${OPT_COLOR}20`, borderLeft: `4px solid ${OPT_COLOR}`, borderRadius: 12, padding: isMobile ? "16px 14px" : "24px 28px", marginBottom: 24 }}>
            <div style={{ fontSize: 12, color: OPT_COLOR, letterSpacing: 3, marginBottom: 18, fontFamily: "'Space Mono',monospace" }}>PLAN SUMMARY · {years} YEARS</div>
            <div style={{ display: "grid", gridTemplateColumns: isMobile ? "1fr 1fr" : "repeat(4,1fr)", gap: 20, marginBottom: 20 }}>
              {[
                ["Total Withdrawn", results.totalWithdrawn, "#e0e0e0"],
                ["Total Tax Paid", results.totalTaxPaid, "#ff6b6b"],
                ["Net Received", results.totalNetReceived, "#34d399"],
                ["Avg Tax Rate", results.totalWithdrawn > 0 ? results.totalTaxPaid / results.totalWithdrawn : 0, "#888", true],
                ["Estate Value", results.estate, OPT_COLOR],
                ["Est. Estate Tax", results.estateTax, "#ff6b6b66"],
                ["Final RRSP", results.finalRRSP + (hasSpouse ? results.finalRRSPS : 0), "#4fc3f7"],
                ["Final TFSA", results.finalTFSA + (hasSpouse ? results.finalTFSAS : 0), TFSA_COLOR],
              ].map(([l, v, c, isPct]) => (
                <div key={l}>
                  <div style={{ fontSize: 11, color: "#3a3a5a", fontFamily: "'Space Mono',monospace", marginBottom: 4 }}>{l}</div>
                  <div style={{ fontSize: isMobile ? 18 : 24, fontFamily: "'Playfair Display',serif", color: c, fontWeight: 700 }}>
                    {isPct ? pct(v) : fmt(v)}
                  </div>
                </div>
              ))}
            </div>
          </div>

          {/* Year-by-year table */}
          {maximizeInheritance && (() => {
            const netInheritance = results.estate - results.estateTax;
            const rrspDeathTax = calcTax(results.estateRRSP + results.estateNRGain * 0.5) - calcTax(results.estateNRGain * 0.5);
            const nrDeathTax = calcTax(results.estateNRGain * 0.5);
            return (
              <div style={{ background: "#0a0800", border: `1px solid ${INHERIT_COLOR}30`, borderLeft: `4px solid ${INHERIT_COLOR}`, borderRadius: 12, padding: isMobile ? "16px 14px" : "24px 28px", marginBottom: 24 }}>
                <div style={{ fontSize: 12, color: INHERIT_COLOR, letterSpacing: 3, marginBottom: 18, fontFamily: "'Space Mono',monospace" }}>ESTATE · WHAT YOUR HEIRS RECEIVE AFTER {years} YEARS</div>
                <div style={{ display: "grid", gridTemplateColumns: isMobile ? "1fr 1fr" : "repeat(3,1fr)", gap: 16, marginBottom: 20 }}>
                  {[
                    ["RRSP at Death", results.estateRRSP, `−${fmt(rrspDeathTax)} CRA (full income inclusion)`, "#4fc3f7", results.estateRRSP - rrspDeathTax],
                    ["TFSA at Death", results.estateTFSA, "Zero tax — 100% to heirs", TFSA_COLOR, results.estateTFSA],
                    ["Non-Reg at Death", results.estateNonReg, `−${fmt(nrDeathTax)} CRA (50% capital gains)`, "#34d399", results.estateNonReg - nrDeathTax],
                  ].map(([l, gross, sub, c, net]) => (
                    <div key={l} style={{ background: "#ffffff06", borderRadius: 8, padding: "14px 16px" }}>
                      <div style={{ fontSize: 11, color: "#3a3a5a", fontFamily: "'Space Mono',monospace", marginBottom: 6 }}>{l}</div>
                      <div style={{ fontSize: 11, color: "#444", fontFamily: "'Space Mono',monospace", marginBottom: 4 }}>Gross: {fmt(gross)}</div>
                      <div style={{ fontSize: isMobile ? 16 : 22, fontFamily: "'Playfair Display',serif", color: c, fontWeight: 700 }}>→ {fmt(net)}</div>
                      <div style={{ fontSize: 10, color: "#555", fontFamily: "'Space Mono',monospace", marginTop: 4, lineHeight: 1.6 }}>{sub}</div>
                    </div>
                  ))}
                </div>
                <div style={{ background: `${INHERIT_COLOR}0d`, border: `1px solid ${INHERIT_COLOR}30`, borderRadius: 8, padding: "14px 18px", display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: 12, marginBottom: 16 }}>
                  <div>
                    <div style={{ fontSize: 11, color: `${INHERIT_COLOR}80`, fontFamily: "'Space Mono',monospace", marginBottom: 4 }}>TOTAL NET INHERITANCE</div>
                    <div style={{ fontSize: isMobile ? 26 : 36, fontFamily: "'Playfair Display',serif", color: INHERIT_COLOR, fontWeight: 900 }}>{fmt(netInheritance)}</div>
                  </div>
                  <div style={{ fontSize: 11, color: "#555", fontFamily: "'Space Mono',monospace", lineHeight: 1.9, maxWidth: 420 }}>
                    Total estate tax: {fmt(results.estateTax)}{"\n"}
                    Effective rate on estate: {pct(results.estate > 0 ? results.estateTax / results.estate : 0)}{"\n"}
                    RRSP is fully taxed as income on death. TFSA passes tax-free.{"\n"}
                    Non-Reg: only 50% of gains taxed (50% inclusion rule).
                  </div>
                </div>
                <div style={{ fontSize: 11, color: `${INHERIT_COLOR}80`, fontFamily: "'Space Mono',monospace", lineHeight: 1.9, borderTop: `1px solid ${INHERIT_COLOR}20`, paddingTop: 14 }}>
                  Strategy active: Non-Reg drawn before TFSA to protect TFSA for tax-free inheritance.
                  RRSP drawn smoothly — to accelerate RRSP drawdown and further reduce death tax, increase your target annual withdrawal.
                </div>
              </div>
            );
          })()}

          {isEmigrating && results.assetsAtDeparture && (() => {
            const dep = results.assetsAtDeparture;
            const rrspNet = dep.rrsp * 0.75; // 25% flat withholding
            const nonRegNet = dep.nonReg - dep.deemedTax; // balance minus departure tax on gain
            const totalOut = rrspNet + dep.tfsa + nonRegNet;
            return (
              <div style={{ background: "#0f0a03", border: "1px solid #fb923c30", borderLeft: "4px solid #fb923c", borderRadius: 12, padding: isMobile ? "16px 14px" : "24px 28px", marginBottom: 24 }}>
                <div style={{ fontSize: 12, color: "#fb923c", letterSpacing: 3, marginBottom: 18, fontFamily: "'Space Mono',monospace" }}>EMIGRATION · YEAR {departureYear} DEPARTURE · WHAT YOU LEAVE WITH</div>
                <div style={{ display: "grid", gridTemplateColumns: isMobile ? "1fr 1fr" : "repeat(3,1fr)", gap: 20, marginBottom: 20 }}>
                  {[
                    ["RRSP → Lump Sum", dep.rrsp, rrspNet, "#4fc3f7", "25% CRA withholding (flat, final tax)"],
                    ["TFSA → Transfer", dep.tfsa, dep.tfsa, TFSA_COLOR, "Zero Canadian tax — 100% transferred"],
                    ["Non-Reg → Transfer", dep.nonReg, nonRegNet, "#34d399", "Deemed disposition on gain; ACB resets"],
                  ].map(([l, gross, net, c, sub]) => (
                    <div key={l} style={{ background: "#ffffff08", borderRadius: 8, padding: "14px 16px" }}>
                      <div style={{ fontSize: 11, color: "#3a3a5a", fontFamily: "'Space Mono',monospace", marginBottom: 6 }}>{l}</div>
                      <div style={{ fontSize: 11, color: "#444", fontFamily: "'Space Mono',monospace", marginBottom: 2 }}>Gross: {fmt(gross)}</div>
                      <div style={{ fontSize: isMobile ? 18 : 24, fontFamily: "'Playfair Display',serif", color: c, fontWeight: 700 }}>→ {fmt(net)}</div>
                      <div style={{ fontSize: 10, color: "#555", fontFamily: "'Space Mono',monospace", marginTop: 4, lineHeight: 1.6 }}>{sub}</div>
                    </div>
                  ))}
                </div>
                <div style={{ background: "#fb923c0d", border: "1px solid #fb923c30", borderRadius: 8, padding: "14px 18px", display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: 12 }}>
                  <div>
                    <div style={{ fontSize: 11, color: "#fb923c80", fontFamily: "'Space Mono',monospace", marginBottom: 4 }}>TOTAL ASSETS LEAVING CANADA</div>
                    <div style={{ fontSize: isMobile ? 26 : 36, fontFamily: "'Playfair Display',serif", color: "#fb923c", fontWeight: 900 }}>{fmt(totalOut)}</div>
                  </div>
                  <div style={{ fontSize: 11, color: "#555", fontFamily: "'Space Mono',monospace", lineHeight: 1.9, maxWidth: 400 }}>
                    Deemed disposition tax: {fmt(dep.deemedTax)} (non-reg gain at marginal rate, 50% inclusion){"\n"}
                    RRSP withheld: {fmt(dep.rrsp * 0.25)} (25% flat — final CRA obligation){"\n"}
                    Post-departure RRSP lump sum beats staying if your marginal rate {`>`} 25%
                  </div>
                </div>
              </div>
            );
          })()}

          <div style={{ fontSize: 12, color: "#3a3a5a", letterSpacing: 3, fontFamily: "'Space Mono',monospace", marginBottom: 12 }}>YEAR-BY-YEAR PLAN</div>
          <div style={{ background: "#0b0b1a", border: "1px solid #1c1c32", borderRadius: 12, overflow: "hidden", marginBottom: 28 }}>
            <div style={{ overflowX: "auto" }}>
              <table style={{ width: "100%", borderCollapse: "collapse" }}>
                <thead>
                  <tr>
                    <th style={{ ...thStyle, textAlign: "left", paddingLeft: 16 }}>YR</th>
                    <th style={{ ...thStyle, color: "#4fc3f788" }}>RRSP{hasSpouse ? " (S)" : ""}</th>
                    <th style={{ ...thStyle, color: `${TFSA_COLOR}88` }}>TFSA{hasSpouse ? " (S)" : ""}</th>
                    <th style={{ ...thStyle, color: "#34d39988" }}>Non-Reg{hasSpouse ? " (S)" : ""}</th>
                    <th style={{ ...thStyle, color: "#ff6b6b88" }}>TAX</th>
                    <th style={{ ...thStyle, color: "#34d399" }}>NET</th>
                    <th style={{ ...thStyle, color: "#4fc3f750" }}>RRSP Bal</th>
                    <th style={{ ...thStyle, color: `${TFSA_COLOR}50` }}>TFSA Bal</th>
                    <th style={{ ...thStyle, color: "#34d39950" }}>Non-Reg Bal</th>
                    <th style={{ ...thStyle, color: "#666" }}>Total Bal</th>
                  </tr>
                </thead>
                <tbody>
                  {results.rows.map(r => (
                    <tr key={r.year} style={{
                      background: r.isDeparture ? "#1a0c03" : r.shortfall > 0 ? "#1a0808" : r.isNonResident ? "#0d0a05" : "transparent",
                      borderLeft: r.isDeparture ? "3px solid #fb923c" : r.isNonResident ? "3px solid #fb923c30" : "none",
                    }}>
                      <td style={{ ...tdStyle, textAlign: "left", paddingLeft: 16, color: r.isDeparture ? "#fb923c" : r.isNonResident ? "#fb923c60" : "#3a3a5a" }}>
                        {r.year}{r.isDeparture ? " ✈" : ""}
                      </td>
                      <td style={{ ...tdStyle, color: "#4fc3f7" }}>
                        {fmt(r.rrspDraw)}{hasSpouse && r.rrspDrawS > 0 ? <span style={{ color: "#4fc3f750", fontSize: 11 }}> +{fmt(r.rrspDrawS)}</span> : ""}
                      </td>
                      <td style={{ ...tdStyle, color: TFSA_COLOR }}>
                        {fmt(r.tfsaDraw)}{hasSpouse && r.tfsaDrawS > 0 ? <span style={{ color: `${TFSA_COLOR}50`, fontSize: 11 }}> +{fmt(r.tfsaDrawS)}</span> : ""}
                      </td>
                      <td style={{ ...tdStyle, color: "#34d399" }}>
                        {fmt(r.nRegDraw)}{hasSpouse && r.nRegDrawS > 0 ? <span style={{ color: "#34d39950", fontSize: 11 }}> +{fmt(r.nRegDrawS)}</span> : ""}
                      </td>
                      <td style={{ ...tdStyle, color: "#ff6b6b" }}>
                        {fmt(r.totalTax)}
                        {r.deemedTaxThisYear > 0 && <div style={{ fontSize: 9, color: "#ff6b6b70", marginTop: 2 }}>incl. {fmt(r.deemedTaxThisYear)} deemed</div>}
                      </td>
                      <td style={{ ...tdStyle, color: "#34d399", fontWeight: 700 }}>{fmt(r.netReceived)}</td>
                      <td style={{ ...tdStyle, color: "#3a3a5a" }}>{fmt(r.rrspBal + (hasSpouse ? r.rrspBalS : 0))}</td>
                      <td style={{ ...tdStyle, color: "#3a3a5a" }}>{fmt(r.tfsaBal + (hasSpouse ? r.tfsaBalS : 0))}</td>
                      <td style={{ ...tdStyle, color: "#3a3a5a" }}>{fmt(r.nRegBal + (hasSpouse ? r.nRegBalS : 0))}</td>
                      <td style={{ ...tdStyle, color: "#555", fontWeight: 600 }}>{fmt(r.rrspBal + r.tfsaBal + r.nRegBal + (hasSpouse ? r.rrspBalS + r.tfsaBalS + r.nRegBalS : 0))}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {results.rows.some(r => r.shortfall > 0) && (
              <div style={{ padding: "12px 16px", background: "#1a0808", borderTop: "1px solid #2a1818", fontSize: 12, color: "#ff6b6b", fontFamily: "'Space Mono',monospace" }}>
                ⚠ Highlighted rows indicate accounts are exhausted — shortfall in meeting target withdrawal
              </div>
            )}
          </div>
        </>
      )}
    </>
  );
}

// ─── Main App ────────────────────────────────────────────────────────────────

export default function App() {
  const isMobile = useWindowWidth() < 640;
  const isNarrow = useWindowWidth() < 900;
  const [page, setPage] = useState("rrsp");
  const [returnRate, setReturnRate] = useState(7);

  // RRSP page state
  const [existingRRSPRoom, setExistingRRSPRoom] = useState(0);
  const [existingRRSPBal, setExistingRRSPBal] = useState(0);
  const [incomePhases, setIncomePhases] = useState([
    { income: 50000, years: 5 },
    { income: 100000, years: 5 },
    { income: 150000, years: 5 },
    { income: 200000, years: 10 },
  ]);
  const [withdrawalPhases, setWithdrawalPhases] = useState([
    { annualAmount: 80000, years: 20 },
  ]);
  const [splitMode, setSplitMode] = useState("single");

  const splitCount = splitMode === "split" ? 2 : 1;
  const updateIncome = (i, f, v) => setIncomePhases(p => p.map((x, j) => j === i ? { ...x, [f]: v } : x));
  const updateWithdraw = (i, f, v) => setWithdrawalPhases(phases => phases.map((x, j) => {
    if (j !== i) return x;
    const updated = { ...x, [f]: v };
    if (i === 0 && f === "years" && results?.s1?.gross > 0) {
      updated.annualAmount = Math.min(updated.annualAmount, Math.floor(results.s1.gross / v));
    }
    return updated;
  }));
  const results = useMemo(() =>
    runSimulation(incomePhases, withdrawalPhases, returnRate / 100, splitCount, existingRRSPRoom, existingRRSPBal),
    [incomePhases, withdrawalPhases, returnRate, splitCount, existingRRSPRoom, existingRRSPBal]
  );

  // Auto-clamp RRSP withdrawal phase 1 when accumulated balance changes (income phases change)
  useEffect(() => {
    const cap = results?.s1?.gross;
    if (!cap) return;
    setWithdrawalPhases(phases => phases.map((x, i) => {
      if (i !== 0) return x;
      const perYear = Math.floor(cap / x.years);
      return x.annualAmount > perYear ? { ...x, annualAmount: perYear } : x;
    }));
  }, [results?.s1?.gross]); // eslint-disable-line react-hooks/exhaustive-deps
  const ranked = results ? [results.s1, results.s2, results.s3].sort((a, b) => b.afterTax - a.afterTax) : [];
  const maxAfterTax = ranked.length ? ranked[0].afterTax : 1;
  const panelStyle = { background: "#0b0b1a", border: "1px solid #1c1c32", borderRadius: 12, padding: isMobile ? "16px 14px" : "24px 28px" };

  const pages = [
    { key: "rrsp", label: "RRSP", color: "#4fc3f7" },
    { key: "resp", label: "RESP", color: RESP_COLOR },
    { key: "tfsa", label: "TFSA", color: TFSA_COLOR },
    { key: "optimizer", label: "Withdrawal Plan", color: OPT_COLOR },
  ];

  return (
    <div style={{ minHeight: "100vh", background: "#07070f", color: "#f0f0f0", padding: isMobile ? "24px 14px" : "48px 28px" }}>
      <link href="https://fonts.googleapis.com/css2?family=Space+Mono:wght@400;700&family=Playfair+Display:wght@700;900&display=swap" rel="stylesheet" />
      <div style={{ maxWidth: 1280, margin: "0 auto" }}>

        {/* Nav + shared controls */}
        <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 40, flexWrap: "wrap", borderBottom: "1px solid #1c1c32", paddingBottom: 20 }}>
          <img src={logoSrc} alt="logo" style={{ height: isMobile ? 32 : 40, width: "auto", marginRight: 8 }} />
          {pages.map(({ key, label, color }) => (
            <button key={key} onClick={() => setPage(key)} style={{
              padding: "10px 24px", borderRadius: 7, cursor: "pointer",
              fontFamily: "'Space Mono',monospace", fontSize: 13, letterSpacing: 1, transition: "all 0.2s",
              border: page === key ? `1px solid ${color}` : "1px solid #252540",
              background: page === key ? `${color}15` : "transparent",
              color: page === key ? color : "#444",
              fontWeight: page === key ? 700 : 400,
            }}>{label}</button>
          ))}
          <div style={{ marginLeft: "auto", fontSize: 11, color: "#3a3a5a", fontFamily: "'Space Mono',monospace", whiteSpace: "nowrap" }}>
            {new Date().toLocaleDateString("en-CA", { year: "numeric", month: "short", day: "numeric" })}
          </div>
        </div>

        {/* TFSA page */}
        {page === "tfsa" && <TFSAPage returnRate={returnRate} setReturnRate={setReturnRate} />}

        {/* RESP page */}
        {page === "resp" && <RESPPage returnRate={returnRate} setReturnRate={setReturnRate} />}

        {/* Optimizer page */}
        {page === "optimizer" && <OptimizerPage returnRate={returnRate} setReturnRate={setReturnRate} />}

        {/* RRSP page */}
        {page === "rrsp" && <>

        {/* Header */}
        <div style={{ marginBottom: 36 }}>
          <div style={{ fontSize: 12, color: "#4fc3f7", letterSpacing: 4, marginBottom: 8, fontFamily: "'Space Mono',monospace" }}>REGISTERED RETIREMENT SAVINGS PLAN · ONTARIO 2026</div>
          <h1 style={{ fontFamily: "'Playfair Display',serif", fontSize: isMobile ? 36 : 56, margin: "0 0 8px", fontWeight: 900, lineHeight: 1.05 }}>
            RRSP <span style={{ color: "#34d399" }}>Simulator</span>
          </h1>
          <p style={{ color: "#3a3a5a", fontSize: 13, fontFamily: "'Space Mono',monospace", margin: 0, lineHeight: 1.8 }}>
            RRSP vs non-registered · Ontario combined federal + provincial rates
          </p>
        </div>

        {/* Controls row (RRSP-specific) */}
        <div style={{ display: "flex", gap: 28, alignItems: "flex-end", marginBottom: 28, flexWrap: "wrap" }}>
          <div>
            <div style={{ fontSize: 12, color: "#3a3a5a", letterSpacing: 2, marginBottom: 9, fontFamily: "'Space Mono',monospace" }}>ANNUAL RETURN</div>
            <NumInput value={returnRate} onChange={setReturnRate} suffix="%" step={0.5} min={0} width={115} />
          </div>
          <div>
            <div style={{ fontSize: 12, color: "#3a3a5a", letterSpacing: 2, marginBottom: 9, fontFamily: "'Space Mono',monospace" }}>WITHDRAWAL SPLIT</div>
            <div style={{ display: "flex", gap: 8 }}>
              {[["single", "Single"], ["split", "÷ 2 Spouse"]].map(([k, l]) => (
                <button key={k} onClick={() => setSplitMode(k)} style={{
                  padding: "9px 18px", borderRadius: 6, cursor: "pointer",
                  fontFamily: "'Space Mono',monospace", fontSize: 13, transition: "all 0.2s",
                  border: splitMode === k ? "1px solid #4fc3f7" : "1px solid #252540",
                  background: splitMode === k ? "#4fc3f710" : "transparent",
                  color: splitMode === k ? "#4fc3f7" : "#444",
                }}>{l}</button>
              ))}
            </div>
          </div>
          <div>
            <div style={{ fontSize: 12, color: "#3a3a5a", letterSpacing: 2, marginBottom: 9, fontFamily: "'Space Mono',monospace" }}>EXISTING RRSP ROOM</div>
            <NumInput value={existingRRSPRoom} onChange={setExistingRRSPRoom} prefix="$" step={5000} min={0} width={160} />
          </div>
          <div>
            <div style={{ fontSize: 12, color: "#3a3a5a", letterSpacing: 2, marginBottom: 9, fontFamily: "'Space Mono',monospace" }}>EXISTING RRSP BALANCE</div>
            <NumInput value={existingRRSPBal} onChange={setExistingRRSPBal} prefix="$" step={5000} min={0} width={160} />
          </div>
        </div>

        {/* Phase editors */}
        <div style={{ display: "grid", gridTemplateColumns: isNarrow ? "1fr" : "1fr 1fr", gap: 16, marginBottom: 22 }}>
          <div style={panelStyle}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 14 }}>
              <div>
                <div style={{ fontSize: 9, color: "#4fc3f7", letterSpacing: 3, fontFamily: "'Space Mono',monospace" }}>ACCUMULATION</div>
                <div style={{ fontSize: 9, color: "#3a3a5a", fontFamily: "'Space Mono',monospace", marginTop: 2 }}>{incomePhases.reduce((a, p) => a + p.years, 0)} yrs</div>
              </div>
              <button onClick={() => setIncomePhases(p => [...p, { income: 100000, years: 5 }])} style={{ background: "#4fc3f710", border: "1px solid #4fc3f730", borderRadius: 5, color: "#4fc3f7", cursor: "pointer", fontSize: 10, padding: "4px 10px", fontFamily: "'Space Mono',monospace" }}>+ Phase</button>
            </div>
            {incomePhases.map((p, i) => (
              <PhaseRow key={i} phase={p} index={i} type="income"
                onUpdate={updateIncome}
                onRemove={i2 => setIncomePhases(p => p.filter((_, j) => j !== i2))}
                canRemove={incomePhases.length > 1} />
            ))}
          </div>
          <div style={panelStyle}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 18 }}>
              <div>
                <div style={{ fontSize: 12, color: "#34d399", letterSpacing: 3, fontFamily: "'Space Mono',monospace" }}>WITHDRAWALS</div>
                <div style={{ fontSize: 12, color: "#3a3a5a", fontFamily: "'Space Mono',monospace", marginTop: 4 }}>{withdrawalPhases.reduce((a, p) => a + p.years, 0)} yrs · {fmt(withdrawalPhases.reduce((a, p) => a + p.annualAmount * p.years, 0))} total</div>
              </div>
              <button onClick={() => setWithdrawalPhases(p => [...p, { annualAmount: 60000, years: 10 }])} style={{ background: "#34d39910", border: "1px solid #34d39930", borderRadius: 5, color: "#34d399", cursor: "pointer", fontSize: 13, padding: "6px 14px", fontFamily: "'Space Mono',monospace" }}>+ Phase</button>
            </div>
            {withdrawalPhases.map((p, i) => {
              const s1Cap = i === 0 && results ? Math.floor(results.s1.gross / p.years) : null;
              const s1Left = i === 0 && results ? Math.max(0, results.s1.gross - p.annualAmount * p.years) : null;
              const hint = i === 0 && results ? `RRSP cap ${fmt(s1Cap)}/yr · ${fmt(s1Left)} left` : null;
              return (
                <PhaseRow key={i} phase={p} index={i} type="withdrawal"
                  onUpdate={updateWithdraw}
                  onRemove={i2 => setWithdrawalPhases(p => p.filter((_, j) => j !== i2))}
                  canRemove={withdrawalPhases.length > 1}
                  hint={hint} maxAmount={i === 0 ? s1Cap : undefined} />
              );
            })}
            <div style={{ marginTop: 14, padding: "10px 14px", background: "#08080f", borderRadius: 6, fontSize: 12, color: "#333", fontFamily: "'Space Mono',monospace", lineHeight: 1.8 }}>
              Remainder after all withdrawals taxed at end of period
            </div>
          </div>
        </div>

        {/* Result cards */}
        {results && (
          <>
            <div style={{ display: "flex", flexDirection: "column", gap: 12, marginBottom: 28 }}>
              <div style={{ fontSize: 12, color: "#3a3a5a", letterSpacing: 3, fontFamily: "'Space Mono',monospace", marginBottom: 4 }}>RESULTS — RANKED BY AFTER-TAX NET</div>
              {ranked.map((d, i) => <ResultCard key={d.label} data={d} rank={i + 1} max={maxAfterTax} />)}
            </div>

            {/* Withdrawal table */}
            <div style={{ fontSize: 12, color: "#3a3a5a", letterSpacing: 3, fontFamily: "'Space Mono',monospace", marginBottom: 12, marginTop: 4 }}>
              WITHDRAWAL BREAKDOWN
            </div>
            <WithdrawalTable results={results} />

            {/* Year-by-year accumulation table */}
            <div style={{ fontSize: 12, color: "#3a3a5a", letterSpacing: 3, fontFamily: "'Space Mono',monospace", marginBottom: 12, marginTop: 28 }}>
              YEAR-BY-YEAR ACCUMULATION
            </div>
            <YearlyTable results={results} />
          </>
        )}

        {/* Notes */}
        <div style={{ marginTop: 28, padding: "18px 22px", background: "#0a0a16", borderRadius: 8, border: "1px solid #141428" }}>
          <div style={{ fontSize: 12, color: "#2a2a48", letterSpacing: 2, marginBottom: 10, fontFamily: "'Space Mono',monospace" }}>METHODOLOGY</div>
          <div style={{ fontSize: 12, color: "#2a2a48", lineHeight: 2.2, fontFamily: "'Space Mono',monospace" }}>
            S1: each year invest RRSP room + refund (marginal rate × contrib) back into RRSP · S2: same contributions, hold deductions during low/mid years, spread prior pool evenly across all high-income years + claim each high year's own contrib immediately (no lump-sum, maximizes marginal refund rate) · Non-reg: invest exact same dollar amount as RRSP room each year — cost base never taxed, only gains at 50% inclusion · Withdrawals: tax calculated on each year's withdrawal only; remaining balance grows between years; final balance taxed as lump at end · No TFSA, CCB, OAS/CPP
          </div>
        </div>

        </>}
      </div>
    </div>
  );
}
