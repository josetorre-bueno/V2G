// V2G Analysis Engine — UI + Computation
// Version: 1.7.0
// Part of: CCE Tools
// Pure client-side — no backend required

const { useState, useCallback, useRef, useEffect } = React;
const VERSION = "1.7.0";

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
      // Energy constraint: battery-side kWh withdrawn per car / battery_size <= draw_lim
      // grid_need / (avail * eff) = battery energy extracted per car to deliver required grid kW
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
      // Battery-side energy extracted per car per hour
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

// ── Uncoordinated mode — house load CSV ──────────────────────────────────────
// Parses a 24-row × 12-month table.
// Format: Row 1 = headers (Hour, Jan|1, Feb|2, ..., Dec|12)
//         Rows 2–25 = hours 1–24, one kWh/h value per month column
// Returns the 24-value array for the requested month (1=Jan … 12=Dec).
function parseHouseLoadCSV(text, month) {
  const clean = text.replace(/^\uFEFF/, '');
  const lines = clean.split(/\r?\n/).map(l => l.trim()).filter(l => l);

  if (lines.length < 2) throw new Error('House load CSV appears empty');

  // Parse header to find which column holds the requested month
  const MONTH_NAMES = ['jan','feb','mar','apr','may','jun',
                       'jul','aug','sep','oct','nov','dec'];
  const headers = lines[0].split(',').map(h => h.trim().toLowerCase().replace(/"/g,''));

  let monthCol = -1;
  for (let c = 1; c < headers.length; c++) {
    const h = headers[c];
    // Match numeric (1–12) or 3-letter name (jan, feb …) or full name
    const asNum = parseInt(h);
    if (!isNaN(asNum) && asNum === month) { monthCol = c; break; }
    if (MONTH_NAMES[month - 1] && h.startsWith(MONTH_NAMES[month - 1])) { monthCol = c; break; }
  }
  // Fallback: treat columns 1–12 positionally (col 1 = Jan, col 12 = Dec)
  if (monthCol < 0 && headers.length >= month + 1) monthCol = month;
  if (monthCol < 0) throw new Error(`Month ${month} not found in house load CSV headers`);

  const avgHourlyLoad = Array(24).fill(0);
  let found = 0;
  for (let i = 1; i < lines.length && found < 24; i++) {
    const parts = lines[i].split(',').map(p => p.trim().replace(/"/g,''));
    const v = parseFloat(parts[monthCol]);
    if (!isNaN(v)) { avgHourlyLoad[found] = v; found++; }
  }
  if (found < 24) throw new Error(`Only ${found} data rows found — expected 24`);

  return { avgHourlyLoad };
}

function runRVAUncoordinated(params) {
  const {
    cap, thresh_pct, inc, hh, cars_hh,
    evse_dc_lim, eff, batt, draw_lim,
    base_load, forecast_pct, cars_home_pct,
    discharge_window_start, discharge_window_end,
    house_load,
  } = params;

  const EVSE_GRID_LIM  = evse_dc_lim * eff;
  const avail_per_car  = batt * draw_lim;   // total kWh budget per car

  // Clamp window
  const wStart = Math.max(0, Math.min(23, Math.floor(discharge_window_start)));
  const wEnd   = Math.max(wStart + 1, Math.min(24, Math.floor(discharge_window_end)));

  // 1. Projected load and grid need (for reporting)
  const projected     = base_load.map((bl, i) => bl * (1 + forecast_pct[i] + inc));
  const target_thresh = cap * thresh_pct;
  const grid_need     = projected.map(p => Math.max(0, p - target_thresh));
  const total_grid_energy = grid_need.reduce((a, b) => a + b, 0);

  // 2. Per-car discharge potential per hour
  const per_car_max_grid    = Array(24).fill(0);
  const per_car_batt_per_hr = Array(24).fill(0);
  for (let h = 0; h < 24; h++) {
    if (h >= wStart && h < wEnd) {
      per_car_max_grid[h]    = Math.min(house_load[h], EVSE_GRID_LIM);
      per_car_batt_per_hr[h] = per_car_max_grid[h] > 0
        ? per_car_max_grid[h] / eff
        : 0;
    }
  }

  // 3. Cohort arrivals
  const cohort_arrivals = Array(24).fill(0);
  cohort_arrivals[wStart] = cars_home_pct[wStart];
  for (let h = wStart + 1; h < wEnd; h++) {
    const diff = cars_home_pct[h] - cars_home_pct[h - 1];
    if (diff > 0.0001) cohort_arrivals[h] = diff;
  }

  const total_fleet_potential = hh * cars_hh;

  // simulate(p): returns fleet_reduction[24]
  // Creates fresh cohort_remaining each call
  function simulate(p) {
    const n_v2g       = total_fleet_potential * p;
    const cohort_size = cohort_arrivals.map(c => n_v2g * c);
    // Fresh state per call
    const cohort_remaining = Array(24).fill(avail_per_car);
    const fleet_reduction  = Array(24).fill(0);

    for (let h = wStart; h < wEnd; h++) {
      for (let a = wStart; a <= h; a++) {
        if (cohort_size[a] <= 0 || cohort_remaining[a] <= 0) continue;
        const actual_batt = Math.min(per_car_batt_per_hr[h], cohort_remaining[a]);
        fleet_reduction[h] += cohort_size[a] * actual_batt * eff;
        cohort_remaining[a] -= actual_batt;
      }
    }
    return fleet_reduction;
  }

  // solve_v2g(p): returns (max managed load) - target_thresh
  function solve_v2g(p) {
    const fleet_reduction = simulate(p);
    let maxManaged = -Infinity;
    for (let h = 0; h < 24; h++) {
      const managed = projected[h] - fleet_reduction[h];
      if (managed > maxManaged) maxManaged = managed;
    }
    return maxManaged - target_thresh;
  }

  // Feasibility
  let p_opt;
  if (total_grid_energy <= 0) {
    p_opt = 0;
  } else if (solve_v2g(1.0) > 0) {
    p_opt = 1.0;   // can't solve even at 100%, best effort
  } else if (solve_v2g(0.0001) <= 0) {
    p_opt = 0.0001;
  } else {
    p_opt = brentq(solve_v2g, 0.0001, 1.0);
  }

  const feasible = p_opt < 1.0;

  // Second pass: build cohort history at p_opt
  const n_v2g      = total_fleet_potential * p_opt;
  const cohort_size = cohort_arrivals.map(c => n_v2g * c);
  const cohort_remaining2 = Array(24).fill(avail_per_car);
  const cohort_history    = Array.from({ length: 24 }, () => Array(24).fill(0));
  const fleet_reduction_final = Array(24).fill(0);

  for (let h = wStart; h < wEnd; h++) {
    for (let a = wStart; a <= h; a++) {
      if (cohort_size[a] <= 0 || cohort_remaining2[a] <= 0) continue;
      const actual_batt = Math.min(per_car_batt_per_hr[h], cohort_remaining2[a]);
      cohort_history[a][h]     = actual_batt;
      fleet_reduction_final[h] += cohort_size[a] * actual_batt * eff;
      cohort_remaining2[a]     -= actual_batt;
    }
  }

  // Cohort totals
  const cohort_total_draw = cohort_history.map(row => row.reduce((s, v) => s + v, 0));

  let total_batt_delivered = 0;
  for (let a = 0; a < 24; a++) {
    for (let h = 0; h < 24; h++) {
      total_batt_delivered += cohort_size[a] * cohort_history[a][h] * eff;
    }
  }

  let max_batt_draw_per_car = 0;
  for (let a = 0; a < 24; a++) {
    if (cohort_arrivals[a] > 0 && cohort_total_draw[a] > max_batt_draw_per_car) {
      max_batt_draw_per_car = cohort_total_draw[a];
    }
  }

  // Build histCols
  const historyHours = Array.from({ length: 24 }, (_, i) => i + 1);
  const histCols = { Hour: historyHours };

  for (let a = 0; a < 24; a++) {
    if (cohort_arrivals[a] > 0) {
      let cumul = 0;
      const draw = [], ratio = [];
      for (let h = 0; h < 24; h++) {
        cumul += cohort_history[a][h];
        draw.push(cumul);
        ratio.push(cohort_history[a][h] / evse_dc_lim);
      }
      histCols[`C${a + 1}_Draw_kWh`] = draw;
      histCols[`C${a + 1}_Ratio`]    = ratio;
    }
  }

  return {
    penetration:    p_opt,
    vehicles:       Math.round(n_v2g),
    max_draw_kwh:   Math.round(max_batt_draw_per_car * 100) / 100,
    max_draw_pct:   batt > 0 ? max_batt_draw_per_car / batt : 0,
    grid_energy:    Math.round(total_grid_energy * 100) / 100,
    batt_delivered: Math.round(total_batt_delivered * 100) / 100,
    projected, grid_need,
    fleet_power_grid: fleet_reduction_final,
    target_thresh,
    histCols,
    feasible,
  };
}

// ── V2G Uncoordinated mode ────────────────────────────────────────────────────
// Each car discharges at a flat rate computed on arrival:
//   rate = min((soc_init − soc_min) × batt / hours_remaining, evse_dc_lim)
// Cars present at window start use soc_present; arriving cars use soc_arriving.
// Discharge is sent directly to the grid (reduces circuit load).
function runRVAV2G(params) {
  const {
    cap, thresh_pct, inc, hh, cars_hh,
    evse_dc_lim, eff, batt,
    soc_arriving, soc_present, soc_min,
    discharge_window_start, discharge_window_end,
    base_load, forecast_pct, cars_home_pct,
  } = params;

  const projected     = base_load.map((bl, i) => bl * (1 + forecast_pct[i] + inc));
  const target_thresh = cap * thresh_pct;
  const peak_mask     = projected.map(p => p > target_thresh);
  const grid_need     = projected.map(p => Math.max(0, p - target_thresh));
  const total_grid_energy = grid_need.reduce((a, b) => a + b, 0);
  const total_fleet   = hh * cars_hh;

  const ws = Math.max(0, Math.min(23, discharge_window_start));
  const we = Math.max(ws + 1, Math.min(24, discharge_window_end));

  // Cohort arrivals over discharge window (fraction of total fleet)
  const cohort_arrivals = new Array(24).fill(0);
  cohort_arrivals[ws] = cars_home_pct[ws];
  for (let h = ws + 1; h < we; h++) {
    const diff = cars_home_pct[h] - cars_home_pct[h - 1];
    if (diff > 0.0001) cohort_arrivals[h] = diff;
  }

  // Pre-compute flat grid-side rate (kW) for each cohort
  const cohort_rate_grid = new Array(24).fill(0);
  for (let a = ws; a < we; a++) {
    if (cohort_arrivals[a] <= 0) continue;
    const soc_init  = (a === ws) ? soc_present : soc_arriving;
    const avail     = Math.max(0, soc_init - soc_min) * batt;
    const hrs       = we - a;
    const rate_dc   = Math.min(avail / hrs, evse_dc_lim);
    cohort_rate_grid[a] = Math.max(0, rate_dc * eff);
  }

  // Check whether any peak hour falls inside the discharge window
  const peak_in_window = peak_mask.some((m, h) => m && h >= ws && h < we);

  // Solver: return (worst managed load above threshold) across all peak hours
  function solve(p) {
    const n_f = total_fleet * p;
    let worst = -Infinity;
    for (let h = 0; h < 24; h++) {
      if (!peak_mask[h]) continue;
      let fleet_kw = 0;
      if (h >= ws && h < we) {
        for (let a = ws; a <= h; a++) {
          fleet_kw += cohort_rate_grid[a] * cohort_arrivals[a] * n_f;
        }
      }
      worst = Math.max(worst, projected[h] - fleet_kw - target_thresh);
    }
    return worst;
  }

  let p_opt = 0;
  let feasible = true;
  if (peak_in_window && total_grid_energy > 0) {
    if (solve(1.0) > 0) {
      p_opt = 1.0; feasible = false;
    } else {
      p_opt = brentq(solve, 0.0001, 1.0);
    }
  }

  const n_final = total_fleet * p_opt;

  // Build fleet_power_grid and history
  const fleet_power_grid = new Array(24).fill(0);
  const histCols = { Hour: Array.from({ length: 24 }, (_, i) => i + 1) };
  let total_batt_delivered_grid = 0;
  let batt_draw_max_kwh = 0;

  if (n_final > 0) {
    for (let h = 0; h < 24; h++) {
      if (h < ws || h >= we) continue;
      for (let a = ws; a <= h; a++) {
        fleet_power_grid[h] += cohort_rate_grid[a] * cohort_arrivals[a] * n_final;
      }
    }

    for (let a = ws; a < we; a++) {
      if (cohort_arrivals[a] <= 0) continue;
      const soc_init = (a === ws) ? soc_present : soc_arriving;
      const avail    = Math.max(0, soc_init - soc_min) * batt;
      const hrs      = we - a;
      const rate_dc  = Math.min(avail / hrs, evse_dc_lim);
      const actual_draw = rate_dc * hrs;           // kWh per car drawn from battery
      batt_draw_max_kwh = Math.max(batt_draw_max_kwh, actual_draw);
      const cohort_size = cohort_arrivals[a] * n_final;
      total_batt_delivered_grid += rate_dc * eff * hrs * cohort_size;

      const draw = [], ratio = [];
      for (let h = 0; h < 24; h++) {
        draw.push(h >= a && h < we ? rate_dc * (h - a + 1) : (h >= we ? actual_draw : 0));
        ratio.push(h >= a && h < we ? rate_dc / evse_dc_lim : 0);
      }
      histCols[`C${a + 1}_Draw_kWh`] = draw;
      histCols[`C${a + 1}_Ratio`]    = ratio;
    }
  }

  return {
    penetration:    p_opt,
    vehicles:       Math.round(n_final),
    max_draw_kwh:   Math.round(batt_draw_max_kwh * 100) / 100,
    max_draw_pct:   batt > 0 ? batt_draw_max_kwh / batt : 0,
    grid_energy:    Math.round(total_grid_energy * 100) / 100,
    batt_delivered: Math.round(total_batt_delivered_grid * 100) / 100,
    feasible,
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

// Uncoordinated output CSV — same 37×13 structure, modified for uncoordinated mode
function buildOutputCSVUncoord(params, res) {
  const {
    cap, thresh_pct, inc, hh, cars_hh, evse_dc_lim, eff, batt, draw_lim,
    base_load, forecast_pct, cars_home_pct, circuit_num,
    discharge_window_start, discharge_window_end, house_load,
  } = params;
  const { penetration, vehicles, max_draw_kwh, max_draw_pct, grid_energy, batt_delivered,
          projected, grid_need, fleet_power_grid, target_thresh } = res;
  const managed_load = projected.map((p, i) => p - fleet_power_grid[i]);
  const n_final = total_fleet_potential(hh, cars_hh) * penetration;

  const wStart = Math.max(0, Math.min(23, Math.floor(discharge_window_start)));
  const wEnd   = Math.max(wStart + 1, Math.min(24, Math.floor(discharge_window_end)));

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
    [`Discharge Window`, `${wStart}–${wEnd}`],    // row index 9 — replaces rule_lim
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
           'Load profile + increase (E)','BEV availables (H)','House Load (kW)',
           'Projected kW (F)','Managed kW (I)','','','Threshold (N)','Capacity(O)'];

  for (let i = 0; i < 24; i++) {
    const r = 12 + i;
    R[r][0]  = String(i + 1);
    R[r][1]  = base_load[i].toFixed(0);
    R[r][2]  = (forecast_pct[i] * 100).toFixed(3) + '%';
    R[r][3]  = (cars_home_pct[i] * 100).toFixed(3) + '%';
    R[r][4]  = ((forecast_pct[i] + inc) * 100).toFixed(5) + '%';
    R[r][5]  = (n_final * cars_home_pct[i]).toFixed(4);
    R[r][6]  = (house_load[i] || 0).toFixed(4);   // house_load instead of grid_need
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
function buildSummaryCSV(state, vppRes, v2gRes, v2hRes) {
  const { circuitNum, circuitCapacity, households, loadIncrease,
          threshold, carsPerHH, evseDischargekW, dischargeEfficiency,
          batterySizekWh, maxBatteryWithdrawn,
          loadProfile, carsHomeProfile, baseLoad,
          dischargeWindowStart, dischargeWindowEnd, circuitMonth, houseLoad,
          socArriving, socPresent, socMin } = state;
  const o = vppRes, g = v2gRes, u = v2hRes || null;
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
  rows.push(`V2G SOC on Arrival,${socArriving}`);
  rows.push(`V2G SOC at Window Start,${socPresent}`);
  rows.push(`V2G Min SOC,${socMin}`);
  rows.push(`Discharge Window Start,${dischargeWindowStart}`);
  rows.push(`Discharge Window End,${dischargeWindowEnd}`);
  rows.push(`Circuit Month,${circuitMonth}`);
  rows.push('');
  rows.push('RESULTS');
  rows.push(`Metric,VPP,V2G,V2H`);
  rows.push(`V2G Penetration,${(o.penetration*100).toFixed(3)}%,${(g.penetration*100).toFixed(3)}%,${u ? (u.penetration*100).toFixed(3)+'%' : 'N/A'}`);
  rows.push(`Vehicle Count,${o.vehicles},${g.vehicles},${u ? u.vehicles : 'N/A'}`);
  rows.push(`Max Battery Draw (kWh),${o.max_draw_kwh},${g.max_draw_kwh},${u ? u.max_draw_kwh : 'N/A'}`);
  rows.push(`Max Draw (% of Battery),${(o.max_draw_pct*100).toFixed(1)}%,${(g.max_draw_pct*100).toFixed(1)}%,${u ? (u.max_draw_pct*100).toFixed(1)+'%' : 'N/A'}`);
  rows.push(`Grid Energy Needed (kWh),${o.grid_energy},${g.grid_energy},${u ? u.grid_energy : 'N/A'}`);
  rows.push(`Battery Energy Delivered (kWh),${o.batt_delivered},${g.batt_delivered},${u ? u.batt_delivered : 'N/A'}`);
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
  // Graph data table — ready to select and chart in Excel
  rows.push('GRAPH DATA');
  const capVal   = parseFloat(circuitCapacity) || 0;
  const thrVal   = capVal * (parseFloat(threshold) || 0);
  const hdr = ['Hour','Circuit Capacity (kW)','Threshold (kW)','Base Load (kW)',
                'Projected (kW)','Managed VPP (kW)','Managed V2G (kW)',
                ...(u ? ['Managed V2H (kW)'] : [])];
  rows.push(hdr.join(','));
  for (let i = 0; i < 24; i++) {
    const projVal = o.projected[i];
    const mO = (projVal - o.fleet_power_grid[i]).toFixed(1);
    const mG = (projVal - g.fleet_power_grid[i]).toFixed(1);
    const bl = parseFloat(String(baseLoad[i]).replace(/,/g, '')) || 0;
    const cols = [
      i + 1,
      capVal.toFixed(0),
      thrVal.toFixed(1),
      bl.toFixed(1),
      projVal.toFixed(1),
      mO,
      mG,
      ...(u ? [(projVal - u.fleet_power_grid[i]).toFixed(1)] : []),
    ];
    rows.push(cols.join(','));
  }
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
  rows.push(`dischargeWindowStart,${dischargeWindowStart}`);
  rows.push(`dischargeWindowEnd,${dischargeWindowEnd}`);
  rows.push(`circuitMonth,${circuitMonth}`);
  rows.push(`houseLoad,${houseLoad.map(v => parseFloat(v) || 0).join('|')}`);
  rows.push(`socArriving,${socArriving}`);
  rows.push(`socPresent,${socPresent}`);
  rows.push(`socMin,${socMin}`);
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
  if (kv.dischargeWindowStart !== undefined) r.dischargeWindowStart = parseInt(kv.dischargeWindowStart);
  if (kv.dischargeWindowEnd   !== undefined) r.dischargeWindowEnd   = parseInt(kv.dischargeWindowEnd);
  if (kv.circuitMonth         !== undefined) r.circuitMonth         = parseInt(kv.circuitMonth);
  if (kv.houseLoad            !== undefined) r.houseLoad            = kv.houseLoad.split('|').map(Number);
  if (kv.socArriving !== undefined) r.socArriving = parseFloat(kv.socArriving);
  if (kv.socPresent  !== undefined) r.socPresent  = parseFloat(kv.socPresent);
  if (kv.socMin      !== undefined) r.socMin      = parseFloat(kv.socMin);
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

function Btn({ children, onClick, color, disabled, full, style: btnStyle }) {
  const bg = color === 'green'  ? `linear-gradient(135deg,#007a48,${C.green})`
           : color === 'orange' ? `linear-gradient(135deg,#7a4000,${C.orange})`
           : color === 'muted'  ? 'transparent'
           : `linear-gradient(135deg,#00508a,${C.accent})`;
  const fg = color === 'green' ? '#001a0f' : color === 'orange' ? '#180d00' : color === 'muted' ? C.muted : '#001220';
  return (
    <button onClick={onClick} disabled={disabled}
      style={{ background: disabled ? C.faint : bg, border: color === 'muted' ? `1px solid ${C.border}` : 'none', borderRadius: 7, color: disabled ? '#555' : fg, padding: '8px 14px', fontSize: 11, fontWeight: 700, fontFamily: "'DM Sans', sans-serif", letterSpacing: '0.04em', cursor: disabled ? 'not-allowed' : 'pointer', textTransform: 'uppercase', width: full ? '100%' : undefined, ...btnStyle }}
    >{children}</button>
  );
}

// ── Circuit chart ─────────────────────────────────────────────────────────────
// ctx, W, H: canvas context and logical dimensions
// theme: 'dark' (screen) | 'light' (export PNG)
function drawCircuitChart(ctx, W, H, results, params, theme) {
  const { vpp: o, v2g: g, v2h: u } = results;
  const { cap, thresh_pct, base_load, circuit_num } = params;
  const dark = theme !== 'light';

  // Theme colours
  const T = dark ? {
    bg:        '#111827',
    grid:      '#1e2d45',
    label:     '#7a9cbf',
    title:     '#e8f4ff',
    legBg:     'rgba(10,15,26,0.88)',
    legBorder: '#1e2d45',
    legText:   '#7a9cbf',
  } : {
    bg:        '#ffffff',
    grid:      '#d0d8e4',
    label:     '#4a5568',
    title:     '#1a202c',
    legBg:     'rgba(255,255,255,0.93)',
    legBorder: '#b0bbc8',
    legText:   '#4a5568',
  };

  const ml = 68, mr = 180, mt = 32, mb = 44;
  const pw = W - ml - mr;
  const ph = H - mt - mb;

  // Data
  const threshold = cap * thresh_pct;
  const projected = o.projected;
  const managedO  = projected.map((v, i) => v - o.fleet_power_grid[i]);
  const managedG  = projected.map((v, i) => v - g.fleet_power_grid[i]);

  const yMax = Math.ceil(cap * 1.08 / 1000) * 1000;
  const yMin = 0;
  const xAt  = i => ml + (i / 23) * pw;
  const yAt  = v => mt + ph - Math.max(0, Math.min(1, (v - yMin) / (yMax - yMin))) * ph;

  // ── Background ────────────────────────────────────────────────────────────
  ctx.fillStyle = T.bg;
  ctx.fillRect(0, 0, W, H);

  // ── Y grid + labels ───────────────────────────────────────────────────────
  ctx.font = '10px "DM Mono", monospace';
  ctx.textAlign = 'right';
  for (let t = 0; t <= 6; t++) {
    const v = yMin + (yMax - yMin) * t / 6;
    const y = yAt(v);
    ctx.strokeStyle = T.grid; ctx.lineWidth = 1; ctx.setLineDash([]);
    ctx.beginPath(); ctx.moveTo(ml, y); ctx.lineTo(ml + pw, y); ctx.stroke();
    ctx.fillStyle = T.label;
    ctx.fillText(Math.round(v).toLocaleString(), ml - 5, y + 4);
  }

  // ── X grid + labels ───────────────────────────────────────────────────────
  ctx.textAlign = 'center';
  for (let h = 0; h < 24; h++) {
    const x = xAt(h);
    if (h % 4 === 0) {
      ctx.strokeStyle = T.grid; ctx.lineWidth = 1; ctx.setLineDash([]);
      ctx.beginPath(); ctx.moveTo(x, mt); ctx.lineTo(x, mt + ph); ctx.stroke();
    }
    ctx.fillStyle = T.label;
    ctx.fillText(h + 1, x, mt + ph + 14);
  }

  // ── Plot border ───────────────────────────────────────────────────────────
  ctx.strokeStyle = T.grid; ctx.lineWidth = 1; ctx.setLineDash([]);
  ctx.strokeRect(ml, mt, pw, ph);

  // ── Series helper ─────────────────────────────────────────────────────────
  function drawSeries(data, color, lw, dashed) {
    ctx.strokeStyle = color; ctx.lineWidth = lw; ctx.lineJoin = 'round';
    ctx.setLineDash(dashed ? [6, 4] : []);
    ctx.beginPath();
    data.forEach((v, i) => { const x = xAt(i), y = yAt(v); i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y); });
    ctx.stroke(); ctx.setLineDash([]);
  }

  // Series (back to front)
  const capColor  = dark ? '#2a3a50' : '#c0cad8';
  const thrColor  = dark ? '#4a6890' : '#7090b0';
  const baseColor = dark ? '#3a5878' : '#8098b4';
  drawSeries(Array(24).fill(cap),       capColor, 1,   true);
  drawSeries(Array(24).fill(threshold), thrColor, 1.5, true);
  drawSeries(base_load,  baseColor, 1.5, false);
  drawSeries(projected,  '#c03030', 2,   false);
  if (u) drawSeries(projected.map((v, i) => v - u.fleet_power_grid[i]), '#e07020', 2, false);
  drawSeries(managedG,   '#a855f7', 2,   false);
  drawSeries(managedO,   '#00c97a', 2.5, false);

  // ── Title ─────────────────────────────────────────────────────────────────
  ctx.fillStyle = T.title;
  ctx.font = 'bold 12px "DM Sans", sans-serif';
  ctx.textAlign = 'left';
  ctx.fillText(`Circuit ${circuit_num} — Hourly Load (kW)`, ml, mt - 10);

  // ── Axis labels ───────────────────────────────────────────────────────────
  ctx.fillStyle = T.label; ctx.font = '10px "DM Sans", sans-serif';
  ctx.textAlign = 'center';
  ctx.fillText('Hour of Day', ml + pw / 2, H - 6);
  ctx.save();
  ctx.translate(11, mt + ph / 2); ctx.rotate(-Math.PI / 2);
  ctx.textAlign = 'center'; ctx.fillText('kW', 0, 0);
  ctx.restore();

  // ── Legend (right side, outside plot area) ───────────────────────────────
  const pctO = (o.penetration * 100).toFixed(1);
  const pctG = (g.penetration * 100).toFixed(1);
  const pctU = u ? (u.penetration * 100).toFixed(1) : null;
  const legendItems = [
    { label: 'Base Load',              color: baseColor, dashed: false, lw: 1.5 },
    { label: 'Projected',              color: '#c03030', dashed: false, lw: 2   },
    { label: `VPP (${pctO}%)`,         color: '#00c97a', dashed: false, lw: 2.5 },
    { label: `V2G (${pctG}%)`,         color: '#a855f7', dashed: false, lw: 2   },
    ...(pctU ? [{ label: `V2H (${pctU}%)`, color: '#e07020', dashed: false, lw: 2 }] : []),
    { label: `Threshold (${(thresh_pct * 100).toFixed(0)}%)`, color: thrColor, dashed: true, lw: 1.5 },
  ];

  const ROW = 19, PAD = 8, LINE = 22, GAP = 6;
  const lx = ml + pw + 8;
  const ly = mt + 4;
  const legW = mr - 12;
  const legH = legendItems.length * ROW + PAD * 2;

  ctx.fillStyle = T.legBg;
  ctx.beginPath();
  ctx.roundRect ? ctx.roundRect(lx, ly, legW, legH, 4)
                : ctx.rect(lx, ly, legW, legH);
  ctx.fill();
  ctx.strokeStyle = T.legBorder; ctx.lineWidth = 1; ctx.setLineDash([]);
  ctx.stroke();

  ctx.font = '10px "DM Sans", sans-serif'; ctx.textAlign = 'left';
  legendItems.forEach(({ label, color, dashed, lw }, idx) => {
    const iy = ly + PAD + idx * ROW + ROW / 2;
    ctx.strokeStyle = color; ctx.lineWidth = lw;
    ctx.setLineDash(dashed ? [5, 3] : []);
    ctx.beginPath(); ctx.moveTo(lx + PAD, iy); ctx.lineTo(lx + PAD + LINE, iy); ctx.stroke();
    ctx.setLineDash([]);
    ctx.fillStyle = T.legText;
    ctx.fillText(label, lx + PAD + LINE + GAP, iy + 4);
  });
}

// ── User Manual ───────────────────────────────────────────────────────────────
const MANUAL = [
  {
    heading: "OVERVIEW",
    body: "The V2G Analysis Engine calculates the minimum percentage of EVs on a distribution circuit that must be V2G-capable to shave the circuit's peak load below a set threshold. Three models are available: VPP (coordinated), V2G (uncoordinated grid export), and V2H (uncoordinated house offset). All computation runs entirely in the browser — no data is sent to any server.",
  },
  {
    heading: "THE THREE MODELS",
    bullets: [
      "VPP (Virtual Power Plant) — A dispatch-optimised coordinated model. Spreads energy withdrawal evenly across the peak window, limited by EVSE rate and the battery draw rule. Finds the minimum fleet size such that all cohorts together have just enough stored energy to cover the cumulative grid deficit. Gives the lowest possible vehicle count for a coordinated fleet.",
      "V2G (Vehicle-to-Grid, Uncoordinated) — Each car computes a flat discharge rate on arrival: available energy \u00f7 hours remaining in the discharge window, capped at EVSE capacity. Available energy = (arrival SOC \u2212 min SOC) \u00d7 battery size. Discharge goes directly to the grid, reducing circuit load. No coordination \u2014 cars discharge regardless of whether it helps the circuit peak. Finds the minimum fleet where at least the peak hours fall below threshold.",
      "V2H (Vehicle-to-Home, Uncoordinated) — Each V2G car acts independently. When home during the discharge window, it supplies only enough power to zero its own house's meter draw, limited by EVSE capacity and the 30% battery draw rule. No central control. Requires a household load profile CSV. Generally needs more cars than VPP because discharge is not directed at the circuit peak.",
    ],
  },
  {
    heading: "ENERGY CONSTRAINT NOTE",
    body: "The VPP model uses a battery-side energy constraint: the kWh withdrawn from the battery equals the grid energy delivered divided by the discharge efficiency (e.g. 97%). This is physically correct — efficiency losses mean each car must give up slightly more energy from its battery than arrives at the grid. The Excel Solver reference model omits this correction, causing a small undercount (\u2248 0.2 percentage points for typical parameters).",
  },
  {
    heading: "SEMI-PERMANENT SETTINGS",
    bullets: [
      "Threshold — fraction of circuit capacity that defines the peak-shaving target (e.g. 0.90 = 90%). Load above this line is the deficit the V2G fleet must cover.",
      "Cars per Household — average number of vehicles per metered household. Determines the total fleet potential (Household Meters \u00d7 Cars per Household).",
      "EVSE Discharge (kW) — DC-side discharge rate of each vehicle's charger. Typical Level 2 bidirectional charger: 11.5\u201312.8 kW.",
      "Discharge Efficiency — fraction of battery energy that reaches the grid (e.g. 0.97 = 97%). Applied to convert battery-side draw to grid-side delivery.",
      "Battery Size (kWh) — usable battery capacity per vehicle (e.g. 88 kWh for a typical long-range EV).",
      "Max % Battery Withdrawn — maximum fraction of battery that V2G may draw in one peak period (e.g. 0.30 = 30%). Protects the driver's range.",
      "V2G SOC on Arrival — state of charge of cars that arrive during the discharge window (e.g. 0.90 = 90%, representing cars charged at work).",
      "V2G SOC at Window Start — state of charge of cars already home when the discharge window opens (e.g. 0.90 = 90%).",
      "V2G Min SOC — minimum SOC the V2G algorithm is allowed to discharge to (e.g. 0.20 = 20%). Available energy per car = (initial SOC \u2212 Min SOC) \u00d7 battery size.",
      "Discharge Window Start / End — hours (0\u201323 / 1\u201324) defining when the V2G and V2H modes are active. Default 16\u201324 = 4 PM to midnight.",
    ],
  },
  {
    heading: "LOAD PROFILE — FUTURE YEAR CHANGE (%)",
    body: "24 hourly values (one per hour of the day) representing the expected change in load between the base year and the future year, as a percentage. Positive = growth, negative = decline. The default profile is derived from historical SDG&E circuit data. These values are added to the circuit-specific Load Increase to produce the total projected load for each hour.",
  },
  {
    heading: "% CARS HOME (HOURLY)",
    body: "24 hourly values representing the percentage of the total vehicle fleet that is plugged in at home at each hour. Used to determine how many V2G cars are available to discharge in each hour and to define arrival cohorts. Values near 100% overnight, dropping to 30\u201340% during work hours, are typical.",
  },
  {
    heading: "CIRCUIT PARAMETERS",
    bullets: [
      "Load Circuit CSV — uploads a Circuit_N_I.csv file and auto-fills all circuit fields, then runs the analysis automatically.",
      "Circuit # — identifier used in output filenames.",
      "Capacity (kW) — the thermal or contractual limit of the distribution circuit. The threshold is applied as a fraction of this value.",
      "Household Meters — number of residential meters on the circuit. Combined with Cars per Household to determine total fleet potential.",
      "Load Increase (%) — circuit-specific forecast growth added uniformly across all 24 hours (in addition to the hourly Load Profile).",
      "Circuit Month — month (1\u201312) of the base load data. Selects which column of the household load table to use for the V2H model. Default 9 (September) — the most demanding month for SDG\u0026E circuits.",
    ],
  },
  {
    heading: "HOUSEHOLD LOAD PROFILE (GREEN BUTTON)",
    body: "Used only by the V2H model. Upload a household load CSV containing average kWh/hr by hour and month. Format: row 1 is a header (Hour, Jan, Feb, \u2026 Dec or 1, 2, \u2026 12); rows 2\u201325 are hours 1\u201324 with one value per month column. The app extracts the 24 values for the selected Circuit Month. The profile represents a typical household\u2019s hourly consumption \u2014 the amount each V2H car will attempt to offset from the grid.",
    body2: "When the Circuit Month setting is changed, the profile is automatically re-extracted from the already-loaded table \u2014 no re-upload required. The profile is shown in the read-only table and saved in the Summary CSV for future restores.",
  },
  {
    heading: "RUNNING THE ANALYSIS",
    body: "Load a Circuit CSV to run automatically, or fill in the circuit fields manually and click \u25b6 Run Analysis. VPP and V2G always run. V2H runs only when a household load profile has been loaded. Results appear immediately \u2014 all calculation is done in the browser.",
  },
  {
    heading: "RESULTS — WHAT THE NUMBERS MEAN",
    bullets: [
      "Penetration % — the minimum fraction of all vehicles on the circuit that must be V2G-capable. Multiply by (Household Meters \u00d7 Cars per Household) to get the vehicle count.",
      "Vehicles — absolute count of V2G-capable cars needed, rounded to the nearest whole vehicle.",
      "Max Draw (kWh) — maximum cumulative kWh withdrawn from a single car's battery across the entire peak or discharge window. VPP: the optimal per-car energy target T. V2G: maximum cumulative draw for the earliest-window cohort (rate \u00d7 hours). May be less than available if EVSE cap was not reached. V2H: total draw for the earliest-arriving cohort.",
      "Max Draw % — Max Draw as a fraction of battery size. Should be \u2264 Max % Battery Withdrawn (the 30% rule). A value near the limit means the battery constraint is binding.",
      "Grid Energy Needed (kWh) — total kWh above the threshold across all hours in the peak window. This is the aggregate grid deficit the V2G fleet must cover.",
      "Battery Energy Delivered (kWh) — total kWh delivered to the grid by the entire V2G fleet. In VPP mode this should equal Grid Energy Needed (the energy checksum). In V2G and V2H modes they will generally differ.",
    ],
  },
  {
    heading: "ENERGY CHECKSUM",
    body: "The green \u2713 Energy checksum balanced message confirms that the VPP model's total battery delivery exactly equals the grid deficit — a mathematical validation that the dispatch algorithm is internally consistent. A mismatch indicates a calculation error. The V2G and V2H models do not carry this guarantee by design.",
  },
  {
    heading: "OUTPUT FILES",
    bullets: [
      "Circuit_N_OV.csv — VPP mode output. 37-row \u00d7 13-column table matching the layout of the original Excel model (V2GModel.xlsx). The Managed kW column shows the load after optimised V2G dispatch — it should sit at or just below the threshold during all peak hours.",
      "Circuit_N_OG.csv — V2G mode output. Same structure. The Managed kW column shows circuit load after uncoordinated V2G discharge.",
      "Circuit_N_OH.csv — V2H mode output. Same structure but column 7 shows House Load (kW).",
      "Circuit_N_HistoryV.csv — VPP cohort history. One row per hour, one pair of columns per arrival cohort (C1\u2013C24). _Draw_kWh = cumulative per-car battery draw up to that hour. _Ratio = per-hour draw as a fraction of EVSE capacity. GridNeeded and BattDelivered in the header should be equal (energy checksum).",
      "Circuit_N_HistoryG.csv — V2G cohort history. One row per hour, one column pair per discharge-window cohort.",
      "Circuit_N_HistoryH.csv — V2H cohort history.",
      "Circuit_N_V2G_summary.csv — Summary and restore file. Contains all input parameters, results for all active modes, the 24-hour load profile, the cars-home profile, the base load, and (if V2H was run) the household load profile. Load this file with the \ud83d\udcc2 Restore from Summary button to recreate the exact inputs used for any previous run.",
    ],
  },
  {
    heading: "RESTORE FROM SUMMARY",
    body: "Click \ud83d\udcc2 Restore from Summary and select a previously saved Circuit_N_V2G_summary.csv. All semi-permanent settings and circuit-specific inputs are restored. The household load profile (if present) is also restored \u2014 you do not need to re-upload the House Load CSV. After restoring, click \u25b6 Run Analysis to regenerate results.",
  },
  {
    heading: "CIRCUIT INPUT FILE FORMAT",
    body: "The Circuit_N_I.csv input file uses a simple two-column format:",
    bullets: [
      "Row 1: V2G Circuit Input (title, ignored)",
      "Circuit, N",
      "Circuit Capacity, kW value",
      "Household Meters, count",
      "Load Increase, value% (or plain number)",
      "Hour, Base Load (kW) (column header)",
      "Rows 1\u201324: hour number, base load kW",
    ],
    body2: "All other parameters (threshold, vehicle specs, profiles) are semi-permanent and stored in the Summary CSV.",
  },
  {
    heading: "DISCLAIMER",
    body: "Results are based on modeled parameters and simplified assumptions about vehicle availability, battery state, and household load profiles. Actual V2G performance will depend on driver behavior, vehicle charging agreements, local grid conditions, and utility tariff structures. This tool is intended for planning and feasibility studies, not operational dispatch.",
  },
];

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

  // Uncoordinated mode
  const [dischargeWindowStart, setDischargeWindowStart] = useState('16');
  const [dischargeWindowEnd,   setDischargeWindowEnd]   = useState('24');
  const [circuitMonth,         setCircuitMonth]         = useState('9');
  const [houseLoad,            setHouseLoad]            = useState(Array(24).fill(''));
  const [houseLoadCSVRaw,      setHouseLoadCSVRaw]      = useState('');
  const [houseLoadCSVMsg,      setHouseLoadCSVMsg]      = useState(null);
  const houseLoadInputRef = useRef(null);

  // V2G mode SOC parameters
  const [socArriving, setSocArriving] = useState('0.90');
  const [socPresent,  setSocPresent]  = useState('0.90');
  const [socMin,      setSocMin]      = useState('0.20');

  // Circuit-specific
  const [circuitNum,      setCircuitNum]      = useState('');
  const [circuitCapacity, setCircuitCapacity] = useState('');
  const [households,      setHouseholds]      = useState('');
  const [loadIncrease,    setLoadIncrease]    = useState('0');
  const [baseLoad,        setBaseLoad]        = useState(Array(24).fill(''));

  // Transient
  const [status,     setStatus]     = useState('idle');
  const [results,    setResults]    = useState(null);
  const [restoreMsg, setRestoreMsg] = useState(null);
  const [circuitMsg, setCircuitMsg] = useState(null);
  const [errorMsg,   setErrorMsg]   = useState('');

  // Manual
  const [showManual, setShowManual] = useState(false);

  const circuitInputRef = useRef(null);
  const restoreInputRef = useRef(null);
  const canvasRef = useRef(null);

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

  // Build uncoordinated params (extends buildParams)
  const buildUncParams = useCallback((overrides = {}) => {
    return {
      ...buildParams(overrides),
      discharge_window_start: parseInt(dischargeWindowStart) || 16,
      discharge_window_end:   parseInt(dischargeWindowEnd)   || 24,
      house_load: houseLoad.map(v => parseFloat(String(v).replace(/,/g,'')) || 0),
    };
  }, [buildParams, dischargeWindowStart, dischargeWindowEnd, houseLoad]);

  // Month change handler — re-extract from loaded house load table if available
  const handleMonthChange = useCallback(val => {
    setCircuitMonth(val);
    if (houseLoadCSVRaw) {
      try {
        const mo = Math.max(1, Math.min(12, parseInt(val) || 9));
        const { avgHourlyLoad } = parseHouseLoadCSV(houseLoadCSVRaw, mo);
        setHouseLoad(avgHourlyLoad.map(v => v.toFixed(3)));
        setHouseLoadCSVMsg({ ok: true, text: `Month ${mo} extracted from loaded table` });
      } catch (e) {
        setHouseLoadCSVMsg({ ok: false, text: e.message });
      }
    }
  }, [houseLoadCSVRaw]);

  // House load CSV file handler (24-row × 12-month table)
  const handleHouseLoadFile = useCallback(e => {
    const file = e.target.files && e.target.files[0];
    if (!file) return;
    e.target.value = '';
    const reader = new FileReader();
    reader.onload = ev => {
      const text = ev.target.result;
      try {
        const mo = Math.max(1, Math.min(12, parseInt(circuitMonth) || 9));
        const { avgHourlyLoad } = parseHouseLoadCSV(text, mo);
        setHouseLoadCSVRaw(text);
        setHouseLoad(avgHourlyLoad.map(v => v.toFixed(3)));
        setHouseLoadCSVMsg({ ok: true, text: `Month ${mo} loaded — ${file.name}` });
      } catch (err) {
        setHouseLoadCSVMsg({ ok: false, text: `Parse failed: ${err.message}` });
      }
    };
    reader.readAsText(file);
  }, [circuitMonth]);

  // Run calculation
  const handleRun = useCallback((overrides = {}) => {
    setStatus('running');
    setResults(null);
    setErrorMsg('');
    try {
      const params  = buildParams(overrides);
      const vppRes  = runRVA(params, 'Optimized');

      // V2G: always runs (uses SOC parameters, no house load needed)
      const v2gParams = {
        ...params,
        soc_arriving:           parseFloat(socArriving) || 0.90,
        soc_present:            parseFloat(socPresent)  || 0.90,
        soc_min:                parseFloat(socMin)      || 0.20,
        discharge_window_start: parseInt(dischargeWindowStart) || 16,
        discharge_window_end:   parseInt(dischargeWindowEnd)   || 24,
      };
      const v2gRes = runRVAV2G(v2gParams);

      // V2H: only runs when house load is loaded
      let v2hRes = null;
      const hl = houseLoad.map(v => parseFloat(String(v).replace(/,/, '')) || 0);
      if (hl.some(v => v > 0)) {
        const v2hParams = {
          ...params,
          discharge_window_start: parseInt(dischargeWindowStart) || 16,
          discharge_window_end:   parseInt(dischargeWindowEnd)   || 24,
          house_load: hl,
        };
        v2hRes = runRVAUncoordinated(v2hParams);
      }

      setResults({ vpp: vppRes, v2g: v2gRes, v2h: v2hRes, params });
      setStatus('done');
    } catch (e) {
      setErrorMsg(e.message);
      setStatus('error');
    }
  }, [buildParams, houseLoad, dischargeWindowStart, dischargeWindowEnd,
      socArriving, socPresent, socMin]);

  React.useEffect(() => {
    if (!results || !canvasRef.current) return;
    const c = canvasRef.current;
    drawCircuitChart(c.getContext('2d'), c.width, c.height, results, results.params, 'dark');
  }, [results]);

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
        if (p.dischargeWindowStart !== undefined) setDischargeWindowStart(String(p.dischargeWindowStart));
        if (p.dischargeWindowEnd   !== undefined) setDischargeWindowEnd(String(p.dischargeWindowEnd));
        if (p.circuitMonth         !== undefined) setCircuitMonth(String(p.circuitMonth));
        if (p.houseLoad            !== undefined) setHouseLoad(p.houseLoad.map(v => v.toFixed(3)));
        if (p.socArriving !== undefined) setSocArriving(String(p.socArriving));
        if (p.socPresent  !== undefined) setSocPresent(String(p.socPresent));
        if (p.socMin      !== undefined) setSocMin(String(p.socMin));
        setResults(null);
        setStatus('idle');
        setRestoreMsg({ ok: true, text: `Restored from: ${file.name}` });
      } catch (err) {
        setRestoreMsg({ ok: false, text: `Restore failed: ${err.message}` });
      }
    };
    reader.readAsText(file);
  }, []);

  // Download manual as plain text
  const handleDownloadManual = () => {
    const lines = [];
    lines.push('V2G ANALYSIS ENGINE \u2014 USER MANUAL');
    lines.push(`v${VERSION} \u00b7 Center for Community Energy`);
    lines.push('v2g.cc-energy.org');
    lines.push('');
    MANUAL.forEach(sec => {
      lines.push('\u2500'.repeat(70));
      lines.push(sec.heading);
      lines.push('');
      if (sec.body)    lines.push(sec.body);
      if (sec.bullets) sec.bullets.forEach(b => lines.push('  \u2022 ' + b));
      if (sec.body2)   lines.push(sec.body2);
      lines.push('');
    });
    lines.push('\u2500'.repeat(70));
    lines.push('Center for Community Energy \u00b7 v2g.cc-energy.org');
    const blob = new Blob([lines.join('\n')], { type: 'text/plain' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `v2g_analysis_engine_manual_v${VERSION}.txt`;
    a.click();
    URL.revokeObjectURL(a.href);
  };

  // Current UI state snapshot for summary CSV
  const uiState = () => ({
    circuitNum, circuitCapacity, households, loadIncrease,
    threshold, carsPerHH, evseDischargekW, dischargeEfficiency,
    batterySizekWh, maxBatteryWithdrawn, loadProfile, carsHomeProfile, baseLoad,
    dischargeWindowStart, dischargeWindowEnd, circuitMonth, houseLoad,
    socArriving, socPresent, socMin,
  });

  const statusColor = status === 'done' ? C.green : status === 'error' ? C.red : status === 'running' ? C.orange : C.faint;
  const statusText  = status === 'done' ? 'Done' : status === 'error' ? `Error: ${errorMsg}` : status === 'running' ? 'Running\u2026' : 'Idle \u2014 load a circuit CSV to begin';

  return (
    <div style={{ background: C.bg, minHeight: '100vh', color: C.text, fontFamily: "'DM Sans','DM Mono',sans-serif", padding: '24px 20px' }}>
      <link href="https://fonts.googleapis.com/css2?family=DM+Sans:wght@300;400;600;700&family=DM+Mono:wght@400;500&display=swap" rel="stylesheet"/>

      {/* Header */}
      <div style={{ maxWidth: 960, margin: '0 auto 22px' }}>
        <div style={{ display: 'flex', alignItems: 'baseline', gap: 10, marginBottom: 6 }}>
          {['CCE', 'V2G ANALYSIS ENGINE', `v${VERSION}`].map((t, i) => (
            <React.Fragment key={i}>
              {i > 0 && <div style={{ width: 1, height: 11, background: C.muted, opacity: 0.35 }}/>}
              <div style={{ fontSize: 11, fontFamily: "'DM Mono',monospace", color: i === 0 ? C.accent : C.muted, letterSpacing: '0.12em', fontWeight: i === 0 ? 600 : 400 }}>{t}</div>
            </React.Fragment>
          ))}
        </div>
        <h1 style={{ fontSize: 24, fontWeight: 700, color: C.text, marginBottom: 5, letterSpacing: '-0.02em' }}>V2G Analysis Engine</h1>
        <p style={{ fontSize: 12, color: C.muted, lineHeight: 1.6 }}>
          Calculates the minimum EV penetration required to shave peak load on a distribution circuit.
          Load a circuit CSV to run VPP, V2G, and V2H analysis automatically.
        </p>
        <div style={{ marginTop: 10 }}>
          <button
            onClick={() => setShowManual(true)}
            style={{
              background: 'transparent',
              border: `1px solid ${C.border}`,
              borderRadius: 6,
              color: C.muted,
              padding: '6px 14px',
              fontSize: 11,
              fontWeight: 600,
              fontFamily: "'DM Sans', sans-serif",
              cursor: 'pointer',
              letterSpacing: '0.04em',
            }}
          >? User Manual</button>
        </div>
      </div>

      <div style={{ maxWidth: 960, margin: '0 auto', display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 14 }}>

        {/* LEFT — Semi-permanent settings */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          <Card title="Semi-Permanent Settings">
            <Field label="Threshold"             value={threshold}           onChange={setThreshold}           note="fraction e.g. 0.90"/>
            <Field label="Cars per Household"    value={carsPerHH}           onChange={setCarsPerHH}/>
            <Field label="EVSE Discharge"        value={evseDischargekW}     onChange={setEvseDischargekW}     unit="kW"/>
            <Field label="Discharge Efficiency"  value={dischargeEfficiency} onChange={setDischargeEfficiency} note="e.g. 0.97"/>
            <Field label="Battery Size"          value={batterySizekWh}      onChange={setBatterySizekWh}      unit="kWh"/>
            <Field label="Max Battery Withdrawn" value={maxBatteryWithdrawn} onChange={setMaxBatteryWithdrawn} note="fraction e.g. 0.30"/>
            <Field label="V2G SOC on Arrival"   value={socArriving} onChange={setSocArriving} note="fraction e.g. 0.90"/>
            <Field label="V2G SOC at Win. Start" value={socPresent}  onChange={setSocPresent}  note="fraction e.g. 0.90"/>
            <Field label="V2G Min SOC"           value={socMin}      onChange={setSocMin}      note="floor e.g. 0.20"/>
            <Field label="Discharge Window Start" value={dischargeWindowStart} onChange={setDischargeWindowStart} note="hour 0–23 e.g. 16=4pm"/>
            <Field label="Discharge Window End"   value={dischargeWindowEnd}   onChange={setDischargeWindowEnd}   note="hour 1–24 excl. e.g. 24=midnight"/>
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

          <Card title="Household Load Profile">
            <div style={{ fontSize: 11, color: C.muted, marginBottom: 8, lineHeight: 1.5 }}>
              Average kWh/hr per household for the selected month.
              Used by the V2H model. Load a 24-row × 12-month CSV
              (Hour col A, months Jan–Dec in cols B–M).
            </div>
            <div style={{ display: 'flex', gap: 8, marginBottom: 8, alignItems: 'center' }}>
              <input type="file" accept=".csv" ref={houseLoadInputRef} style={{ display: 'none' }} onChange={handleHouseLoadFile}/>
              <Btn color="muted" onClick={() => houseLoadInputRef.current && houseLoadInputRef.current.click()}>
                📂 Load House Load CSV
              </Btn>
            </div>
            {houseLoadCSVMsg && (
              <div style={{ fontSize: 11, color: houseLoadCSVMsg.ok ? C.green : C.red, marginBottom: 8 }}>
                {houseLoadCSVMsg.text}
              </div>
            )}
            <HourlyTable values={houseLoad.length === 24 ? houseLoad : Array(24).fill('')} onChange={null} />
            <div style={{ fontSize: 10, color: C.faint, marginTop: 4 }}>kWh/hr — read-only, extracted from loaded table for selected month</div>
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
            <Field label="Circuit Month"    value={circuitMonth}    onChange={handleMonthChange}  note="1–12 (9=Sep, most challenging for SDG&amp;E)"/>
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
            const { vpp: o, v2g: g, v2h: u, params } = results;
            const balanced = Math.abs(o.grid_energy - o.batt_delivered) < 0.1;
            return (
              <Card title="Results">
                <div style={{ display: 'grid', gridTemplateColumns: 'auto 1fr 1fr 1fr', gap: 6, marginBottom: 12 }}>
                  {['', 'VPP', 'V2G', 'V2H'].map((h, i) => (
                    <div key={i} style={{ fontSize: 10, color: i === 0 ? C.faint : i === 1 ? C.green : i === 2 ? '#a855f7' : C.orange, fontFamily: "'DM Mono',monospace", letterSpacing: '0.08em', textTransform: 'uppercase', fontWeight: 600, paddingBottom: 4, borderBottom: `1px solid ${C.border}` }}>{h}</div>
                  ))}
                  {[
                    ['Penetration', `${(o.penetration*100).toFixed(3)}%`, `${(g.penetration*100).toFixed(3)}%${g.feasible ? '' : ' ⚠'}`, u ? `${(u.penetration*100).toFixed(3)}%${u.feasible ? '' : ' ⚠'}` : '—'],
                    ['Vehicles',    o.vehicles,  g.vehicles,  u ? u.vehicles : '—'],
                    ['Max Draw',    `${o.max_draw_kwh} kWh`, `${g.max_draw_kwh} kWh`, u ? `${u.max_draw_kwh} kWh` : '—'],
                    ['Max Draw %',  `${(o.max_draw_pct*100).toFixed(1)}%`, `${(g.max_draw_pct*100).toFixed(1)}%`, u ? `${(u.max_draw_pct*100).toFixed(1)}%` : '—'],
                    ['Grid Energy', `${o.grid_energy} kWh`, `${g.grid_energy} kWh`, u ? `${u.grid_energy} kWh` : '—'],
                    ['Batt Delivered', `${o.batt_delivered} kWh`, `${g.batt_delivered} kWh`, u ? `${u.batt_delivered} kWh` : '—'],
                  ].map(([label, ov, gv, uv]) => (
                    <React.Fragment key={label}>
                      <div style={{ fontSize: 11, color: C.muted, padding: '5px 0' }}>{label}</div>
                      <div style={{ fontSize: 12, color: C.green,   padding: '5px 0', fontFamily: "'DM Mono',monospace" }}>{ov}</div>
                      <div style={{ fontSize: 12, color: '#a855f7', padding: '5px 0', fontFamily: "'DM Mono',monospace" }}>{gv}</div>
                      <div style={{ fontSize: 12, color: C.orange,  padding: '5px 0', fontFamily: "'DM Mono',monospace" }}>{uv}</div>
                    </React.Fragment>
                  ))}
                </div>
                <div style={{ fontSize: 11, fontFamily: "'DM Mono',monospace", marginBottom: 12 }}>
                  <div style={{ color: balanced ? C.green : C.red }}>
                    {balanced ? '✓ VPP energy checksum balanced' : '⚠ VPP checksum mismatch — review history file'}
                  </div>
                  {!g.feasible && (
                    <div style={{ color: '#a855f7', marginTop: 4 }}>
                      ⚠ V2G: 100% penetration insufficient — partial result
                    </div>
                  )}
                  {u && !u.feasible && (
                    <div style={{ color: C.orange, marginTop: 4 }}>
                      ⚠ V2H: 100% penetration insufficient — partial result
                    </div>
                  )}
                </div>
                {/* Chart */}
                <div style={{ margin: '12px 0', borderRadius: 6, overflow: 'hidden', border: `1px solid ${C.border}` }}>
                  <canvas ref={canvasRef} width={660} height={360}
                    style={{ display: 'block', width: '100%', height: 'auto' }} />
                </div>
                <div style={{ marginBottom: 8 }}>
                  <Btn full color="muted" onClick={() => {
                    if (!results) return;
                    const SCALE = 2, LW = 660, LH = 360;
                    const off = document.createElement('canvas');
                    off.width = LW * SCALE; off.height = LH * SCALE;
                    const ctx2 = off.getContext('2d');
                    ctx2.scale(SCALE, SCALE);
                    drawCircuitChart(ctx2, LW, LH, results, results.params, 'light');
                    const a = document.createElement('a');
                    a.href = off.toDataURL('image/png');
                    a.download = `Circuit_${circuitNum}_chart.png`;
                    a.click();
                  }}>↓ Save Chart PNG</Btn>
                </div>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                  <Btn full color="orange" onClick={() => downloadCSV(buildSummaryCSV(uiState(), o, g, u), `Circuit_${circuitNum}_V2G_summary.csv`)}>
                    ↓ Summary CSV — Circuit {circuitNum}
                  </Btn>
                  <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 6 }}>
                    <Btn onClick={() => downloadCSV(buildOutputCSV(params, o, 'Optimized'),  `Circuit_${circuitNum}_OV.csv`)}>↓ Output — VPP</Btn>
                    <Btn onClick={() => downloadCSV(buildHistoryCSV(o, circuitNum, 'Optimized'), `Circuit_${circuitNum}_HistoryV.csv`)}>↓ History — VPP</Btn>
                    <Btn color="muted" style={{color:'#a855f7'}} onClick={() => downloadCSV(buildOutputCSV(params, g, 'Optimized'),  `Circuit_${circuitNum}_OG.csv`)}>↓ Output — V2G</Btn>
                    <Btn color="muted" style={{color:'#a855f7'}} onClick={() => downloadCSV(buildHistoryCSV(g, circuitNum, 'V2G'), `Circuit_${circuitNum}_HistoryG.csv`)}>↓ History — V2G</Btn>
                  </div>
                  {u && (
                    <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 6, marginTop: 6 }}>
                      <Btn color="orange" onClick={() => downloadCSV(buildOutputCSVUncoord({...params, house_load: houseLoad.map(v => parseFloat(v) || 0), discharge_window_start: parseInt(dischargeWindowStart) || 16, discharge_window_end: parseInt(dischargeWindowEnd) || 24}, u), `Circuit_${circuitNum}_OH.csv`)}>↓ Output — V2H</Btn>
                      <Btn color="orange" onClick={() => downloadCSV(buildHistoryCSV(u, circuitNum, 'V2H'), `Circuit_${circuitNum}_HistoryH.csv`)}>↓ History — V2H</Btn>
                    </div>
                  )}
                </div>
              </Card>
            );
          })()}
        </div>
      </div>

      {/* Footer */}
      <div style={{ maxWidth: 920, margin: '20px auto 0', fontSize: 10, color: C.faint, display: 'flex', justifyContent: 'space-between', paddingTop: 12, borderTop: `1px solid ${C.border}` }}>
        <span>Center for Community Energy</span>
        <span style={{ fontFamily: "'DM Mono',monospace" }}>V2G Analysis Engine v{VERSION}</span>
      </div>

      {/* User Manual Modal */}
      {showManual && (
        <div style={{
          position: 'fixed', inset: 0,
          background: 'rgba(10,15,26,0.93)',
          zIndex: 1000, overflowY: 'auto',
          padding: '40px 20px',
        }}>
          <div style={{
            maxWidth: 700, margin: '0 auto',
            background: C.panel, border: `1px solid ${C.border}`,
            borderRadius: 12, padding: '28px 32px',
          }}>
            {/* Modal header */}
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 24 }}>
              <div>
                <div style={{ fontSize: 11, color: C.accent, fontFamily: "'DM Mono', monospace", letterSpacing: '0.12em', marginBottom: 6 }}>USER MANUAL</div>
                <div style={{ fontSize: 20, fontWeight: 700, color: C.text, letterSpacing: '-0.02em' }}>V2G Analysis Engine</div>
                <div style={{ fontSize: 11, color: C.faint, fontFamily: "'DM Mono', monospace", marginTop: 4 }}>v{VERSION} · Center for Community Energy</div>
              </div>
              <div style={{ display: 'flex', gap: 10, flexShrink: 0, marginLeft: 20 }}>
                <button onClick={handleDownloadManual} style={{ background: `linear-gradient(135deg,#00508a,${C.accent})`, border: 'none', borderRadius: 6, color: '#001220', padding: '7px 14px', fontSize: 11, fontWeight: 700, fontFamily: "'DM Sans',sans-serif", letterSpacing: '0.05em', cursor: 'pointer', textTransform: 'uppercase' }}>↓ Download</button>
                <button onClick={() => setShowManual(false)} style={{ background: 'transparent', border: `1px solid ${C.border}`, borderRadius: 6, color: C.muted, padding: '7px 14px', fontSize: 11, fontWeight: 600, fontFamily: "'DM Sans',sans-serif", cursor: 'pointer' }}>✕ Close</button>
              </div>
            </div>

            <div style={{ borderTop: `1px solid ${C.border}`, paddingTop: 20 }}>
              {MANUAL.map((sec, i) => (
                <div key={i} style={{ marginBottom: 24 }}>
                  <div style={{ fontSize: 11, fontFamily: "'DM Mono',monospace", color: C.accent, letterSpacing: '0.1em', textTransform: 'uppercase', marginBottom: 8, paddingBottom: 5, borderBottom: `1px solid ${C.border}` }}>{sec.heading}</div>
                  {sec.body    && <p style={{ fontSize: 13, color: C.muted, lineHeight: 1.7, margin: '0 0 8px' }}>{sec.body}</p>}
                  {sec.bullets && <ul style={{ paddingLeft: 18, margin: '0 0 8px' }}>{sec.bullets.map((b, j) => <li key={j} style={{ fontSize: 13, color: C.muted, lineHeight: 1.7, marginBottom: 4 }}>{b}</li>)}</ul>}
                  {sec.body2   && <p style={{ fontSize: 13, color: C.muted, lineHeight: 1.7, margin: '8px 0 0' }}>{sec.body2}</p>}
                </div>
              ))}
            </div>

            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: 8, paddingTop: 16, borderTop: `1px solid ${C.border}` }}>
              <div style={{ fontSize: 10, color: C.faint, fontFamily: "'DM Mono',monospace" }}>v2g.cc-energy.org · Center for Community Energy</div>
              <button onClick={() => setShowManual(false)} style={{ background: 'transparent', border: `1px solid ${C.border}`, borderRadius: 6, color: C.muted, padding: '7px 20px', fontSize: 11, fontWeight: 600, fontFamily: "'DM Sans',sans-serif", cursor: 'pointer' }}>✕ Close</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

const reactRoot = ReactDOM.createRoot(document.getElementById('root'));
reactRoot.render(<App />);
