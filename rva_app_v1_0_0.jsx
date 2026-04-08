// V2G Analysis Engine — UI + Computation
// Version: 1.0.0
// Part of: CCE / Makello Tools
// Pure client-side — no backend required

const { useState, useCallback, useRef } = React;
const VERSION = "1.0.0";

// ── Colour palette ────────────────────────────────────────────────────────────
const C = {
  bg:     "#0a0f1a", panel:  "#111827", border: "#1e2d45",
  text:   "#e8f4ff", muted:  "#7a9cbf", faint:  "#3a5070",
  accent: "#2a7fff", green:  "#00c97a", orange: "#ff8c42",
  red:    "#ff4f4f", input:  "#0d1a2e",
};

// ═══════════════════════════════════════════════════════════════════════════════
// COMPUTATION ENGINE (JavaScript port of rva.py)
// ═══════════════════════════════════════════════════════════════════════════════

// Brent's method root finder — replicates scipy.optimize.brentq
function brentq(f, a, b, tol = 1e-10, maxIter = 500) {
  let fa = f(a), fb = f(b);
  if (fa === 0) return a;
  if (fb === 0) return b;
  let c = a, fc = fa, d = b - a, e = d;
  for (let i = 0; i < maxIter; i++) {
    if (fb * fc > 0) { c = a; fc = fa; d = e = b - a; }
    if (Math.abs(fc) < Math.abs(fb)) {
      a = b; b = c; c = a;
      fa = fb; fb = fc; fc = fa;
    }
    const tol1 = 2 * 2.22e-16 * Math.abs(b) + 0.5 * tol;
    const xm = 0.5 * (c - b);
    if (Math.abs(xm) <= tol1 || fb === 0) return b;
    if (Math.abs(e) >= tol1 && Math.abs(fa) > Math.abs(fb)) {
      let s = fb / fa, p, q, r;
      if (a === c) {
        p = 2 * xm * s; q = 1 - s;
      } else {
        q = fa / fc; r = fb / fc;
        p = s * (2 * xm * q * (q - r) - (b - a) * (r - 1));
        q = (q - 1) * (r - 1) * (s - 1);
      }
      if (p > 0) q = -q; else p = -p;
      if (2 * p < Math.min(3 * xm * q - Math.abs(tol1 * q), Math.abs(e * q))) {
        e = d; d = p / q;
      } else { d = xm; e = d; }
    } else { d = xm; e = d; }
    a = b; fa = fb;
    b += Math.abs(d) > tol1 ? d : (xm > 0 ? tol1 : -tol1);
    fb = f(b);
  }
  return b;
}

