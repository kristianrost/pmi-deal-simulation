"use client";

import React, { useEffect, useMemo, useRef, useState } from "react";

type GateId = "DG1" | "DG2" | "DG3" | "DG4" | "DG5";
type OptionId = "A" | "B" | "C" | "D";

type Flags = {
  hardIntegration: boolean;
  fragileTalent: boolean;
  itDebt: boolean;

  // DG4 specific
  dg4_fullDelivery: boolean;
  dg4_credReset: boolean;
  dg4_strategicPrioritization: boolean;
  dg4_stabilityFirst: boolean;
};

type State = {
  share: number; // index (70..130)
  synergy: number; // % of 750m target (0..100, but capped by synergyCeiling)
  attrition: number; // % (2..12)
  cred: number; // 0..100
  risk: number; // 0..100
  capacity: number; // 0..100

  synergyCeiling: number; // 60..100
  flags: Flags;
};

type Choice = { gate: GateId; option: OptionId };

type HistoryEntry = {
  gate: GateId;
  choice: Choice;
  grade?: number; // 1..6 presentation grade per gate
  prev: State;
  next: State;
  deltas: {
    share: number;
    synergy: number;
    attrition: number;
    cred: number;
    risk: number;
    capacity: number;
    synergyCeiling: number;
  };
  feasibility: number;
  note: string;
};

type OptionDef = {
  id: OptionId;
  title: string;
  blurb: string;

  // base synergy in percentage points (pp) of 750m
  baseSynergy: number;

  // deltas
  dAttrition: number; // pp
  dRisk: number;
  dCred: number;
  dCapacity: number;

  // DG4 extras (optional)
  dg4Ceiling?: number; // set synergyCeiling to this
  dg4GuidanceShock?: number; // immediate share impact (negative for resets)
  setFlags?: Partial<Flags>;
};

type GateDef = {
  id: GateId;
  title: string;
  context: string;
  options: OptionDef[];
};

const STORAGE_KEY = "pmi_sim_v4_grade_traffic_charts";

// ---------- helpers ----------
function clamp(min: number, v: number, max: number) {
  return Math.max(min, Math.min(max, v));
}
function round1(v: number) {
  return Math.round(v * 10) / 10;
}
function fmt1(v: number) {
  return round1(v).toFixed(1);
}

function norm(value: number, min: number, max: number) {
  if (max === min) return 0;
  return clamp(0, ((value - min) / (max - min)) * 100, 100);
}

// ---------- PMI Robustness Index (penalty + caps) ----------

function scoreShare(share: number) {
  // slightly stricter at the top end
  if (share >= 128) return 100;
  if (share >= 120) return 90;
  if (share >= 110) return 75;
  if (share >= 100) return 60;
  if (share >= 90) return 45;
  return 30;
}

function scoreSynergy(syn: number) {
  // make 100 rare: requires really strong synergy delivery
  if (syn >= 35) return 100;
  if (syn >= 30) return 90;
  if (syn >= 25) return 75;
  if (syn >= 20) return 60;
  if (syn >= 15) return 45;
  return 30;
}

function scoreAttrition(attr: number) {
  // very low attrition should be rewarded, but 100 is rare
  if (attr <= 2.5) return 100;
  if (attr <= 3.5) return 90;
  if (attr <= 5.0) return 75;
  if (attr <= 7.0) return 60;
  if (attr <= 9.0) return 45;
  return 30;
}

function computeRobustnessIndex(s: State) {
  // 1) Base score: only the 3 "outcome KPIs"
  const base =
    scoreShare(s.share) * 0.45 +
    scoreSynergy(s.synergy) * 0.35 +
    scoreAttrition(s.attrition) * 0.20;

  // 2) Penalties: execution reality checks
  // Credibility: below 70 starts hurting noticeably
  const credPenalty = Math.max(0, 70 - s.cred) * 0.35; // max ~24.5 at cred=0

  // Risk: above 60 hurts; above 80 hurts more
  const riskPenalty =
    Math.max(0, s.risk - 60) * 0.55 +      // mild
    Math.max(0, s.risk - 80) * 0.65;       // extra steep in the danger zone

  // Capacity: below 55 hurts; below 40 hurts more
  const capPenalty =
    Math.max(0, 55 - s.capacity) * 0.45 +
    Math.max(0, 40 - s.capacity) * 0.70;

  // combo overload (this is the "you are breaking the org" penalty)
  const overloadPenalty =
    (s.risk >= 85 && s.capacity <= 35) ? 10 :
    (s.risk >= 80 && s.capacity <= 40) ? 6 :
    0;

  let score = base - credPenalty - riskPenalty - capPenalty - overloadPenalty;

  // 3) Hard caps (prevents ridiculous 90+ under red conditions)
  // If you're in red zones, you cannot be "robust".
  if (s.risk >= 85) score = Math.min(score, 75);
  if (s.capacity <= 30) score = Math.min(score, 78);
  if (s.risk >= 85 && s.capacity <= 30) score = Math.min(score, 65);

  return Math.round(clamp(0, score, 100));
}

function signed(delta: number, digits: 1 | 2 = 1) {
  const v = digits === 1 ? round1(delta) : Math.round(delta * 100) / 100;
  const s = v > 0 ? "+" : v < 0 ? "−" : "±";
  const n = Math.abs(v).toFixed(digits === 1 ? 1 : 2);
  return `${s}${n}`;
}
function badgeClass(delta: number) {
  if (delta > 0.00001) return "bg-emerald-500/15 text-emerald-200 ring-1 ring-emerald-400/30";
  if (delta < -0.00001) return "bg-rose-500/15 text-rose-200 ring-1 ring-rose-400/30";
  return "bg-slate-500/15 text-slate-200 ring-1 ring-slate-400/30";
}
function deepCopyState(s: State): State {
  return JSON.parse(JSON.stringify(s)) as State;
}

// ---------- traffic lights for drivers ----------
type Traffic = "green" | "yellow" | "red";

function trafficForDriver(name: "cred" | "risk" | "capacity", v: number): Traffic {
  if (name === "cred") {
    if (v >= 70) return "green";
    if (v >= 50) return "yellow";
    return "red";
  }
  if (name === "risk") {
    if (v <= 45) return "green";
    if (v <= 70) return "yellow";
    return "red";
  }
  // capacity
  if (v >= 65) return "green";
  if (v >= 40) return "yellow";
  return "red";
}

