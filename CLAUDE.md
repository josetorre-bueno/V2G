# V2G Analysis Engine — Project CLAUDE.md
# ~/Downloads/v2g_study/CLAUDE.md
#
# Universal rules (versioning, deployment, coding standards) live in the
# global config at ~/.claude/CLAUDE.md and apply automatically.
# This file covers V2G project-specific content only.

## Project Overview

`rva.py` is a Python simulation that replicates the Excel Solver calculations in `V2GModel.xlsx`. See `rva_documentation.md` for full program documentation.

---

## Environment & Dependencies

Python 3 with the following packages:

```
pandas
numpy
scipy
```

Install with:

```bash
pip3 install pandas numpy scipy
```

---

## Running the UI

```bash
python3 rva_server.py
```

Open `http://localhost:8080` in a browser. Load a `Circuit_<N>_I.csv` to trigger analysis automatically.

## Running from the Command Line

```bash
python3 rva.py
```

Auto-discovers all `Circuit_*_I.csv` files and runs both modes. Uses `_CLI_DEFAULTS` in `rva.py` for semi-permanent settings — edit that dict to change defaults for CLI runs.

---

## File Naming Conventions

| Pattern | Description |
|---|---|
| `Circuit_<N>_I.csv` | Circuit input — simplified format (see below) |
| `Circuit_<N>_OS.csv` | Output — Standard mode results |
| `Circuit_<N>_OO.csv` | Output — Optimized mode results |
| `Circuit_<N>_OU.csv` | Output — Uncoordinated mode results |
| `Circuit_<N>_HistoryS.csv` | Cohort history — Standard mode |
| `Circuit_<N>_HistoryO.csv` | Cohort history — Optimized mode |
| `Circuit_<N>_HistoryU.csv` | Cohort history — Uncoordinated mode |
| `Circuit_<N>_V2G_summary.csv` | Summary + restore file (UI output) |

## Circuit Input CSV Format (simplified)

```
V2G Circuit Input
Circuit,163
Circuit Capacity,11517
Household Meters,1072
Load Increase,0%
Hour,Base Load (kW)
1,7129
...
24,8317
```

The old multi-column spreadsheet-derived format is retired. Semi-permanent parameters (threshold, profiles, battery specs) are stored in the summary CSV and loaded via the Restore function in the UI.

---

## Versioning

Follow the global config versioning rules. V2G-specific notes:

- **Every change bumps the patch** (rightmost number): `v1.7.0 → v1.7.1`
- **Minor bumps on reorganisation** (middle number): `v1.7.x → v1.8.0`
- **Major requires Jose's approval**
- **Never edit a deployed JSX file** — always create a new versioned file

Version number must appear identically in all of the following locations:

| Location | Example |
|---|---|
| JSX filename | `rva_app_v1_7_1.jsx` (underscores, not dots) |
| `const VERSION` inside the JSX | `const VERSION = "1.7.1";` |
| Top comment in the JSX | `// Version: 1.7.1` |
| `index.html` `<title>` | `V2G Analysis Engine v1.7.1 — CCE` |
| `index.html` version comment | `<!-- Version: v1.7.1 -->` |
| `index.html` module file comment | `<!-- Module file: rva_app_v1_7_1.jsx -->` |
| `index.html` `<script src>` | `rva_app_v1_7_1.jsx?v=1.7.1` |
| CLAUDE.md change log | new row with date and description |

**Note:** V2G filenames use underscores as separators (`rva_app_v1_7_1.jsx`) rather than dots. This is a project convention — dots in filenames cause issues with some server configurations.

---

## Code Style

- All logic for a single circuit run is contained within the `rva(circuit_num, mode)` function
- Helper `clean_val()` handles all CSV value parsing (commas, %, blanks)
- Parameters are read by label match (case-insensitive) — do not rely on row position
- Output columns are written back into the original sheet DataFrame before saving
- Use `latin1` encoding for all CSV reads and writes to match source Excel exports

---

## Validation

- Ground truth is `V2GModel.xlsx` (original Excel model with Solver)
- After any change, verify the Optimized output energy checksum: `GridNeeded` must equal `BattDelivered` in the History file header row
- Archived parameter set for circuit 163: `Save 163 old param`

---

## Change Log