// Core V2G calculation — mirrors rva() in rva.py
// Returns result object with summary metrics + data arrays for CSV export
function runRVA(params, mode) {
  const {
    cap, thresh_pct, inc, hh, cars_hh,
    evse_dc_lim, eff, batt, rule_lim, draw_lim,
    base_load, forecast_pct, cars_home_pct,
  } = params;

  const EVSE_GRID_LIM = evse_dc_lim * eff;

  // 1. DEFINE PEAK AND COHORTS
  const projected     = base_load.map((bl, i) => bl * (1 + forecast_pct[i] + inc));
  const target_thresh = cap * thresh_pct;
  const grid_need     = projected.map(p => Math.max(0, p - target_thresh));
  const total_grid_energy = grid_need.reduce((a, b) => a + b, 0);

  const peak_mask  = grid_need.map(g => g > 0);
  const peak_hours = peak_mask.map((m, i) => m ? i : -1).filter(i => i >= 0);
  const p_start_h  = peak_hours.length > 0 ? peak_hours[0] : 0;
  const p_end_h    = peak_hours.length > 0 ? peak_hours[peak_hours.length - 1] : 0;

  const cohort_arrivals = new Array(24).fill(0);
  if (peak_hours.length > 0) {
    cohort_arrivals[p_start_h] = cars_home_pct[p_start_h];
    for (let h = p_start_h + 1; h <= p_end_h; h++) {
      const diff = cars_home_pct[h] - cars_home_pct[h - 1];
      if (diff > 0.0001) cohort_arrivals[h] = diff;
    }
  }

  const hours_in_peak = Array.from({ length: 24 }, (_, a) =>
    peak_mask.slice(a, p_end_h + 1).filter(Boolean).length
  );

  // 2. SOLVER
  const total_fleet_potential = hh * cars_hh;

  function solve_v2g(p) {
    const n_f = total_fleet_potential * p;
    if (n_f <= 0) return 1e6;
    const avail = cars_home_pct.map(c => n_f * c);
    const v_p   = Math.max(...avail.map((a, i) =>
      a > 0 ? grid_need[i] / (a * EVSE_GRID_LIM) : 0
    )) - rule_lim;
    if (mode === 'Standard') {
      const v_e = avail.reduce((sum, a, i) =>
        sum + (a > 0 ? grid_need[i] / (a * eff) : 0), 0
      ) / batt - draw_lim;
      return Math.max(v_p, v_e);
    } else {
      let fleet_cap = 0;
      for (let a = 0; a < 24; a++)
        fleet_cap += Math.min(batt * draw_lim, evse_dc_lim * hours_in_peak[a]) * eff
                     * cohort_arrivals[a] * n_f;
      return Math.max(v_p, (total_grid_energy - fleet_cap) / (total_grid_energy + 1e-6));
    }
  }

  const p_opt   = total_grid_energy <= 0 ? 0 : brentq(solve_v2g, 0.0001, 1.0);
  const n_final = total_fleet_potential * p_opt;

  // 3. DISPATCH AND HISTORY
  const historyHours = Array.from({ length: 24 }, (_, i) => i + 1);
  const histCols     = { Hour: historyHours };
  const fleet_power_grid = new Array(24).fill(0);
  let total_batt_delivered_grid = 0;
  let batt_draw_max_kwh = 0;

  if (n_final > 0) {
    const cohort_size = cohort_arrivals.map(c => n_final * c);

    if (mode === 'Standard') {
      const e_hr_batt = grid_need.map((g, i) => {
        const av = n_final * cars_home_pct[i];
        return av > 0 ? g / (av * eff) : 0;
      });
      batt_draw_max_kwh = e_hr_batt.reduce((a, b) => a + b, 0);
      for (let i = 0; i < 24; i++) fleet_power_grid[i] = grid_need[i];

      for (let a = 0; a < 24; a++) {
        if (cohort_arrivals[a] > 0) {
          total_batt_delivered_grid += e_hr_batt.slice(a).reduce((s, v) => s + v, 0)
                                       * cohort_size[a] * eff;
          let cumul = 0;
          const draw = [], ratio = [];
          for (let h = 0; h < 24; h++) {
            if (h >= a) cumul += e_hr_batt[h];
            draw.push(cumul);
            ratio.push(h >= a ? e_hr_batt[h] * eff / EVSE_GRID_LIM : 0);
          }
          histCols[`C${a + 1}_Draw_kWh`] = draw;
          histCols[`C${a + 1}_Ratio`]    = ratio;
        }
      }
    } else {
      // Optimized — find per-car energy target T_opt
      const f_T = T => {
        let s = 0;
        for (let a = 0; a < 24; a++)
          s += Math.min(T, evse_dc_lim * hours_in_peak[a]) * eff * cohort_arrivals[a] * n_final;
        return s - total_grid_energy;
      };
      const T_opt = brentq(f_T, 0, batt);
      batt_draw_max_kwh = T_opt;

      const cohort_rem = Array.from({ length: 24 }, (_, a) =>
        Math.min(T_opt, evse_dc_lim * hours_in_peak[a])
      );
      const cohort_p_hist = Array.from({ length: 24 }, () => new Array(24).fill(0));

      for (let h = p_start_h; h <= p_end_h; h++) {
        if (grid_need[h] > 0) {
          let needed = grid_need[h] / eff;
          let active = [];
          for (let a = 0; a <= h; a++)
            if (cohort_size[a] > 0 && cohort_rem[a] > 0) active.push(a);

          while (needed > 0.01 && active.length > 0) {
            const hrs_left = peak_mask.slice(h, p_end_h + 1).filter(Boolean).length;
            const weights  = active.map(a => cohort_size[a] * (cohort_rem[a] / hrs_left));
            const w_sum    = weights.reduce((a, b) => a + b, 0);
            if (w_sum <= 0) break;

            let distributed = 0;
            const next_active = [];
            for (let idx = 0; idx < active.length; idx++) {
              const a = active[idx];
              const p_actual = Math.min(
                (needed * weights[idx] / w_sum) / cohort_size[a],
                evse_dc_lim,
                cohort_rem[a]
              );
              cohort_p_hist[a][h] += p_actual;
              cohort_rem[a]       -= p_actual;
              distributed         += p_actual * cohort_size[a];
              if (cohort_rem[a] > 0) next_active.push(a);
            }
            needed -= distributed;
            active  = next_active;
            if (distributed < 0.01) break;
          }
          fleet_power_grid[h] = (grid_need[h] / eff - needed) * eff;
        }
      }

      for (let a = 0; a < 24; a++) {
        if (cohort_arrivals[a] > 0) {
          total_batt_delivered_grid += cohort_p_hist[a].reduce((s, v) => s + v, 0)
                                       * cohort_size[a] * eff;
          let cumul = 0;
          const draw = [], ratio = [];
          for (let h = 0; h < 24; h++) {
            cumul += cohort_p_hist[a][h];
            draw.push(cumul);
            ratio.push(cohort_p_hist[a][h] / evse_dc_lim);
          }
          histCols[`C${a + 1}_Draw_kWh`] = draw;
          histCols[`C${a + 1}_Ratio`]    = ratio;
        }
      }
    }
  }

  return {
    penetration:    p_opt,
    vehicles:       Math.round(n_final),
    max_draw_kwh:   Math.round(batt_draw_max_kwh * 100) / 100,
    max_draw_pct:   batt > 0 ? batt_draw_max_kwh / batt : 0,
    grid_energy:    Math.round(total_grid_energy * 100) / 100,
    batt_delivered: Math.round(total_batt_delivered_grid * 100) / 100,
    // Arrays for CSV export
    projected, grid_need, fleet_power_grid, target_thresh,
    histCols,
  };
}

// ── CSV export helpers ────────────────────────────────────────────────────────
function csvCell(s) {
  const str = String(s == null ? '' : s);
  return str.includes(',') ? `"${str}"` : str;
}
function csvRow(cells) { return cells.map(csvCell).join(','); }

