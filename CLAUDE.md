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
| 2026-04-09 | Added in-app canvas chart (`rva_app_v1_3_0.jsx`). ScatterChart matches Excel Graph template format: X = hours 1–24, series = Base Load (grey), Projected (red), Managed Standard (blue), Managed Optimized (green), Managed Uncoordinated (orange, when available), Threshold (dashed). Dark CCE theme. Includes ↓ Save Chart PNG download. |