function trafficClasses(t: Traffic) {
  if (t === "green") {
    return {
      ring: "ring-emerald-400/25",
      bar: "bg-emerald-400/80",
      text: "text-emerald-200",
      badge: "bg-emerald-500/15 text-emerald-200 ring-1 ring-emerald-400/25",
    };
  }
  if (t === "yellow") {
    return {
      ring: "ring-amber-400/25",
      bar: "bg-amber-300/80",
      text: "text-amber-200",
      badge: "bg-amber-500/15 text-amber-200 ring-1 ring-amber-400/25",
    };
  }
  return {
    ring: "ring-rose-400/25",
    bar: "bg-rose-400/80",
    text: "text-rose-200",
    badge: "bg-rose-500/15 text-rose-200 ring-1 ring-rose-400/25",
  };
}

// ---------- Trend chart with markers ----------
type MarkerMode = "normal" | "invert";
/**
 * normal:  green on breakout (delta >= breakoutThreshold), red on drop (delta <= dropThreshold)
 * invert:  for "lower is better" (Attrition): green on drop, red on spike
 */
function TrendLine({
  values,
  minY,
  maxY,
  width = 520,
  height = 160,
  padX = 26,
  padY = 24,
  dropThreshold,
  breakoutThreshold,
  mode = "normal",
  startLabel = "DG0",
}: {
  values: number[];
  minY?: number;
  maxY?: number;
  width?: number;
  height?: number;
  padX?: number;
  padY?: number;
  dropThreshold: number;
  breakoutThreshold: number;
  mode?: MarkerMode;
  startLabel?: string;
}) {
  const n = values.length;
  if (!n) return null;

  const rawMin = minY ?? Math.min(...values);
  const rawMax = maxY ?? Math.max(...values);
  const minV = rawMin === rawMax ? rawMin - 1 : rawMin;
  const maxV = rawMin === rawMax ? rawMax + 1 : rawMax;

  const dx = (width - padX * 2) / Math.max(1, n - 1);

  const y = (v: number) => {
    const vv = clamp(minV, v, maxV);
    return height - padY - ((vv - minV) / (maxV - minV)) * (height - padY * 2);
  };
  const x = (i: number) => padX + i * dx;

  const pts = values.map((v, i) => ({
    i,
    v,
    x: x(i),
    y: y(v),
    delta: i === 0 ? 0 : v - values[i - 1],
  }));

  const path = pts.map((p, i) => `${i === 0 ? "M" : "L"} ${p.x.toFixed(2)} ${p.y.toFixed(2)}`).join(" ");

  const markerColor = (delta: number, i: number) => {
    if (i === 0) return "#cbd5e1";
    const isBreakout = delta >= breakoutThreshold;
    const isDrop = delta <= dropThreshold;

    if (mode === "normal") {
      if (isBreakout) return "#22c55e";
      if (isDrop) return "#ef4444";
      return "#cbd5e1";
    } else {
      if (isBreakout) return "#ef4444";
      if (isDrop) return "#22c55e";
      return "#cbd5e1";
    }
  };

  // simple grid lines (4)
  const gridVals = [minV, minV + (maxV - minV) / 3, minV + (2 * (maxV - minV)) / 3, maxV].map((v) =>
    Math.round(v * 10) / 10
  );

  return (
    <svg viewBox={`0 0 ${width} ${height}`} className="w-full h-40 rounded-2xl bg-slate-950/40 ring-1 ring-white/10">
      {gridVals.map((gv, idx) => {
        const yy = y(gv);
        return (
          <line
            key={idx}
            x1={padX}
            y1={yy}
            x2={width - padX}
            y2={yy}
            stroke="rgba(255,255,255,0.06)"
            strokeWidth="1"
          />
        );
      })}

      <path d={path} fill="none" stroke="rgba(203,213,225,0.9)" strokeWidth="2.2" />

      {pts.map((p) => (
        <circle
          key={p.i}
          cx={p.x}
          cy={p.y}
          r={5.2}
          fill={markerColor(p.delta, p.i)}
          stroke="rgba(15,23,42,0.95)"
          strokeWidth="2"
        />
      ))}

      {pts.map((p) => {
        const txt = p.i === 0 ? startLabel : `DG${p.i}`;
        return (
          <text
            key={`t${p.i}`}
            x={p.x}
            y={height - 8}
            textAnchor="middle"
            fontSize="10"
            fill="rgba(203,213,225,0.65)"
          >
            {txt}
          </text>
        );
      })}
    </svg>
  );
}

// ---------- grade model (ONLY affects Share/Synergy/Attrition) ----------
function gradeToScore(grade: number) {
  // 1 = very good, 6 = bad
  // Score in [-1..+1], neutral at 3.5
  const s = (3.5 - grade) / 2.5;
  return clamp(-1, s, 1);
}

function applyPresentationGrade(nextIn: State, grade: number, feasibility: number) {
  const s = deepCopyState(nextIn);
  const score = gradeToScore(grade);

  const dShare = 2.2 * score; // max +/- 2.2
  const dSynergy = 1.2 * score * feasibility; // small alignment effect
  const dAttr = -0.25 * score; // good presentation slightly reduces attrition

  s.share = clamp(70, s.share + dShare, 130);
  s.synergy = clamp(0, s.synergy + dSynergy, s.synergyCeiling);
  s.attrition = clamp(2, s.attrition + dAttr, 12);

  return { next: s, deltas: { dShare, dSynergy, dAttr } };
}

// ---------- model ----------
const initialState: State = {
  share: 100,
  synergy: 0,
  attrition: 4.0,
  cred: 55,
  risk: 45,
  capacity: 70,
  synergyCeiling: 100,
  flags: {
    hardIntegration: false,
    fragileTalent: false,
    itDebt: false,

    dg4_fullDelivery: false,
    dg4_credReset: false,
    dg4_strategicPrioritization: false,
    dg4_stabilityFirst: false,
  },
};