function buildOutputCSV(params, res, mode) {
  const {
    cap, thresh_pct, inc, hh, cars_hh, evse_dc_lim, eff, batt, rule_lim, draw_lim,
    base_load, forecast_pct, cars_home_pct, circuit_num,
  } = params;
  const { penetration, vehicles, max_draw_kwh, max_draw_pct, grid_energy, batt_delivered,
          projected, grid_need, fleet_power_grid, target_thresh } = res;
  const managed_load = projected.map((p, i) => p - fleet_power_grid[i]);
  const n_final = total_fleet_potential(hh, cars_hh) * penetration;

  // Build rows (37 × 13)
  const R = Array.from({ length: 37 }, () => new Array(13).fill(''));

  const pRows = [
    ['Circuit', circuit_num],
    ['Circuit capacity', Number(cap).toLocaleString()],
    ['Threshold', Number(thresh_pct).toFixed(2)],
    ['Load increase', (inc * 100).toFixed(0) + '%'],
    ['nº of household meters', Number(hh).toLocaleString()],
    ['Cars per houshold', cars_hh],
    ['EVSE discharge (kW)', evse_dc_lim],
    ['Discharge efficiency', (eff * 100).toFixed(0) + '%'],
    ['Battery size', batt],
    ['Discharge rule', rule_lim],
    ['max % battery withdrawn', (draw_lim * 100).toFixed(0) + '%'],
  ];
  pRows.forEach(([l, v], i) => { R[i][0] = l; R[i][1] = String(v); });

  R[0][5]  = (penetration * 100).toFixed(3) + '%';
  R[1][5]  = String(vehicles);
  R[2][5]  = max_draw_kwh.toFixed(2);
  R[3][5]  = (max_draw_pct * 100).toFixed(1) + '%';
  R[4][5]  = grid_energy.toFixed(2);
  R[5][5]  = batt_delivered.toFixed(2);
  R[6][5]  = VERSION;

  R[11] = ['Hour','Base yr (kW) (C)','Future yr profile change (D)','% cars home (G)',
           'Load profile + increase (E)','BEV availables (H)','Energy to be discharged (J)',
           'Projected kW (F)','Managed kW (I)','','','Threshold (N)','Capacity(O)'];

  for (let i = 0; i < 24; i++) {
    const r = 12 + i;
    R[r][0]  = String(i + 1);
    R[r][1]  = base_load[i].toFixed(0);
    R[r][2]  = (forecast_pct[i] * 100).toFixed(3) + '%';
    R[r][3]  = (cars_home_pct[i] * 100).toFixed(3) + '%';
    R[r][4]  = ((forecast_pct[i] + inc) * 100).toFixed(5) + '%';
    R[r][5]  = (n_final * cars_home_pct[i]).toFixed(4);
    R[r][6]  = grid_need[i].toFixed(2);
    R[r][7]  = projected[i].toFixed(2);
    R[r][8]  = managed_load[i].toFixed(2);
    R[r][11] = target_thresh.toFixed(1);
    R[r][12] = Number(cap).toFixed(1);
  }

  return R.map(csvRow).join('\n');
}

function total_fleet_potential(hh, cars_hh) { return hh * cars_hh; }

function buildHistoryCSV(res, circuit_num, mode) {
  const { grid_energy, batt_delivered, histCols } = res;
  const cols = Object.keys(histCols);
  let csv = `Version,${VERSION},GridNeeded,${grid_energy.toFixed(2)},BattDelivered,${batt_delivered.toFixed(2)}\n`;
  csv += cols.join(',') + '\n';
  for (let h = 0; h < 24; h++) {
    csv += cols.map(col => {
      const v = histCols[col][h];
      return typeof v === 'number' && col !== 'Hour' ? v.toFixed(4) : String(v);
    }).join(',') + '\n';
  }
  return csv;
}