| Date | Description |
|---|---|
| 2026-04-07 | Fixed indexing bug in Optimized dispatch loop: `cohort_size[idx]` → `cohort_size[a]`. Bug caused Managed kW column to show no peak shaving and energy delivered checksum to be understated. Penetration % and vehicle count were unaffected. |
| 2026-04-08 | Added browser UI (`rva_server.py`, `rva.html`, `rva_app_v1_0_0.jsx`). Refactored `rva()` to accept a params dict instead of reading a CSV file. Retired old multi-column input format; replaced with simplified `Circuit_<N>_I.csv`. Added summary CSV with RESTORE KEYS for persistent semi-permanent settings. |
| 2026-04-08 | Investigated Standard mode discrepancy vs V2GModel.xlsx (code: 7.147%, Excel: 6.933%). Root cause: Excel Solver uses grid-side kWh per car as the energy constraint, omitting discharge efficiency. Code correctly uses battery-side kWh (grid_need / (avail × EFF)), because efficiency losses mean each car must give up more energy from its battery than reaches the grid — genuinely requiring more cars. The Excel formulation silently allows each car to exceed the 30% battery draw limit by a factor of 1/EFF. Code result (7.147%) retained as physically correct. V2GModel.xlsx noted as having a minor conservative undercount in the Standard mode energy constraint. |
| 2026-04-08 | Added Uncoordinated mode (`rva_app_v1_1_0.jsx`). Each V2G car independently zeroes its own house meter during a settable discharge window (default 4 pm–midnight), limited by EVSE capacity and the 30% battery draw rule. Cars starting the window at home and cars arriving during it all assumed at 90% SOC. Requires a Green Button CSV (SDG&E format) uploaded by the user; app parses average weekday hourly load for the selected circuit month. Results appear as a third column alongside Standard and Optimized. Outputs: `Circuit_<N>_OU.csv` and `Circuit_<N>_HistoryU.csv`. New RESTORE KEYS: `dischargeWindowStart`, `dischargeWindowEnd`, `circuitMonth`, `houseLoad`. |
| 2026-04-08 | Added in-app User Manual with modal viewer and plain-text download (`rva_app_v1_2_0.jsx`). Rebranded from CCE/Makello to CCE (Center for Community Energy) throughout — tool is not part of the Makello suite. |
| 2026-04-09 | Added in-app canvas chart (`rva_app_v1_3_0.jsx`). ScatterChart matches Excel Graph template format: X = hours 1–24, series = Base Load (grey), Projected (red), Managed Standard (blue), Managed Optimized (green), Managed Uncoordinated (orange, when available), Threshold (dashed). Dark CCE theme. Includes ↓ Save Chart PNG download (2× resolution, white background). Added GRAPH DATA table to Summary CSV: 24-row × 7–8-column table (Hour, Circuit Capacity, Threshold, Base Load, Projected, Managed Standard, Managed Optimized, Managed Uncoordinated) ready to select and chart in Excel. |
| 2026-04-09 | Removed Standard mode from UI (`rva_app_v1_4_0.jsx`). `handleRun` now runs Optimized and Uncoordinated only. Results grid reduced from 4 columns (Standard, Optimized, Uncoordinated) to 3 (label, Optimized, Uncoordinated). Standard download buttons (Output/History) removed. Chart legend moved from inside-plot overlay to right-side panel (mr increased from 20 to 180) and no longer includes Standard series. `buildSummaryCSV` signature and RESULTS/GRAPH DATA sections updated to omit Standard. User Manual updated throughout to reflect two-model UI. |
| 2026-04-09 | Lightened header separator bars and subtitle text (`rva_app_v1_5_0.jsx`). Divider lines and "V2G ANALYSIS ENGINE" / version text changed from `C.faint` (#3a5070) to `C.muted` (#7a9cbf) with 0.35 opacity on the bars — more legible against the dark background. |
| 2026-04-09 | Replaced Green Button CSV input with a direct 24-row × 12-month household load table (`rva_app_v1_6_0.jsx`). New `parseHouseLoadCSV(text, month)` reads a CSV with Hour in col A and months Jan–Dec in cols B–M (numeric or 3-letter headers accepted). Circuit Month default changed from 7 to 9 (September — most demanding month for SDG&E circuits). Changing Circuit Month re-extracts from the already-loaded table without re-upload. All Green Button references removed from UI and User Manual. |
| 2026-04-09 | Added V2G uncoordinated mode and renamed all three modes (`rva_app_v1_7_0.jsx`). New `runRVAV2G`: each car computes flat discharge rate = min((SOC_init − SOC_min)×batt / hours_remaining, EVSE_cap) on arrival, sends power directly to grid. New parameters: `socArriving`, `socPresent`, `socMin`. Renamed Optimized→VPP, Uncoordinated→V2H in all UI labels, file names (OV/OG/OH), chart legend, results grid, and User Manual. Results grid is now 4 columns: VPP (green) / V2G (purple #a855f7) / V2H (orange). V2G always runs; V2H still requires house load CSV. |
<<<<<<< HEAD
| 2026-04-14 | Documented all load forecast data sources in `rva_documentation.md` §8 (three subsections: NHTS 2022 cars_home_pct derivation, CEC 2025 IEPR non-EV growth forecast, SDG&E Dynamic Load Profiles residential table). Added [D3] to `memory/projects/bibliography.md`. Added house_load source paragraph to `V2G_Methods_Section_DRAFT.docx`. |
| 2026-04-14 | Created `nhts_2022_cars_home_pct.csv` — 24-row profile derived from `tripv2pub.csv` (2022 NHTS); weekday filter (TDWKND=2), WTTRDFIN-weighted; columns: hour, work_home_status, home_work_status, cars_home_pct. 4 pm–midnight average: 86.0%. |
| 2026-04-14 | Created `cec_forecast_lookup.csv` — 7,488 rows (year 2025–2050 × month 1–12 × hour 1–24) of mean_non_ev_load (MW). Non-EV formula: MANAGED_NET_LOAD − LIGHT_EV − MEDIUM_HEAVY_EV − AATE_LDV (cols U, H, I, S of CEC Data sheet). Precomputed from TN268118...xlsx (227,760 rows) for runtime efficiency. |
| 2026-04-14 | Created `batch_run.py` — batch VPP analysis across all 32 study circuits for configurable target years. Reads `batch_global_params.csv` (Your_value preferred over Default_value; strips Excel apostrophe prefix), `SDGnE_Circuit_Upgrade_Master_updated.xlsx` Sheet1 (rows 1–33; col D × 1000 = kW capacity; col F = peak month; col G = loadfile), LOADPROFILE CSVs, NHTS profile, and CEC lookup. Calls `rva(params, 'Optimized')` per circuit × year. Outputs `batch_output/batch_results.csv`. Circuits in rows beyond 33 (278, 320, 1266) are microgrids — excluded. |
| 2026-04-14 | Clarified capacity units in master xlsx: col C = raw imputed decimal (MW), col D = rounded integer (MW). Column header "rounded imputed KW" is mislabeled — values are in MW. All col D values × 1000 for kW. Circuit 139 col D=600 → 600 MW → 600,000 kW (correctly shows 0% penetration as base load is ~6,944 kW). |
| 2026-04-14 | Ran first complete batch: `batch_output/batch_results.csv` — 96 rows (32 circuits × 3 years: 2030, 2040, 2050), VPP penetration only. Three circuits (277, 326, 730) show base load >> capacity — capacity values may reflect incremental DDOR deficiency rather than full circuit rating; flagged for follow-up. |
| 2026-04-23 | Added Status IN/OUT column to batch_circuit_review.csv (OUT: 139, 277, 326, 730). Added Peak_Load_kW column (worst-case High Load hour across all months from LOADPROFILE CSVs). Added DDOR_ID, In_Service_Date, Service_Type columns from Appendix 5 of master xlsx. |
| 2026-04-23 | Ported V2G and V2H modes to rva.py (v1.8.0). Expanded batch_run.py to run all three modes (VPP/V2G/V2H), load house_load table, filter circuits by Status, and output 15-column batch_results.csv. Ran full batch: 84 rows (28 IN circuits × 3 years). |
| 2026-04-23 | Characterised V2G/V2H infeasibility: pre-window overload is a perfect predictor. Ran discharge window sensitivity analysis (noon/2pm/3pm/4pm) for 9 infeasible circuits. Found: 3 circuits rescued at 3pm (160, 353, 1094), 4 at noon (adds 41, 137), 4 permanently infeasible (92, 832, 1225, 282). |
| 2026-04-23 | Geographic analysis of infeasible circuits: inland heat substations (Jamacha, Lilac, San Marcos, Telegraph Canyon, North City West) drive broad afternoon peaks. Kettner exception explained by commercial corridor load. Same-substation pairs (Chollas West 160 vs 163; Telegraph Canyon 1225 vs 940) show circuit-level customer mix matters more than location. |
| 2026-04-23 | Added section 6.4 (Discharge Window Parameters and V2G Feasibility) to V2G_Methods_Section_DRAFT.docx (313→318 paragraphs). Created memory/projects/discussion_notes.md capturing all geographic, window-sensitivity, V2H penetration, and data-limitation findings for the discussion section. |
| 2026-04-23 | Matched GRC cost data (DUPR_with_GRC_Cost_Baseline.xlsx) to all 28 IN circuits by DUPR ID. Added cost_low_k/mid/high columns to batch_results.csv. Created batch_output/circuit_summary.csv (28 circuits × 32 columns: all modes × years + costs + deferral values). Total mid-point upgrade cost across study circuits: $251M; 10-yr deferral value at 5%: $97M. |
| 2026-04-23 | Battery size sensitivity: ran 420-run sweep (28 circuits × 5 battery sizes × 3 years). VPP/V2G scale inversely with battery size; V2H is completely flat — binding constraint is household consumption rate (~7.1 kWh/window), not battery capacity. Results in batch_output/battery_sensitivity.csv. |
| 2026-04-23 | EVSE power sensitivity: ran 420-run sweep (5 EVSE levels: 3.6/7.5/11.5/15/19.2 kW). Hard saturation point at ~7.15 kW — above this, increasing EVSE yields no benefit. Below 7.5 kW, effectiveness halves. At 3.6 kW, VPP and V2G converge (cohort optimisation offers no advantage). V2H flat throughout. Saturation threshold formula: battery_kWh × draw_lim / window_hours. AC V2G regulatory recommendation: minimum power floor of 7.5 kW (fixed) or battery_kWh × 0.11 kW (indexed). Results in batch_output/evse_sensitivity.csv. |
| 2026-04-24 | Journal selection: IEEE Transactions on Smart Grid (Application Paper type). ECCE is PELS/IAS not PES — no special extension pathway, submit as new paper with ECCE2024 cited as prior work. 10-page initial limit; revised papers may exceed. |
| 2026-04-24 | Confirmed all model parameter citations: evse_dc_lim=12 kW and eff=0.97 from Wallbox Quasar 2 NA Datasheet V1.4 (Datasheet_QX2NA_EN_0225.pdf, filed in New Docs/); batt=88 kWh and CARS_HH=2.3 from thesis [C2] §5.2.8 and §5.2.10; draw_lim=0.30 as CCE design choice [C2] §5.4.2; thresh_pct=0.90 confirmed by SDG&E EIS Part 2 [J14]. |
| 2026-04-24 | Read SDG&E Final Electrification Impact Study Part 2 (R.21-06-017) summary: Base Case $3,202M upgrades by 2040; Demand Flexibility Scenario $2,505M (saves $697M). New circuit unit cost from SDG&E 2025 Rule 21 Unit Cost Guide: $11.0M (2030), $14.8M (2040). Added as [J14] in bibliography. |
| 2026-04-24 | Developed paper arguments: VPP uses forward knowledge (T_opt + cohort weights require full peak shape); V2G and V2H do not. Spatial transmission concept formalised (bidi EV = temporal storage + spatial energy transport via commute). CEC "planning for failure" confirmed from actual LIGHT_EV hourly data — charging projected to peak at hours 23-24, not during solar window. |
| 2026-04-24 | Figures list finalised: F1 study area map, F2 NHTS profile (with 2017 comparison), F3 circuit 163 load profiles, F4 VPP main results, F5 V2G feasibility/window sensitivity, F6 VPP vs V2G ratio, F7 battery sensitivity, F8 EVSE saturation. Algorithm flow diagram dropped (expands text without adding information). |
| 2026-04-24 | Paper drafting begun. Created V2G_Section1_Introduction.docx (8 paragraphs, all citations filled) and V2G_Section2_DataAndStudyArea.docx (7 subsections A-G, Tables I and II embedded). Section 2 corrected: added ≥1000 meters inclusion criterion; corrected service type to Thermal/Thermal+Backtie; updated DDOR description to cover all deficiency types. |

---

# Working Memory — V2G Paper Project

## Me
Jose Torre-Bueno, Executive Director of CCE (Center for Community Energy), San Diego nonprofit sponsoring this work. Email: jose.torrebueno@cc-energy.org

## People
| Who | Role | Status |
|-----|------|--------|
| **Rafa** | Rafael Aranzabal Obieta, UPV/EHU — authored the thesis (TFM_v8.pdf), co-authored the 2025 paper. Not on the new paper. |
| **Sridhar** | Sridhar Seshagiri, SDSU — co-authored the 2025 paper. Not on the new paper. |
| Students | TBD — some students may be co-authors on the new paper |

## Shorthand
| Term | Meaning |
|------|---------|
| the thesis | TFM_v8.pdf — Rafa's master's thesis, first description of Standard algorithm |
| the 2025 paper | "Making EVs and the grid work together: a San Diego based study" — IEEE ECCE, Phoenix AZ, Oct 2024. ISBN 979-8-3503-5427-0. Authors: Obieta, Torre-Bueno, Seshagiri |
| the new paper | The paper currently being written introducing VPP, V2G, V2H algorithms |
| CCE | Center for Community Energy — nonprofit, Jose is Executive Director, sponsoring this work |
| Standard | Original algorithm from thesis/2025 paper. Single-block fleet dispatch. Not called "Standard" in those papers. |
| VPP | Virtual Power Plant — new improved cohort-based algorithm (replaces Standard) |
| V2G | Vehicle to Grid — new direct grid injection algorithm (uncoordinated, flat rate per cohort) |
| V2H | Vehicle to Home — new household load offset algorithm |
| circuit | Distribution circuit (use consistently, not "feeder") |
| the methods draft | V2G_Methods_Section_DRAFT.docx — in v2g_study folder |

## Projects
| Name | What |
|------|------|
| **rva.py / rva_app** | Python + browser tool implementing all algorithms. Current version: 1.7.1. |
| **batch_run.py** | Batch VPP analysis across all study circuits. Reads master xlsx + LOADPROFILE CSVs; outputs `batch_output/batch_results.csv`. Run: `python3 batch_run.py [--years 2030,2040,2050]`. |
| **V2G paper** | New technical paper introducing VPP, V2G, V2H algorithms. Target journal TBD. |
| **circuit 163** | Primary case study circuit — 1,072 households, 11,517 kW capacity, in v2g_study folder |
| **32 circuits** | 32 SDG&E circuits in Sheet1 rows 1–33 of master xlsx (rows beyond 33 are microgrids, excluded). VPP batch results complete for 2030/2040/2050. V2G and V2H modes not yet ported to Python. |

## Paper Status
| Section | Status |
|---------|--------|
| Methods | DRAFT exists (V2G_Methods_Section_DRAFT.docx in Current) |
| Introduction / Related Work | Not started — framework in brainstorming doc |
| Results | VPP results complete for 32 circuits × 3 years (batch_output/batch_results.csv). V2G and V2H modes need to be ported from JSX to Python before full 3-mode results table is available. Three circuits (277, 326, 730) have suspicious capacities — verify before including in paper. |
| Discussion | Not started |
| Policy / Cybersecurity / Cost | Framework captured in brainstorming doc |
| Bibliography | Working draft, 17 refs ([D1]–[D3] confirmed; several flagged incomplete — see memory/projects/bibliography.md) |
| Target journal | TBD — IEEE Trans. Smart Grid or Applied Energy top candidates |

## Key Paper Arguments (all detailed in memory/projects/v2g_paper.md)
- Three-model framework: Coordinated VPP / Decentralized TOU-responsive V2G / V2H-only
- September is the binding peak month across all SDG&E circuits examined — no exceptions
- Circuit capacity recovered from DDOR deficiency ratios — validated, exact
- Solar and peak demand windows don't overlap — simplifies model
- "Free to utility" regulatory asymmetry argument
- Cybersecurity: decentralized model eliminates attack surface ("the most secure message is the one you do not send")
- Cost transparency gap: CPUC approved withholding of upgrade costs from DIDF filings
- Battery companion paper in preparation (~300 sources; V2G profile is ~0.08C, benign)

## Folders
| Path | Contents |
|------|----------|
| v2g_study | Code, data, circuit files — primary workspace. Also: TASKS.md, memory/, dashboard.html, nhts_2022_cars_home_pct.csv, cec_forecast_lookup.csv, batch_run.py |
| v2g_study/batch_output | Batch run outputs: batch_results.csv (VPP × 32 circuits × 3 years) and individual circuit files |
| Current | Earlier papers (thesis, 2025 paper), SDG&E load data, bibliography, brainstorming doc, methods draft |
| Downloads/SDG&E_CIRCUIT_LOADPROFILES | LOADPROFILE CSVs for each circuit, master xlsx (SDGnE_Circuit_Upgrade_Master_updated.xlsx), batch_global_params.csv, batch_circuit_review.csv |
=======
>>>>>>> origin/main