const gates: GateDef[] = [
  {
    id: "DG1",
    title: "DG1 — Target Operating Model",
    context: "What is the right level and speed of integration to create a stable and sustainable operating model?",
    options: [
      {
        id: "A",
        title: "Fast track integration",
        blurb:
          "Rapid and centralized absorption to establish one unified operating model quickly. Accelerated migration and tight IMO control — strong value narrative, but high execution strain.",
        baseSynergy: 16,
        dAttrition: +1.0,
        dRisk: +10,
        dCred: +6,
        dCapacity: -10,
        setFlags: { hardIntegration: true },
      },
      {
        id: "B",
        title: "Standard integration",
        blurb:
          "Structured full integration toward a harmonized target operating model. Phased migration in waves with change & communication program — balancing speed and stability.",
        baseSynergy: 12,
        dAttrition: +0.5,
        dRisk: +5,
        dCred: +4,
        dCapacity: -7,
      },
      {
        id: "C",
        title: "Selective functional integration (Hybrid Model)",
        blurb:
          "Strategic alignment with selective functional harmonization. Governance & reporting early; integrate selected functions while preserving autonomy in critical areas.",
        baseSynergy: 9,
        dAttrition: -0.2,
        dRisk: +3,
        dCred: +2,
        dCapacity: -5,
      },
      {
        id: "D",
        title: "“Light Touch” integration",
        blurb:
          "Selective strategic integration while preserving operational autonomy. Focus on high-impact synergies and governance alignment — minimal disruption, but slower value capture.",
        baseSynergy: 6,
        dAttrition: -0.4,
        dRisk: +1,
        dCred: -1,
        dCapacity: -3,
      },
    ],
  },
  {
    id: "DG2",
    title: "DG2 — Talent & Culture",
    context: "How do you stabilize critical talent while shaping the cultural integration model and execution discipline?",
    options: [
      {
        id: "A",
        title: "Strong retention focus",
        blurb:
          "Prioritize stabilization of critical talent and protect innovation capacity before enforcing structural alignment. Targeted retention packages, autonomy zones for R&D, cultural grace period.",
        baseSynergy: 6,
        dAttrition: -1.2,
        dRisk: -3,
        dCred: +1,
        dCapacity: -4,
        setFlags: { fragileTalent: false },
      },
      {
        id: "B",
        title: "Structured cultural integration",
        blurb:
          "Accelerate harmonization into Siemens Healthineers governance and operating framework. Rapid decision alignment, governance standardization, leadership alignment workshops.",
        baseSynergy: 10,
        dAttrition: +1.0,
        dRisk: +5,
        dCred: +4,
        dCapacity: -6,
      },
      {
        id: "C",
        title: "Dual culture strategy",
        blurb:
          "Balance autonomy and integration through phased convergence and structured cross-functional collaboration. Selective retention measures and defined cultural convergence roadmap.",
        baseSynergy: 8,
        dAttrition: +0.3,
        dRisk: +3,
        dCred: +2,
        dCapacity: -5,
      },
      {
        id: "D",
        title: "Performance-Driven selection",
        blurb:
          "Enforce rapid integration and allow natural attrition to shape the future organization. No targeted retention programs; performance-based cultural adaptation.",
        baseSynergy: 12,
        dAttrition: +2.0,
        dRisk: +8,
        dCred: +3,
        dCapacity: -8,
        setFlags: { fragileTalent: true },
      },
    ],
  },
  {
    id: "DG3",
    title: "DG3 - IT Data Strategy",
    context:
      "What is the right level of system harmonization to enable synergy realization while managing operational risk and IT capacity constraints?",
    options: [
      {
        id: "A",
        title: "Full System Integration",
        blurb:
          "Migrate core systems (ERP, CRM, reporting) into one harmonized SHS environment within 12–18 months. Single target architecture, rapid migration roadmap, centralized data governance.",
        baseSynergy: 15,
        dAttrition: +0.5,
        dRisk: +12,
        dCred: +6,
        dCapacity: -14,
      },
      {
        id: "B",
        title: "Phased Integration",
        blurb:
          "Gradual system harmonization prioritizing high-impact interfaces. ERP alignment in waves with parallel run during transition — balanced risk profile.",
        baseSynergy: 11,
        dAttrition: +0.2,
        dRisk: +6,
        dCred: +4,
        dCapacity: -8,
      },
      {
        id: "C",
        title: "Data Layer Strategy (Virtual Integration)",
        blurb:
          "Keep core systems separate and integrate via unified data platform and analytics layer. Faster transparency with minimal ERP migration — but creates future integration debt.",
        baseSynergy: 8,
        dAttrition: +0.1,
        dRisk: +3,
        dCred: +3,
        dCapacity: -6,
        setFlags: { itDebt: true },
      },
      {
        id: "D",
        title: "Standalone IT Model",
        blurb:
          "Maintain both IT landscapes largely independent with minimal integration. Only essential interfaces; no major migration — maximum stability but limits synergies.",
        baseSynergy: 4,
        dAttrition: 0.0,
        dRisk: -2,
        dCred: -4,
        dCapacity: -2,
      },
    ],
  },
  {
    id: "DG4",
    title: "DG4 - Synergies",
    context:
      "A gap has emerged versus the original synergy case. You must decide how to balance ambition, delivery credibility, and operational stability — under market pressure.",
    options: [
      {
        id: "A",
        title: "Full Delivery Commitment",
        blurb:
          "Reconfirm the €750m target and close the gap via accelerated execution: push revenue, tighten governance, accelerate IT, increase restructuring intensity.",
        baseSynergy: 16,
        dAttrition: +1.5,
        dRisk: +14,
        dCred: +5,
        dCapacity: -14,
        dg4Ceiling: 100,
        dg4GuidanceShock: 0,
        setFlags: { dg4_fullDelivery: true },
      },
      {
        id: "B",
        title: "Credibility Reset",
        blurb:
          "Adjust external commitment to a more realistic outlook (~€600–650m). Prioritize operational/cost synergies and stabilize the IT timeline to protect delivery credibility.",
        baseSynergy: 8,
        dAttrition: -0.6,
        dRisk: -10,
        dCred: -5,
        dCapacity: +6,
        dg4Ceiling: 90,
        dg4GuidanceShock: -4.0,
        setFlags: { dg4_credReset: true },
      },
      {
        id: "C",
        title: "Strategic Prioritization",
        blurb:
          "Maintain high ambition (~€680–700m) but reallocate focus to high-value strategic synergies while phasing execution in waves.",
        baseSynergy: 12,
        dAttrition: +0.4,
        dRisk: +4,
        dCred: +3,
        dCapacity: -5,
        dg4Ceiling: 95,
        dg4GuidanceShock: -1.0,
        setFlags: { dg4_strategicPrioritization: true },
      },
      {
        id: "D",
        title: "Stability First",
        blurb:
          "Shift focus from synergy maximization to business continuity and integration stabilization: pause non-critical revenue initiatives, extend IT timelines, reduce restructuring intensity.",
        baseSynergy: 6,
        dAttrition: -1.0,
        dRisk: -12,
        dCred: -8,
        dCapacity: +10,
        dg4Ceiling: 80,
        dg4GuidanceShock: -6.0,
        setFlags: { dg4_stabilityFirst: true },
      },
    ],
  },
  {
    id: "DG5",
    title: "DG5 — PMI Reset",
    context:
      "You must decide whether to stay the course or recalibrate. The market rewards credibility — but punishes unmanaged execution risk and organizational overload.",
    options: [
      {
        id: "A",
        title: "Stay the Course",
        blurb:
          "Hold the line and push forward. Protects the narrative, but can amplify execution risk if the engine is unstable.",
        baseSynergy: 10,
        dAttrition: +0.6,
        dRisk: +4,
        dCred: +4,
        dCapacity: -8,
      },
      {
        id: "B",
        title: "Stabilize Execution",
        blurb:
          "Slow down and fix delivery fundamentals. Reduces risk and fatigue, but may be seen as loss of momentum.",
        baseSynergy: 6,
        dAttrition: -0.4,
        dRisk: -8,
        dCred: -1,
        dCapacity: +4,
      },
      {
        id: "C",
        title: "Targeted Reprioritization",
        blurb:
          "Surgical reset: keep value levers, remove overload. Strong compromise if the organization is close to the edge.",
        baseSynergy: 8,
        dAttrition: 0.0,
        dRisk: -4,
        dCred: +2,
        dCapacity: +2,
      },
      {
        id: "D",
        title: "Structural Reset",
        blurb:
          "Major governance and operating reset. Can restore control, but creates uncertainty and credibility shock.",
        baseSynergy: 7,
        dAttrition: +0.3,
        dRisk: -2,
        dCred: -3,
        dCapacity: -1,
      },
    ],
  },
];