// ── Summary CSV (save / restore) ──────────────────────────────────────────────
function buildSummaryCSV(state, stdRes, optRes) {
  const { circuitNum, circuitCapacity, households, loadIncrease,
          threshold, carsPerHH, evseDischargekW, dischargeEfficiency,
          batterySizekWh, maxBatteryWithdrawn,
          loadProfile, carsHomeProfile, baseLoad } = state;
  const s = stdRes, o = optRes;
  const rows = [];
  rows.push('\uFEFF');
  rows.push(`V2G ANALYSIS ENGINE v${VERSION} \u2014 Model Summary`);
  rows.push(`Generated:,${new Date().toISOString()}`);
  rows.push('');
  rows.push('INPUTS');
  rows.push('Parameter,Value');
  rows.push(`Circuit,${circuitNum}`);
  rows.push(`Circuit Capacity (kW),${circuitCapacity}`);
  rows.push(`Household Meters,${households}`);
  rows.push(`Load Increase (circuit),${(parseFloat(loadIncrease)).toFixed(2)}%`);
  rows.push(`Threshold,${threshold}`);
  rows.push(`Cars Per Household,${carsPerHH}`);
  rows.push(`EVSE Discharge (kW),${evseDischargekW}`);
  rows.push(`Discharge Efficiency,${dischargeEfficiency}`);
  rows.push(`Battery Size (kWh),${batterySizekWh}`);
  rows.push(`Max % Battery Withdrawn,${(parseFloat(maxBatteryWithdrawn) * 100).toFixed(0)}%`);
  rows.push('');
  rows.push('RESULTS');
  rows.push('Metric,Standard,Optimized');
  rows.push(`V2G Penetration,${(s.penetration*100).toFixed(3)}%,${(o.penetration*100).toFixed(3)}%`);
  rows.push(`Vehicle Count,${s.vehicles},${o.vehicles}`);
  rows.push(`Max Battery Draw (kWh),${s.max_draw_kwh},${o.max_draw_kwh}`);
  rows.push(`Max Draw (% of Battery),${(s.max_draw_pct*100).toFixed(1)}%,${(o.max_draw_pct*100).toFixed(1)}%`);
  rows.push(`Grid Energy Needed (kWh),${s.grid_energy},${o.grid_energy}`);
  rows.push(`Battery Energy Delivered (kWh),${s.batt_delivered},${o.batt_delivered}`);
  rows.push('');
  rows.push('LOAD PROFILE');
  rows.push('Hour,Future Year Change (%)');
  loadProfile.forEach((v, i) => rows.push(`${i+1},${parseFloat(v).toFixed(3)}%`));
  rows.push('');
  rows.push('CARS HOME PROFILE');
  rows.push('Hour,% Cars Home');
  carsHomeProfile.forEach((v, i) => rows.push(`${i+1},${parseFloat(v).toFixed(3)}%`));
  rows.push('');
  rows.push('HOURLY BASE LOAD');
  rows.push('Hour,Base Load (kW)');
  baseLoad.forEach((v, i) => rows.push(`${i+1},${v}`));
  rows.push('');
  // Machine-readable restore section — do not edit manually
  rows.push('RESTORE KEYS');
  rows.push(`circuit,${circuitNum}`);
  rows.push(`circuitCapacity,${circuitCapacity}`);
  rows.push(`households,${households}`);
  rows.push(`loadIncrease,${parseFloat(loadIncrease) / 100}`);
  rows.push(`threshold,${threshold}`);
  rows.push(`carsPerHousehold,${carsPerHH}`);
  rows.push(`evseDischargekW,${evseDischargekW}`);
  rows.push(`dischargeEfficiency,${dischargeEfficiency}`);
  rows.push(`batterySizekWh,${batterySizekWh}`);
  rows.push(`maxBatteryWithdrawn,${maxBatteryWithdrawn}`);
  rows.push(`loadProfile,${loadProfile.map(v => parseFloat(v)).join('|')}`);
  rows.push(`carsHomeProfile,${carsHomeProfile.map(v => parseFloat(v)).join('|')}`);
  rows.push(`baseLoad,${baseLoad.join('|')}`);
  return rows.join('\n');
}

function parseSummaryCSV(text) {
  const lines = text.split(/\r?\n/);
  const kv = {};
  let inRestore = false;
  for (const raw of lines) {
    const line = raw.replace(/^\uFEFF/, '').trim();
    if (!line) { inRestore = false; continue; }
    if (line === 'RESTORE KEYS') { inRestore = true; continue; }
    if (!inRestore) continue;
    const ci = line.indexOf(',');
    if (ci < 0) continue;
    const key = line.slice(0, ci).trim();
    let val   = line.slice(ci + 1).trim();
    if (val.startsWith('"') && val.endsWith('"')) val = val.slice(1, -1);
    kv[key] = val;
  }
  const r = {};
  if (kv.circuit            !== undefined) r.circuitNum         = parseInt(kv.circuit);
  if (kv.circuitCapacity    !== undefined) r.circuitCapacity    = parseFloat(kv.circuitCapacity);
  if (kv.households         !== undefined) r.households         = parseInt(kv.households);
  if (kv.loadIncrease       !== undefined) r.loadIncrease       = parseFloat(kv.loadIncrease) * 100;
  if (kv.threshold          !== undefined) r.threshold          = parseFloat(kv.threshold);
  if (kv.carsPerHousehold   !== undefined) r.carsPerHH          = parseFloat(kv.carsPerHousehold);
  if (kv.evseDischargekW    !== undefined) r.evseDischargekW    = parseFloat(kv.evseDischargekW);
  if (kv.dischargeEfficiency!== undefined) r.dischargeEfficiency= parseFloat(kv.dischargeEfficiency);
  if (kv.batterySizekWh     !== undefined) r.batterySizekWh     = parseFloat(kv.batterySizekWh);
  if (kv.maxBatteryWithdrawn!== undefined) r.maxBatteryWithdrawn= parseFloat(kv.maxBatteryWithdrawn);
  if (kv.loadProfile        !== undefined) r.loadProfile        = kv.loadProfile.split('|').map(Number);
  if (kv.carsHomeProfile    !== undefined) r.carsHomeProfile    = kv.carsHomeProfile.split('|').map(Number);
  if (kv.baseLoad           !== undefined) r.baseLoad           = kv.baseLoad.split('|').map(Number);
  return r;
}

function parseCircuitCSV(text) {
  const lines = text.split(/\r?\n/);
  const kv = {};
  const baseLoad = [];
  let hourFound = false;
  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;
    const parts = line.split(',');
    const key   = (parts[0] || '').trim().toLowerCase();
    const val   = (parts[1] || '').trim();
    if (key === 'hour') { hourFound = true; continue; }
    if (hourFound) {
      const v = parseFloat(val.replace(/,/g, ''));
      if (!isNaN(v)) baseLoad.push(v);
      if (baseLoad.length === 24) break;
      continue;
    }
    kv[key] = val;
  }
  const loadIncreasePct = String(kv['load increase'] || '0');
  const loadIncrease    = loadIncreasePct.includes('%')
    ? parseFloat(loadIncreasePct)
    : parseFloat(loadIncreasePct) || 0;
  return {
    circuitNum:      parseInt(kv['circuit']) || 0,
    circuitCapacity: parseFloat(String(kv['circuit capacity'] || '0').replace(/,/g, '')),
    households:      parseInt(String(kv['household meters'] || '0').replace(/,/g, '')),
    loadIncrease,    // kept as % for UI state
    baseLoad,
  };
}

