# V2G Analysis Engine — Programming Standards

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

Every change to the UI — no matter how small — must increment **at least the minor version number** (`v1.X.0`) in **all** of the following locations simultaneously:

| Location | Example |
|---|---|
| JSX filename | `rva_app_v1_4_0.jsx` |
| `const VERSION` inside the JSX | `const VERSION = "1.4.0";` |
| Top comment in the JSX | `// Version: 1.4.0` |
| `index.html` `<title>` | `V2G Analysis Engine v1.4.0 — CCE` |
| `index.html` version comment | `<!-- Version: v1.4.0 -->` |
| `index.html` module file comment | `<!-- Module file: rva_app_v1_4_0.jsx -->` |
| `index.html` `<script src>` | `rva_app_v1_4_0.jsx?v=1.4.0` |
| CLAUDE.md change log | new row with date and description |

**Never edit an existing versioned JSX file after it has been deployed.** Create a new file with the incremented version number instead. This ensures that the filename, the displayed version, and the loaded script are always in sync, and that the browser cache-busting query string (`?v=X.X.X`) forces a reload.

Use **patch version** (`v1.3.X`) only for hotfixes to a version that has not yet been deployed. Once a version is live on GitHub Pages, always increment the minor version.

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