function computeFeasibility(attrition: number, capacity: number) {
  const f1 = clamp(0.6, 1 - attrition / 20, 1.0);
  const f2 = clamp(0.7, capacity / 100, 1.0);
  return f1 * f2;
}

function marketNote(gateId: GateId, o: OptionDef, next: State) {
  if (gateId === "DG4") {
    if (o.id === "A")
      return "Market initially rewards commitment — but the organization is now running hot. Execution discipline becomes the gating factor.";
    if (o.id === "B")
      return "Market reacts negatively to a reset, but delivery probability improves. Credibility depends on proving control in the next quarter.";
    if (o.id === "C")
      return "Market sees a pragmatic pivot: ambition remains, sequencing improves. Success depends on coordination and wave execution.";
    if (o.id === "D") return "Market reads a defensive move. Stability improves, but the value narrative weakens and momentum becomes harder to regain.";
  }

  const parts: string[] = [];
  if (o.dCred >= 4) parts.push("Market rewards a credible narrative");
  else if (o.dCred <= -3) parts.push("Market questions the strategic direction");

  if (o.dRisk >= 8) parts.push("and penalizes elevated execution risk");
  else if (o.dRisk <= -6) parts.push("and values visible risk reduction");

  if (o.dAttrition >= 1.2) parts.push("while talent instability raises concern");
  else if (o.dAttrition <= -0.6) parts.push("while improved retention supports delivery");

  if (next.risk >= 85 || next.capacity <= 30) parts.push("— systemic overload signals increase the chance of a sharp correction.");

  if (!parts.length) return "Market reaction is muted; signal strength remains limited.";
  return (parts.join(" ") + (parts.join(" ").endsWith(".") ? "" : ".")).replace("..", ".");
}

function applyDecision(prev: State, gate: GateDef, option: OptionDef): { next: State; feasibility: number; note: string } {
  const s = deepCopyState(prev);

  // 1) Immediate updates
  s.cred = clamp(0, s.cred + option.dCred, 100);
  s.risk = clamp(0, s.risk + option.dRisk, 100);
  s.capacity = clamp(0, s.capacity + option.dCapacity, 100);
  s.attrition = clamp(2, s.attrition + option.dAttrition, 12);

  // 2) Flags
  if (option.setFlags) s.flags = { ...s.flags, ...option.setFlags };

  // 3) DG4 ceiling
  if (gate.id === "DG4" && typeof option.dg4Ceiling === "number") {
    s.synergyCeiling = clamp(60, option.dg4Ceiling, 100);
  }

  // 4) Synergy update
  const feasibility = computeFeasibility(s.attrition, s.capacity);
  const synergyNext = s.synergy + option.baseSynergy * feasibility;
  s.synergy = clamp(0, synergyNext, s.synergyCeiling);

  // 4b) Synergy leakage under systemic stress
  const overloadSignals = (s.risk > 85 ? 1 : 0) + (s.capacity < 30 ? 1 : 0) + (s.attrition > 9 ? 1 : 0);
  if (overloadSignals === 2) s.synergy = clamp(0, s.synergy * 0.94, s.synergyCeiling);
  if (overloadSignals === 3) s.synergy = clamp(0, s.synergy * 0.90, s.synergyCeiling);

  // 5) Share update (base)
  const shareDelta = 0.35 * option.baseSynergy + 0.10 * option.dCred - 0.12 * option.dRisk - 0.18 * option.dAttrition;
  s.share = clamp(70, s.share + shareDelta, 130);

  // 6) DG4 guidance shock
  if (gate.id === "DG4" && typeof option.dg4GuidanceShock === "number" && option.dg4GuidanceShock !== 0) {
    s.share = clamp(70, s.share + option.dg4GuidanceShock, 130);
  }

  // 7) Delayed effects
  if (s.flags.itDebt && (gate.id === "DG4" || gate.id === "DG5") && option.baseSynergy >= 10) {
    s.risk = clamp(0, s.risk + 6, 100);
    s.capacity = clamp(0, s.capacity - 6, 100);
  }

  if (s.flags.fragileTalent && gate.id === "DG4" && (option.id === "A" || option.id === "C")) {
    s.attrition = clamp(2, s.attrition + 1.0, 12);
  }

  if (gate.id === "DG5" && option.id === "A") {
    if (prev.flags.dg4_fullDelivery && prev.risk > 70) {
      s.risk = clamp(0, s.risk + 8, 100);
      s.cred = clamp(0, s.cred - 4, 100);
      s.attrition = clamp(2, s.attrition + 0.8, 12);
    }
    if (prev.flags.hardIntegration) {
      s.risk = clamp(0, s.risk + 5, 100);
      s.cred = clamp(0, s.cred - 2, 100);
    }
  }

  if (gate.id === "DG5" && (option.id === "B" || option.id === "C") && prev.flags.dg4_credReset) {
    s.cred = clamp(0, s.cred + 3, 100);
    s.share = clamp(70, s.share + 1.2, 130);
  }

  if (gate.id === "DG5" && option.id === "A" && prev.flags.dg4_stabilityFirst) {
    s.cred = clamp(0, s.cred - 4, 100);
    s.share = clamp(70, s.share - 1.5, 130);
  }

  if (gate.id === "DG5" && option.id === "B" && s.synergy < 35) {
    s.cred = clamp(0, s.cred - 3, 100);
  }

  // ---- SYSTEMIC STRESS ENGINE (Non-linear) ----

let stressPenalty = 0;

// escalating risk zones
if (s.risk > 75) stressPenalty += (s.risk - 75) * 0.15;
if (s.risk > 85) stressPenalty += (s.risk - 85) * 0.35;
if (s.risk > 92) stressPenalty += (s.risk - 92) * 0.75;

// capacity amplification
if (s.capacity < 40) stressPenalty += (40 - s.capacity) * 0.20;
if (s.capacity < 30) stressPenalty += (30 - s.capacity) * 0.40;

// combined systemic overload multiplier
if (s.risk > 85 && s.capacity < 35) {
  stressPenalty *= 1.5;
}

// apply share penalty
if (stressPenalty > 0) {
  s.share = clamp(70, s.share - stressPenalty, 130);
}

// ---- Immediate credibility hit when system is overstretched ----
if (s.risk > 85 && s.capacity < 35) {
  const credHit = 4 + Math.round((s.risk - 85) * 0.3) + Math.round((35 - s.capacity) * 0.2);
  s.cred = clamp(0, s.cred - credHit, 100);
}

// synergy erosion under collapse
if (s.risk > 85 && s.capacity < 35) {
  const erosion = 0.05 + (s.risk - 85) * 0.002; // up to ~10%
  s.synergy = clamp(0, s.synergy * (1 - erosion), s.synergyCeiling);
}

  // final clamp
  s.share = clamp(70, s.share, 130);
  s.synergy = clamp(0, s.synergy, s.synergyCeiling);
  s.attrition = clamp(2, s.attrition, 12);
  s.cred = clamp(0, s.cred, 100);
  s.risk = clamp(0, s.risk, 100);
  s.capacity = clamp(0, s.capacity, 100);
  s.synergyCeiling = clamp(60, s.synergyCeiling, 100);

  const note = marketNote(gate.id, option, s);
  return { next: s, feasibility, note };
}