// ── Trigger file download ─────────────────────────────────────────────────────
function downloadCSV(content, filename) {
  const blob = new Blob([content], { type: 'text/csv' });
  const a    = document.createElement('a');
  a.href     = URL.createObjectURL(blob);
  a.download = filename;
  a.click();
  URL.revokeObjectURL(a.href);
}

// ── Default semi-permanent settings ──────────────────────────────────────────
const DEFAULT_LOAD_PROFILE = [
  25.665, 21.761, 17.884, 14.978, 12.972, 12.056,
  10.722,  7.915,  4.808,  1.830, -3.273, -6.875,
  -6.714, -5.000, -0.695,  2.504,  5.193,  8.311,
   9.717,  9.868, 12.458, 15.888, 17.886, 21.917,
];
const DEFAULT_CARS_HOME = [
  99.013, 99.446, 99.759, 100.000, 99.160, 95.752,
  86.752,  68.073, 51.046,  42.380, 37.566, 34.932,
  32.613,  28.403, 27.742,  32.581, 45.957, 68.467,
  81.666,  87.865, 91.180,  93.540, 95.818, 97.889,
];

// ── Shared sub-components ─────────────────────────────────────────────────────
function Card({ title, children, style }) {
  return (
    <div style={{ background: C.panel, border: `1px solid ${C.border}`, borderRadius: 10, padding: '14px 16px', ...style }}>
      {title && (
        <div style={{ fontSize: 10, fontFamily: "'DM Mono', monospace", color: C.accent, letterSpacing: '0.12em', fontWeight: 600, textTransform: 'uppercase', marginBottom: 10 }}>{title}</div>
      )}
      {children}
    </div>
  );
}

function Field({ label, value, onChange, readOnly, unit, note }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 7 }}>
      <div style={{ fontSize: 12, color: C.muted, width: 170, flexShrink: 0 }}>{label}</div>
      <input value={value}
        onChange={onChange ? e => onChange(e.target.value) : undefined}
        readOnly={readOnly}
        style={{ background: readOnly ? 'transparent' : C.input, border: `1px solid ${readOnly ? C.faint : C.border}`, borderRadius: 5, color: readOnly ? C.muted : C.text, padding: '4px 8px', fontSize: 12, width: 100, fontFamily: "'DM Mono', monospace", outline: 'none' }}
      />
      {unit && <span style={{ fontSize: 11, color: C.faint }}>{unit}</span>}
      {note && <span style={{ fontSize: 10, color: C.faint, fontStyle: 'italic' }}>{note}</span>}
    </div>
  );
}

function HourlyTable({ values, onChange }) {
  return (
    <div style={{ display: 'grid', gridTemplateColumns: '28px 1fr', gap: '2px 6px', maxHeight: 310, overflowY: 'auto' }}>
      {values.map((v, i) => (
        <React.Fragment key={i}>
          <div style={{ fontSize: 10, color: C.faint, textAlign: 'right', lineHeight: '22px' }}>{i + 1}</div>
          <input value={v}
            onChange={onChange ? e => onChange(i, e.target.value) : undefined}
            readOnly={!onChange}
            style={{ background: onChange ? C.input : 'transparent', border: `1px solid ${onChange ? C.border : C.faint}`, borderRadius: 4, color: onChange ? C.text : C.muted, padding: '2px 6px', fontSize: 11, width: '100%', fontFamily: "'DM Mono', monospace", outline: 'none' }}
          />
        </React.Fragment>
      ))}
    </div>
  );
}

function Btn({ children, onClick, color, disabled, full }) {
  const bg = color === 'green'  ? `linear-gradient(135deg,#007a48,${C.green})`
           : color === 'orange' ? `linear-gradient(135deg,#7a4000,${C.orange})`
           : color === 'muted'  ? 'transparent'
           : `linear-gradient(135deg,#00508a,${C.accent})`;
  const fg = color === 'green' ? '#001a0f' : color === 'orange' ? '#180d00' : color === 'muted' ? C.muted : '#001220';
  return (
    <button onClick={onClick} disabled={disabled}
      style={{ background: disabled ? C.faint : bg, border: color === 'muted' ? `1px solid ${C.border}` : 'none', borderRadius: 7, color: disabled ? '#555' : fg, padding: '8px 14px', fontSize: 11, fontWeight: 700, fontFamily: "'DM Sans', sans-serif", letterSpacing: '0.04em', cursor: disabled ? 'not-allowed' : 'pointer', textTransform: 'uppercase', width: full ? '100%' : undefined }}
    >{children}</button>
  );
}

// ── Main App ──────────────────────────────────────────────────────────────────
function App() {
  // Semi-permanent
  const [threshold,           setThreshold]           = useState('0.90');
  const [carsPerHH,           setCarsPerHH]           = useState('2.3');
  const [evseDischargekW,     setEvseDischargekW]     = useState('12.80');
  const [dischargeEfficiency, setDischargeEfficiency] = useState('0.97');
  const [batterySizekWh,      setBatterySizekWh]      = useState('88');
  const [maxBatteryWithdrawn, setMaxBatteryWithdrawn] = useState('0.30');
  const [loadProfile,  setLoadProfile]  = useState(DEFAULT_LOAD_PROFILE.map(v => v.toFixed(3)));
  const [carsHomeProfile, setCarsHomeProfile] = useState(DEFAULT_CARS_HOME.map(v => v.toFixed(3)));

  // Circuit-specific
  const [circuitNum,      setCircuitNum]      = useState('');
  const [circuitCapacity, setCircuitCapacity] = useState('');
  const [households,      setHouseholds]      = useState('');
  const [loadIncrease,    setLoadIncrease]    = useState('0');
  const [baseLoad,        setBaseLoad]        = useState(Array(24).fill(''));

  // Transient
  const [status,     setStatus]     = useState('idle');
  const [results,    setResults]    = useState(null); // { standard, optimized }
  const [restoreMsg, setRestoreMsg] = useState(null);
  const [circuitMsg, setCircuitMsg] = useState(null);
  const [errorMsg,   setErrorMsg]   = useState('');

  const circuitInputRef = useRef(null);
  const restoreInputRef = useRef(null);

  // Build computation params from current state
  const buildParams = useCallback((overrides = {}) => {
    const st = {
      circuitNum:          parseInt(circuitNum) || 0,
      circuitCapacity:     parseFloat(circuitCapacity) || 0,
      households:          parseInt(households) || 0,
      loadIncrease:        parseFloat(loadIncrease) || 0,
      threshold:           parseFloat(threshold) || 0.9,
      carsPerHH:           parseFloat(carsPerHH) || 0,
      evseDischargekW:     parseFloat(evseDischargekW) || 0,
      dischargeEfficiency: parseFloat(dischargeEfficiency) || 0,
      batterySizekWh:      parseFloat(batterySizekWh) || 0,
      maxBatteryWithdrawn: parseFloat(maxBatteryWithdrawn) || 0,
      loadProfile:         loadProfile.map(v => parseFloat(v) || 0),
      carsHomeProfile:     carsHomeProfile.map(v => parseFloat(v) || 0),
      baseLoad:            baseLoad.map(v => parseFloat(String(v).replace(/,/g, '')) || 0),
      ...overrides,
    };
    return {
      circuit_num:   st.circuitNum,
      cap:           st.circuitCapacity,
      thresh_pct:    st.threshold,
      inc:           st.loadIncrease / 100,
      hh:            st.households,
      cars_hh:       st.carsPerHH,
      evse_dc_lim:   st.evseDischargekW,
      eff:           st.dischargeEfficiency,
      batt:          st.batterySizekWh,
      rule_lim:      1.0,
      draw_lim:      st.maxBatteryWithdrawn,
      base_load:     st.baseLoad,
      forecast_pct:  st.loadProfile.map(v => v / 100),
      cars_home_pct: st.carsHomeProfile.map(v => v / 100),
    };
  }, [circuitNum, circuitCapacity, households, loadIncrease, threshold,
      carsPerHH, evseDischargekW, dischargeEfficiency, batterySizekWh,
      maxBatteryWithdrawn, loadProfile, carsHomeProfile, baseLoad]);

  // Run calculation
  const handleRun = useCallback((overrides = {}) => {
    setStatus('running');
    setResults(null);
    setErrorMsg('');
    try {
      const params = buildParams(overrides);
      const stdRes = runRVA(params, 'Standard');
      const optRes = runRVA(params, 'Optimized');
      setResults({ standard: stdRes, optimized: optRes, params });
      setStatus('done');
    } catch (e) {
      setErrorMsg(e.message);
      setStatus('error');
    }
  }, [buildParams]);

  // Load circuit CSV → auto-run
  const handleCircuitFile = useCallback(e => {
    const file = e.target.files && e.target.files[0];
    if (!file) return;
    e.target.value = '';
    const reader = new FileReader();
    reader.onload = ev => {
      try {
        const p = parseCircuitCSV(ev.target.result);
        if (!p.circuitNum) throw new Error('Circuit number not found');
        if (p.baseLoad.length !== 24) throw new Error(`Expected 24 base-load rows, got ${p.baseLoad.length}`);
        setCircuitNum(String(p.circuitNum));
        setCircuitCapacity(String(p.circuitCapacity));
        setHouseholds(String(p.households));
        setLoadIncrease(String(p.loadIncrease));
        setBaseLoad(p.baseLoad.map(String));
        setCircuitMsg({ ok: true, text: `Loaded: ${file.name}` });
        handleRun({
          circuit_num: p.circuitNum,
          cap:         p.circuitCapacity,
          hh:          p.households,
          inc:         p.loadIncrease / 100,
          base_load:   p.baseLoad,
        });
      } catch (err) {
        setCircuitMsg({ ok: false, text: `Load failed: ${err.message}` });
      }
    };
    reader.readAsText(file);
  }, [handleRun]);

  // Restore from summary CSV
  const handleRestoreFile = useCallback(e => {
    const file = e.target.files && e.target.files[0];
    if (!file) return;
    e.target.value = '';
    const reader = new FileReader();
    reader.onload = ev => {
      try {
        const p = parseSummaryCSV(ev.target.result);
        if (p.circuitNum         !== undefined) setCircuitNum(String(p.circuitNum));
        if (p.circuitCapacity    !== undefined) setCircuitCapacity(String(p.circuitCapacity));
        if (p.households         !== undefined) setHouseholds(String(p.households));
        if (p.loadIncrease       !== undefined) setLoadIncrease(String(p.loadIncrease));
        if (p.threshold          !== undefined) setThreshold(String(p.threshold));
        if (p.carsPerHH          !== undefined) setCarsPerHH(String(p.carsPerHH));
        if (p.evseDischargekW    !== undefined) setEvseDischargekW(String(p.evseDischargekW));
        if (p.dischargeEfficiency!== undefined) setDischargeEfficiency(String(p.dischargeEfficiency));
        if (p.batterySizekWh     !== undefined) setBatterySizekWh(String(p.batterySizekWh));
        if (p.maxBatteryWithdrawn!== undefined) setMaxBatteryWithdrawn(String(p.maxBatteryWithdrawn));
        if (p.loadProfile        !== undefined) setLoadProfile(p.loadProfile.map(v => v.toFixed(3)));
        if (p.carsHomeProfile    !== undefined) setCarsHomeProfile(p.carsHomeProfile.map(v => v.toFixed(3)));
        if (p.baseLoad           !== undefined) setBaseLoad(p.baseLoad.map(String));
        setResults(null);
        setStatus('idle');
        setRestoreMsg({ ok: true, text: `Restored from: ${file.name}` });
      } catch (err) {
        setRestoreMsg({ ok: false, text: `Restore failed: ${err.message}` });
      }
    };
    reader.readAsText(file);
  }, []);

  // Current UI state snapshot for summary CSV
  const uiState = () => ({
    circuitNum, circuitCapacity, households, loadIncrease,
    threshold, carsPerHH, evseDischargekW, dischargeEfficiency,
    batterySizekWh, maxBatteryWithdrawn, loadProfile, carsHomeProfile, baseLoad,
  });

  const statusColor = status === 'done' ? C.green : status === 'error' ? C.red : status === 'running' ? C.orange : C.faint;
  const statusText  = status === 'done' ? 'Done' : status === 'error' ? `Error: ${errorMsg}` : status === 'running' ? 'Running…' : 'Idle — load a circuit CSV to begin';

  return (
    <div style={{ background: C.bg, minHeight: '100vh', color: C.text, fontFamily: "'DM Sans','DM Mono',sans-serif", padding: '24px 20px' }}>
      <link href="https://fonts.googleapis.com/css2?family=DM+Sans:wght@300;400;600;700&family=DM+Mono:wght@400;500&display=swap" rel="stylesheet"/>

      {/* Header */}
      <div style={{ maxWidth: 920, margin: '0 auto 22px' }}>
        <div style={{ display: 'flex', alignItems: 'baseline', gap: 10, marginBottom: 6 }}>
          {['CCE / MAKELLO', 'V2G ANALYSIS ENGINE', `v${VERSION}`].map((t, i) => (
            <React.Fragment key={i}>
              {i > 0 && <div style={{ width: 1, height: 11, background: C.faint }}/>}
              <div style={{ fontSize: 11, fontFamily: "'DM Mono',monospace", color: i === 0 ? C.accent : C.faint, letterSpacing: '0.12em', fontWeight: i === 0 ? 600 : 400 }}>{t}</div>
            </React.Fragment>
          ))}
        </div>
        <h1 style={{ fontSize: 24, fontWeight: 700, color: C.text, marginBottom: 5, letterSpacing: '-0.02em' }}>V2G Analysis Engine</h1>
        <p style={{ fontSize: 12, color: C.muted, lineHeight: 1.6 }}>
          Calculates the minimum EV penetration required to shave peak load on a distribution circuit.
          Load a circuit CSV to run Standard and Optimized analysis automatically.
        </p>
      </div>

      <div style={{ maxWidth: 920, margin: '0 auto', display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 14 }}>

        {/* LEFT — Semi-permanent settings */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          <Card title="Semi-Permanent Settings">
            <Field label="Threshold"             value={threshold}           onChange={setThreshold}           note="fraction e.g. 0.90"/>
            <Field label="Cars per Household"    value={carsPerHH}           onChange={setCarsPerHH}/>
            <Field label="EVSE Discharge"        value={evseDischargekW}     onChange={setEvseDischargekW}     unit="kW"/>
            <Field label="Discharge Efficiency"  value={dischargeEfficiency} onChange={setDischargeEfficiency} note="e.g. 0.97"/>
            <Field label="Battery Size"          value={batterySizekWh}      onChange={setBatterySizekWh}      unit="kWh"/>
            <Field label="Max Battery Withdrawn" value={maxBatteryWithdrawn} onChange={setMaxBatteryWithdrawn} note="fraction e.g. 0.30"/>
            <div style={{ display: 'flex', gap: 8, marginTop: 10 }}>
              <input type="file" accept=".csv" ref={restoreInputRef} style={{ display: 'none' }} onChange={handleRestoreFile}/>
              <Btn color="muted" onClick={() => restoreInputRef.current && restoreInputRef.current.click()}>📂 Restore from Summary</Btn>
            </div>
            {restoreMsg && <div style={{ fontSize: 11, color: restoreMsg.ok ? C.green : C.red, marginTop: 6 }}>{restoreMsg.text}</div>}
          </Card>

          <Card title="Load Profile — Future Year Change (%)">
            <HourlyTable values={loadProfile} onChange={(i, v) => setLoadProfile(prev => { const a = [...prev]; a[i] = v; return a; })}/>
            <div style={{ fontSize: 10, color: C.faint, marginTop: 4 }}>Positive = growth, negative = decline</div>
          </Card>

          <Card title="% Cars Home (hourly)">
            <HourlyTable values={carsHomeProfile} onChange={(i, v) => setCarsHomeProfile(prev => { const a = [...prev]; a[i] = v; return a; })}/>
            <div style={{ fontSize: 10, color: C.faint, marginTop: 4 }}>Percent (0–100)</div>
          </Card>
        </div>

        {/* RIGHT — Circuit + results */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          <Card title="Circuit Parameters">
            <div style={{ display: 'flex', gap: 8, marginBottom: 12, alignItems: 'center' }}>
              <input type="file" accept=".csv" ref={circuitInputRef} style={{ display: 'none' }} onChange={handleCircuitFile}/>
              <Btn color="green" onClick={() => circuitInputRef.current && circuitInputRef.current.click()}>📂 Load Circuit CSV</Btn>
              {circuitMsg && <span style={{ fontSize: 11, color: circuitMsg.ok ? C.green : C.red }}>{circuitMsg.text}</span>}
            </div>
            <Field label="Circuit #"        value={circuitNum}      onChange={setCircuitNum}/>
            <Field label="Capacity"         value={circuitCapacity} onChange={setCircuitCapacity} unit="kW"/>
            <Field label="Household Meters" value={households}      onChange={setHouseholds}/>
            <Field label="Load Increase"    value={loadIncrease}    onChange={setLoadIncrease}    unit="%" note="circuit-specific"/>
          </Card>

          <Card title="Hourly Base Load (kW)">
            <HourlyTable values={baseLoad} onChange={(i, v) => setBaseLoad(prev => { const a = [...prev]; a[i] = v; return a; })}/>
            <div style={{ fontSize: 10, color: C.faint, marginTop: 4 }}>Current measured load per hour</div>
          </Card>

          {/* Status + Run */}
          <Card>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 10 }}>
              <div style={{ width: 8, height: 8, borderRadius: '50%', background: statusColor, flexShrink: 0 }}/>
              <div style={{ fontSize: 12, color: statusColor, fontFamily: "'DM Mono',monospace" }}>{statusText}</div>
            </div>
            <Btn full onClick={() => handleRun()} disabled={status === 'running'}>▶ Run Analysis</Btn>
          </Card>

          {/* Results */}
          {results && (() => {
            const { standard: s, optimized: o, params } = results;
            const balanced = Math.abs(o.grid_energy - o.batt_delivered) < 0.1;
            return (
              <Card title="Results">
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 6, marginBottom: 12 }}>
                  {['', 'Standard', 'Optimized'].map((h, i) => (
                    <div key={i} style={{ fontSize: 10, color: i === 0 ? C.faint : C.accent, fontFamily: "'DM Mono',monospace", letterSpacing: '0.08em', textTransform: 'uppercase', fontWeight: 600, paddingBottom: 4, borderBottom: `1px solid ${C.border}` }}>{h}</div>
                  ))}
                  {[
                    ['Penetration',    `${(s.penetration*100).toFixed(3)}%`,          `${(o.penetration*100).toFixed(3)}%`],
                    ['Vehicles',       s.vehicles,                                     o.vehicles],
                    ['Max Draw',       `${s.max_draw_kwh} kWh`,                        `${o.max_draw_kwh} kWh`],
                    ['Max Draw %',     `${(s.max_draw_pct*100).toFixed(1)}%`,          `${(o.max_draw_pct*100).toFixed(1)}%`],
                    ['Grid Energy',    `${s.grid_energy} kWh`,                         `${o.grid_energy} kWh`],
                    ['Batt Delivered', `${s.batt_delivered} kWh`,                      `${o.batt_delivered} kWh`],
                  ].map(([label, sv, ov]) => (
                    <React.Fragment key={label}>
                      <div style={{ fontSize: 11, color: C.muted, padding: '5px 0' }}>{label}</div>
                      <div style={{ fontSize: 12, color: C.text,  padding: '5px 0', fontFamily: "'DM Mono',monospace" }}>{sv}</div>
                      <div style={{ fontSize: 12, color: C.green, padding: '5px 0', fontFamily: "'DM Mono',monospace" }}>{ov}</div>
                    </React.Fragment>
                  ))}
                </div>
                <div style={{ fontSize: 11, color: balanced ? C.green : C.red, fontFamily: "'DM Mono',monospace", marginBottom: 12 }}>
                  {balanced ? '✓ Energy checksum balanced' : '⚠ Checksum mismatch — review history file'}
                </div>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                  <Btn full color="orange" onClick={() => downloadCSV(buildSummaryCSV(uiState(), s, o), `Circuit_${circuitNum}_V2G_summary.csv`)}>
                    ↓ Summary CSV — Circuit {circuitNum}
                  </Btn>
                  <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 6 }}>
                    <Btn onClick={() => downloadCSV(buildOutputCSV(params, o, 'Optimized'),  `Circuit_${circuitNum}_OO.csv`)}>↓ Output — Optimized</Btn>
                    <Btn onClick={() => downloadCSV(buildHistoryCSV(o, circuitNum, 'Optimized'), `Circuit_${circuitNum}_HistoryO.csv`)}>↓ History — Optimized</Btn>
                    <Btn onClick={() => downloadCSV(buildOutputCSV(params, s, 'Standard'),   `Circuit_${circuitNum}_OS.csv`)}>↓ Output — Standard</Btn>
                    <Btn onClick={() => downloadCSV(buildHistoryCSV(s, circuitNum, 'Standard'),  `Circuit_${circuitNum}_HistoryS.csv`)}>↓ History — Standard</Btn>
                  </div>
                </div>
              </Card>
            );
          })()}
        </div>
      </div>
    </div>
  );
}

const reactRoot = ReactDOM.createRoot(document.getElementById('root'));
reactRoot.render(<App />);