// ---------- UI components ----------
function DriverBar({
  label,
  value,
  kind,
}: {
  label: string;
  value: number;
  kind: "cred" | "risk" | "capacity";
}) {
  const v = clamp(0, value, 100);
  const t = trafficForDriver(kind, v);
  const c = trafficClasses(t);

  return (
    <div className={`rounded-xl bg-slate-900/30 ring-1 ${c.ring} p-3`}>
      <div className="flex items-center justify-between">
        <div className="text-xs text-slate-200/80">{label}</div>
        <span className={`px-2 py-0.5 rounded-full text-[11px] font-medium ${c.badge}`}>{t.toUpperCase()}</span>
      </div>

      <div className="mt-2 flex items-center justify-between text-xs">
        <span className={`font-medium ${c.text}`}>{Math.round(v)} / 100</span>
        <span className="text-slate-300/60">{kind === "risk" ? "lower is better" : "higher is better"}</span>
      </div>

      <div className="mt-2 h-2 rounded-full bg-slate-800/60 overflow-hidden">
        <div className={`h-full rounded-full ${c.bar}`} style={{ width: `${v}%` }} />
      </div>
    </div>
  );
}

function ChartCard({
  title,
  value,
  deltaText,
  deltaClass,
  sub,
  children,
}: {
  title: string;
  value: string;
  deltaText: string;
  deltaClass: string;
  sub?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="rounded-2xl bg-slate-900/40 ring-1 ring-white/10 p-4 shadow-lg">
      <div className="flex items-center justify-between gap-3">
        <div className="text-sm text-slate-200/80">{title}</div>
        <span className={`px-2.5 py-1 rounded-full text-xs font-medium ${deltaClass}`}>{deltaText}</span>
      </div>
      <div className="mt-2 flex items-end justify-between gap-3">
        <div className="text-3xl font-semibold tracking-tight text-white">{value}</div>
        {sub ? <div className="text-xs text-slate-300/70 text-right">{sub}</div> : null}
      </div>
      <div className="mt-3">{children}</div>
    </div>
  );
}

export default function Page() {
  const [state, setState] = useState<State>(initialState);
  const [gateIndex, setGateIndex] = useState<number>(0);
  const [draft, setDraft] = useState<HistoryEntry | null>(null);
  const [history, setHistory] = useState<HistoryEntry[]>([]);
  const [grade, setGrade] = useState<number | null>(null); // REQUIRED before proceed
  const didHydrate = useRef(false);

  const currentGate = gates[gateIndex];
  const isFinal = gateIndex >= gates.length;

  // hydrate
  useEffect(() => {
    if (didHydrate.current) return;
    didHydrate.current = true;

    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return;
      const parsed = JSON.parse(raw) as { state: State; gateIndex: number; history: HistoryEntry[] };
      if (parsed?.state && typeof parsed.gateIndex === "number") {
        setState(parsed.state);
        setGateIndex(parsed.gateIndex);
        setHistory(parsed.history || []);
      }
    } catch {
      // ignore
    }
  }, []);

  // persist
  useEffect(() => {
    if (!didHydrate.current) return;
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify({ state, gateIndex, history }));
    } catch {
      // ignore
    }
  }, [state, gateIndex, history]);

  const progress = useMemo(
    () =>
      gates.map((g, idx) => ({
        id: g.id,
        done: idx < gateIndex,
        active: idx === gateIndex && gateIndex < gates.length,
      })),
    [gateIndex]
  );

  const lastEntry = history.length ? history[history.length - 1] : null;

  // series (DG0 + decisions)
  const shareSeries = useMemo(() => {
    const base = 100;
    return [base, ...history.map((h) => h.next.share)];
  }, [history]);

  const synergySeries = useMemo(() => [initialState.synergy, ...history.map((h) => h.next.synergy)], [history]);
  const attrSeries = useMemo(() => [initialState.attrition, ...history.map((h) => h.next.attrition)], [history]);

  function reset() {
    setState(initialState);
    setGateIndex(0);
    setDraft(null);
    setGrade(null);
    setHistory([]);
    try {
      localStorage.removeItem(STORAGE_KEY);
    } catch {}
  }

  function selectOption(g: GateDef, o: OptionDef) {
    setGrade(null); // reset grade when selecting a new option

    const prev = deepCopyState(state);
    const { next, feasibility, note } = applyDecision(prev, g, o);

    const entry: HistoryEntry = {
      gate: g.id,
      choice: { gate: g.id, option: o.id },
      prev,
      next,
      deltas: {
        share: next.share - prev.share,
        synergy: next.synergy - prev.synergy,
        attrition: next.attrition - prev.attrition,
        cred: next.cred - prev.cred,
        risk: next.risk - prev.risk,
        capacity: next.capacity - prev.capacity,
        synergyCeiling: next.synergyCeiling - prev.synergyCeiling,
      },
      feasibility,
      note,
    };

    setDraft(entry);
  }

  // effective draft includes the grade impact (share/synergy/attr only)
  const effectiveDraft = useMemo(() => {
    if (!draft) return null;
    if (grade == null) return draft;

    const graded = applyPresentationGrade(draft.next, grade, draft.feasibility);
    const next = graded.next;

    return {
      ...draft,
      grade,
      next,
      deltas: {
        ...draft.deltas,
        share: next.share - draft.prev.share,
        synergy: next.synergy - draft.prev.synergy,
        attrition: next.attrition - draft.prev.attrition,
        cred: next.cred - draft.prev.cred,
        risk: next.risk - draft.prev.risk,
        capacity: next.capacity - draft.prev.capacity,
        synergyCeiling: next.synergyCeiling - draft.prev.synergyCeiling,
      },
      note:
        draft.note +
        ` (Presentation grade ${grade}: ${graded.deltas.dShare >= 0 ? "+" : "−"}${Math.abs(graded.deltas.dShare).toFixed(
          1
        )} share, ${graded.deltas.dSynergy >= 0 ? "+" : "−"}${Math.abs(graded.deltas.dSynergy).toFixed(
          1
        )} synergy, ${graded.deltas.dAttr <= 0 ? "−" : "+"}${Math.abs(graded.deltas.dAttr).toFixed(2)}pp attrition)`,
    };
  }, [draft, grade]);

  function proceed() {
    if (!effectiveDraft) return;

    setHistory((h) => [...h, effectiveDraft]);
    setState(effectiveDraft.next);
    setDraft(null);
    setGrade(null);
    setGateIndex((i) => i + 1);
  }

  return (
    <div className="min-h-screen bg-gradient-to-b from-slate-950 via-slate-950 to-slate-900 text-slate-100">
      <div className="mx-auto max-w-6xl px-5 py-10">
        {/* Header */}
        <div className="flex items-start justify-between gap-4">
          <div>
            <div className="text-xs text-slate-300/70">PMI Deal Simulation</div>
            <h1 className="mt-1 text-2xl sm:text-3xl font-semibold tracking-tight text-white">M&A Chapter - PMI Deal Simulation Training</h1>
            <p className="mt-2 max-w-2xl text-sm text-slate-200/75">
              Teams navigate five decision gates. Each choice shifts the trajectory across value delivery, people stability, and market perception.
            </p>
          </div>
          <button
            onClick={reset}
            className="shrink-0 rounded-xl bg-slate-900/40 ring-1 ring-white/10 px-4 py-2 text-sm text-slate-100 hover:bg-slate-900/60"
          >
            Restart
          </button>
        </div>

        {/* Progress */}
        <div className="mt-6 rounded-2xl bg-slate-900/30 ring-1 ring-white/10 p-4">
          <div className="flex flex-wrap items-center gap-2">
            {progress.map((p) => (
              <div
                key={p.id}
                className={[
                  "px-3 py-1.5 rounded-full text-xs font-medium ring-1",
                  p.active
                    ? "bg-white/10 text-white ring-white/20"
                    : p.done
                    ? "bg-emerald-500/10 text-emerald-200 ring-emerald-400/20"
                    : "bg-slate-700/10 text-slate-200/70 ring-white/10",
                ].join(" ")}
              >
                {p.id}
              </div>
            ))}
          </div>
        </div>

        {/* KPI charts */}
        <div className="mt-6 grid grid-cols-1 lg:grid-cols-3 gap-4">
          <ChartCard
            title="Share Price Index"
            value={fmt1(state.share)}
            deltaText={lastEntry ? signed(lastEntry.deltas.share, 1) : "±0.0"}
            deltaClass={lastEntry ? badgeClass(lastEntry.deltas.share) : badgeClass(0)}
            sub="Start 100 · Range 70–130 · 🔴 Drop ≤ −3 · 🟢 Breakout ≥ +3"
          >
            <TrendLine values={shareSeries} minY={70} maxY={130} dropThreshold={-3} breakoutThreshold={3} mode="normal" />
          </ChartCard>

          <ChartCard
            title="Synergy Realization"
            value={`${fmt1(state.synergy)}%`}
            deltaText={lastEntry ? signed(lastEntry.deltas.synergy, 1) : "±0.0"}
            deltaClass={lastEntry ? badgeClass(lastEntry.deltas.synergy) : badgeClass(0)}
            sub={`% of €750m target · Ceiling ${fmt1(state.synergyCeiling)}% · 🔴 Drop ≤ −1.5pp · 🟢 Breakout ≥ +1.5pp`}
          >
            <TrendLine values={synergySeries} minY={0} maxY={100} dropThreshold={-1.5} breakoutThreshold={1.5} mode="normal" />
          </ChartCard>

          <ChartCard
            title="Talent Attrition"
            value={`${fmt1(state.attrition)}%`}
            deltaText={lastEntry ? signed(lastEntry.deltas.attrition, 1) + "pp" : "±0.0"}
            deltaClass={lastEntry ? badgeClass(-lastEntry.deltas.attrition) : badgeClass(0)}
            sub="Clamped to 2–12% · 🔴 Spike ≥ +0.6pp · 🟢 Improvement ≤ −0.6pp"
          >
            <TrendLine values={attrSeries} minY={2} maxY={12} dropThreshold={-0.6} breakoutThreshold={0.6} mode="invert" />
          </ChartCard>
        </div>

        {/* Drivers (traffic light) */}
        <div className="mt-4 grid grid-cols-1 md:grid-cols-3 gap-3">
          <DriverBar label="Market Credibility" value={state.cred} kind="cred" />
          <DriverBar label="Execution Risk" value={state.risk} kind="risk" />
          <DriverBar label="Integration Capacity" value={state.capacity} kind="capacity" />
        </div>

        {/* Main */}
        <div className="mt-8">
          {!isFinal ? (
            <div className="grid grid-cols-1 lg:grid-cols-3 gap-5">
              {/* Gate */}
              <div className="lg:col-span-2 rounded-2xl bg-slate-900/30 ring-1 ring-white/10 p-6">
                <div className="text-xs text-slate-300/70">{currentGate.id}</div>
                <h2 className="mt-1 text-xl font-semibold text-white">{currentGate.title}</h2>
                <p className="mt-2 text-sm text-slate-200/75">{currentGate.context}</p>

                <div className="mt-5 grid grid-cols-1 md:grid-cols-2 gap-4">
                  {currentGate.options.map((o) => (
                    <div key={o.id} className="rounded-2xl bg-slate-950/40 ring-1 ring-white/10 p-4 hover:ring-white/20 transition">
                      <div className="flex items-start justify-between gap-3">
                        <div>
                          <div className="text-xs text-slate-300/70">Option {o.id}</div>
                          <div className="mt-1 font-semibold text-white">{o.title}</div>
                        </div>
                        <div className="text-xs text-slate-200/80 tabular-nums">+{o.baseSynergy}pp</div>
                      </div>

                      <p className="mt-2 text-sm text-slate-200/70">{o.blurb}</p>

                      <div className="mt-3 grid grid-cols-2 gap-2 text-xs text-slate-200/75">
                        <div className="rounded-lg bg-slate-900/40 ring-1 ring-white/10 px-2 py-1">Cred {signed(o.dCred, 1)}</div>
                        <div className="rounded-lg bg-slate-900/40 ring-1 ring-white/10 px-2 py-1">Risk {signed(o.dRisk, 1)}</div>
                        <div className="rounded-lg bg-slate-900/40 ring-1 ring-white/10 px-2 py-1">Attr {signed(o.dAttrition, 1)}pp</div>
                        <div className="rounded-lg bg-slate-900/40 ring-1 ring-white/10 px-2 py-1">Cap {signed(o.dCapacity, 1)}</div>
                      </div>

                      {currentGate.id === "DG4" ? (
                        <div className="mt-2 grid grid-cols-2 gap-2 text-xs text-slate-200/75">
                          <div className="rounded-lg bg-slate-900/40 ring-1 ring-white/10 px-2 py-1">
                            Ceiling {typeof o.dg4Ceiling === "number" ? `${fmt1(o.dg4Ceiling)}%` : "—"}
                          </div>
                          <div className="rounded-lg bg-slate-900/40 ring-1 ring-white/10 px-2 py-1">
                            Guidance {typeof o.dg4GuidanceShock === "number" ? signed(o.dg4GuidanceShock, 1) : "—"}
                          </div>
                        </div>
                      ) : null}

                      <button
                        disabled={!!draft}
                        onClick={() => selectOption(currentGate, o)}
                        className={[
                          "mt-4 w-full rounded-xl px-4 py-2 text-sm font-medium",
                          draft
                            ? "bg-slate-800/40 text-slate-400 cursor-not-allowed ring-1 ring-white/10"
                            : "bg-white/10 text-white hover:bg-white/15 ring-1 ring-white/15",
                        ].join(" ")}
                      >
                        Commit decision
                      </button>
                    </div>
                  ))}
                </div>
              </div>

              {/* Impact Panel */}
              <div className="rounded-2xl bg-slate-900/30 ring-1 ring-white/10 p-6">
                <div className="flex items-center justify-between">
                  <div className="text-xs text-slate-300/70">Impact</div>
                  <div className="text-xs text-slate-200/70 tabular-nums">
                    Feasibility <span className="text-white">{effectiveDraft ? `${fmt1(effectiveDraft.feasibility * 100)}%` : "—"}</span>
                  </div>
                </div>

                {!effectiveDraft ? (
                  <div className="mt-4 text-sm text-slate-200/70">Select an option to see immediate KPI impact and market interpretation.</div>
                ) : (
                  <div className="mt-4">
                    <div className="rounded-2xl bg-slate-950/40 ring-1 ring-white/10 p-4">
                      <div className="text-sm font-semibold text-white">Updated KPIs</div>

                      <div className="mt-3 grid grid-cols-1 gap-2 text-sm">
                        <div className="flex items-center justify-between">
                          <span className="text-slate-200/75">Share</span>
                          <span className="tabular-nums text-white">
                            {fmt1(effectiveDraft.next.share)}
                            <span className={`ml-2 text-xs px-2 py-0.5 rounded-full ${badgeClass(effectiveDraft.deltas.share)}`}>
                              {signed(effectiveDraft.deltas.share, 1)}
                            </span>
                          </span>
                        </div>
                        <div className="flex items-center justify-between">
                          <span className="text-slate-200/75">Synergy</span>
                          <span className="tabular-nums text-white">
                            {fmt1(effectiveDraft.next.synergy)}%
                            <span className={`ml-2 text-xs px-2 py-0.5 rounded-full ${badgeClass(effectiveDraft.deltas.synergy)}`}>
                              {signed(effectiveDraft.deltas.synergy, 1)}
                            </span>
                          </span>
                        </div>
                        <div className="flex items-center justify-between">
                          <span className="text-slate-200/75">Attrition</span>
                          <span className="tabular-nums text-white">
                            {fmt1(effectiveDraft.next.attrition)}%
                            <span className={`ml-2 text-xs px-2 py-0.5 rounded-full ${badgeClass(-effectiveDraft.deltas.attrition)}`}>
                              {signed(effectiveDraft.deltas.attrition, 1)}pp
                            </span>
                          </span>
                        </div>
                        <div className="flex items-center justify-between">
                          <span className="text-slate-200/75">Synergy ceiling</span>
                          <span className="tabular-nums text-white">
                            {fmt1(effectiveDraft.next.synergyCeiling)}%
                            <span className={`ml-2 text-xs px-2 py-0.5 rounded-full ${badgeClass(effectiveDraft.deltas.synergyCeiling)}`}>
                              {signed(effectiveDraft.deltas.synergyCeiling, 1)}
                            </span>
                          </span>
                        </div>
                      </div>

                      <div className="mt-4 text-xs text-slate-300/70">
                        Drivers: Cred {signed(effectiveDraft.deltas.cred, 1)} · Risk {signed(effectiveDraft.deltas.risk, 1)} · Capacity{" "}
                        {signed(effectiveDraft.deltas.capacity, 1)}
                      </div>
                    </div>

                    {/* REQUIRED grade */}
                    <div className="mt-4 rounded-2xl bg-slate-950/40 ring-1 ring-white/10 p-4">
                      <div className="text-sm font-semibold text-white">Presentation grade (required)</div>
                      <div className="mt-2 flex items-center gap-3">
                        <select
                          value={grade ?? ""}
                          onChange={(e) => setGrade(e.target.value ? Number(e.target.value) : null)}
                          className="rounded-xl bg-slate-900/60 ring-1 ring-white/10 px-3 py-2 text-sm text-white"
                        >
                          <option value="" disabled>
                            Select grade…
                          </option>
                          <option value="1">1 — sehr gut</option>
                          <option value="2">2 — gut</option>
                          <option value="3">3 — befriedigend</option>
                          <option value="4">4 — ausreichend</option>
                          <option value="5">5 — mangelhaft</option>
                          <option value="6">6 — schlecht</option>
                        </select>

                        <div className="text-xs text-slate-300/70">
                          Impacts <span className="text-slate-100">Share / Synergy / Attrition</span> slightly.
                        </div>
                      </div>
                    </div>

                    <div className="mt-4 rounded-2xl bg-slate-950/40 ring-1 ring-white/10 p-4">
                      <div className="text-sm font-semibold text-white">Market interpretation</div>
                      <p className="mt-2 text-sm text-slate-200/75">{effectiveDraft.note}</p>
                    </div>

                    <button
                      disabled={grade == null}
                      onClick={proceed}
                      className={[
                        "mt-4 w-full rounded-xl px-4 py-2 text-sm font-semibold ring-1",
                        grade == null
                          ? "bg-slate-800/40 text-slate-400 cursor-not-allowed ring-white/10"
                          : "bg-emerald-500/15 text-emerald-100 ring-emerald-400/25 hover:bg-emerald-500/20",
                      ].join(" ")}
                    >
                      Proceed to next gate
                    </button>

                    <button
                      onClick={() => {
                        setDraft(null);
                        setGrade(null);
                      }}
                      className="mt-2 w-full rounded-xl bg-white/5 text-slate-200 ring-1 ring-white/10 px-4 py-2 text-sm hover:bg-white/10"
                    >
                      Cancel selection
                    </button>
                  </div>
                )}
              </div>
            </div>
          ) : (
            <div className="rounded-2xl bg-slate-900/30 ring-1 ring-white/10 p-6">
              <div className="text-xs text-slate-300/70">Final Results</div>
              <h2 className="mt-1 text-2xl font-semibold text-white">Simulation complete</h2>
              <p className="mt-2 text-sm text-slate-200/75">
                Review the final outcome and discuss trade-offs. There is no “perfect” path — only decisions under constraints.
              </p>

{/* PMI Robustness Index (0–100) */}
{(() => {
  const robustness = computeRobustnessIndex(state);

  const badge =
    robustness >= 75
      ? { label: "GREEN", cls: "bg-emerald-500/15 text-emerald-200 ring-1 ring-emerald-400/20" }
      : robustness >= 55
      ? { label: "YELLOW", cls: "bg-amber-500/15 text-amber-200 ring-1 ring-amber-400/20" }
      : { label: "RED", cls: "bg-rose-500/15 text-rose-200 ring-1 ring-rose-400/20" };

  return (
    <div className="mt-5 rounded-2xl bg-slate-950/40 ring-1 ring-white/10 p-5">
      <div className="flex items-center justify-between gap-3">
        <div>
          <div className="text-xs text-slate-300/70">Overall</div>
          <div className="text-lg font-semibold text-white">PMI Robustness Index</div>
        </div>
        <span className={`px-3 py-1 rounded-full text-xs font-semibold ${badge.cls}`}>
          {badge.label}
        </span>
      </div>

      <div className="mt-3 flex items-end justify-between">
        <div className="text-4xl font-semibold text-white">{robustness}</div>
        <div className="text-xs text-slate-300/70">0–100 (higher is better)</div>
      </div>

      <div className="mt-3 h-2 w-full rounded-full bg-white/10 overflow-hidden">
        <div className="h-full bg-white/60" style={{ width: `${robustness}%` }} />
      </div>

      <div className="mt-3 text-xs text-slate-300/70">
        Benchmark of value delivery + sustainability under execution constraints.
      </div>
    </div>
  );
})()}

              <div className="mt-6 grid grid-cols-1 md:grid-cols-3 gap-4">
                <div className="rounded-2xl bg-slate-900/40 ring-1 ring-white/10 p-4 shadow-lg">
                  <div className="text-sm text-slate-200/80">Share trajectory</div>
                  <div className="mt-3">
                    <TrendLine values={shareSeries} minY={70} maxY={130} dropThreshold={-3} breakoutThreshold={3} mode="normal" />
                  </div>
                </div>
                <div className="rounded-2xl bg-slate-900/40 ring-1 ring-white/10 p-4 shadow-lg">
                  <div className="text-sm text-slate-200/80">Synergy trajectory</div>
                  <div className="mt-3">
                    <TrendLine values={synergySeries} minY={0} maxY={100} dropThreshold={-1.5} breakoutThreshold={1.5} mode="normal" />
                  </div>
                </div>
                <div className="rounded-2xl bg-slate-900/40 ring-1 ring-white/10 p-4 shadow-lg">
                  <div className="text-sm text-slate-200/80">Attrition trajectory</div>
                  <div className="mt-3">
                    <TrendLine values={attrSeries} minY={2} maxY={12} dropThreshold={-0.6} breakoutThreshold={0.6} mode="invert" />
                  </div>
                </div>
              </div>

              {/* Optional: show per-gate grades */}
              <div className="mt-6 rounded-2xl bg-slate-950/40 ring-1 ring-white/10 p-5">
                <div className="text-sm font-semibold text-white">Grades by gate</div>
                <div className="mt-3 grid grid-cols-2 md:grid-cols-5 gap-2">
                  {gates.map((g, idx) => {
                    const h = history[idx];
                    const gr = h?.grade ?? "—";
                    return (
                      <div key={g.id} className="rounded-xl bg-slate-900/40 ring-1 ring-white/10 p-3">
                        <div className="text-xs text-slate-300/70">{g.id}</div>
                        <div className="mt-1 text-lg font-semibold text-white">{gr}</div>
                      </div>
                    );
                  })}
                </div>
                <div className="mt-2 text-xs text-slate-300/70">
                  Grade impacts: Share / Synergy / Attrition (slight but noticeable).
                </div>
              </div>

              <div className="mt-6 rounded-2xl bg-slate-950/40 ring-1 ring-white/10 p-5">
                <div className="text-sm font-semibold text-white">Debrief</div>
                <ul className="mt-3 space-y-2 text-sm text-slate-200/75 list-disc pl-5">
                  <li>Which trade-off did you prioritize most — ambition, stability, or credibility?</li>
                  <li>Where did constraints (risk/capacity/ceiling) limit your ability to realize value?</li>
                  <li>How did your presentation quality (grade) influence outcomes?</li>
                </ul>
              </div>

              <button
                onClick={reset}
                className="mt-6 rounded-xl bg-white/10 text-white ring-1 ring-white/15 px-5 py-2 text-sm font-semibold hover:bg-white/15"
              >
                Restart simulation
              </button>
            </div>
          )}
        </div>

        <div className="mt-10 text-xs text-slate-400/70">
          Local prototype · State persists in localStorage · Adjust parameters in <span className="text-slate-200">app/page.tsx</span>
        </div>
      </div>
    </div>
  );
}