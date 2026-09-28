# Bambu Lab printer configs (mirrored from BambuStudio)

The full JSON catalog from BambuStudio's `resources/printers/`: one file per
printer model, plus `filaments_blacklist.json`. All fields are mirrored, not
only `compatible_machine`. These files are the data-driven source of truth for
per-model device capabilities and G-code model compatibility.

- **Source:** BambuStudio `resources/printers/` @ tag **`v02.08.04.57`**
  (commit `f977235e6`, checked 2026-09-27; `origin/master` has the same tree).
- **Consumed by:** `backend/app/utils/printer_configs.py` (loader and capability
  resolvers) and `backend/app/utils/model_compatibility.py`.
- **Local BS checkout** (not in this repo): `D:/Development/bamdude/references/BambuStudio/`.

## What's inside each file

Each model JSON is keyed by **firmware version**; `"00.00.00.00"` is the base /
default block. The complete model description includes its display name,
internal ID, serial prefixes, subseries, supported modes, images, and
`compatible_machine` when present. Its `print` sub-object carries capability
flags, including:

| Field | Used for |
|-------|----------|
| `support_lidar_calibration` + `support_ai_monitoring` | Micro-lidar device calibration (X1 only) |
| `support_bed_leveling` (0/1/2) | Auto bed-leveling; `2` = off/auto/on tri-state |
| `support_motor_noise_cali` | Motor-noise cancellation |
| `support_nozzle_offset_calibration` | Nozzle-offset calibration (dual-nozzle) |
| `support_high_tempbed_calibration` | High-temp bed leveling |
| `support_clump_position_calibration` | Nozzle-clumping detection |
| `support_auto_flow_calibration`, `support_chamber*`, `ipcam`, … | (available for future data-driven gating) |

The files are named by **internal code** (`N6.json` = X2D). The loader resolves a
model — display name (`X2D`), long form (`Bambu Lab X2D`), or code (`N6`) — to a
file using each JSON's own `display_name` / `model_id`, so it is independent of
`PRINTER_MODEL_ID_MAP`.

### Code ↔ model (from the JSONs' own `display_name`)

`BL-P001`=X1C · `BL-P002`=X1 · `C11`=**P1P** · `C12`=**P1S** · `C13`=X1E ·
`N1`=A1 mini · `N2S`=A1 · `N6`=X2D · `N7`=P2S · `N8`=N8 · `N9`=A2L · `O1C`/`O1C2`=H2C ·
`O1D`=H2D · `O1E`=H2D Pro · `O1S`=H2S.

> `PRINTER_MODEL_ID_MAP` in `printer_models.py` was corrected to match these
> JSONs (`C11`=P1P, `C12`=P1S; `BL-P001`=X1C, `BL-P002`=X1 added). This loader
> still keys off each JSON's own `display_name`/`model_id`, so it stays
> independent of that map regardless.

`N8` first appears in the mirrored `v02.08.04.57` catalog. Its name and code
are recognized; hardware behavior is not inferred from its sparse config.

## Re-sync protocol (when BS ships new firmware/features)

**Which tag to mirror:** whichever is newest at the moment you check — public
release or beta. BS tags both; review any beta-only config change in the audit
note before mirroring it, since a flag enabled in a beta can still be reverted.

1. Fetch tags in the reference repo, then check the newest tag **and** whether
   `origin/master` is ahead of it. The reference working tree may still be on
   an older detached tag; do not copy from that working tree without checking.
2. List `resources/printers/*.json` at the chosen ref with `git ls-tree`.
   Copy **every** model JSON and `filaments_blacklist.json` from that ref's Git
   objects (`git show <ref>:resources/printers/<name>`), including newly added
   files. Identify removed files rather than silently keeping stale models.
3. Compare the parsed JSON of **every** mirrored file with the chosen ref, and
   review the full field-level diff against the previous mirror: names, IDs,
   serial prefixes, firmware overrides, capabilities, compatibility, and
   blacklist rules. New models need identity mapping in backend and frontend;
   do not guess unadvertised hardware capabilities.
4. Run the loader and model-identity tests, update the BS audit note, then bump
   the source tag/commit above. Preserve any intentional newline normalization.

> ⚠️ **A byte diff can show all model files as changed.** Our
> pre-commit `end-of-file-fixer` appends a trailing newline that BS's copies do
> not have — one byte per file, no content difference. On 2026-09-27, all 16
> model JSONs plus the blacklist parsed identically to `v02.08.04.57`. Run this
> Python snippet from the BamDude repo root to verify a mirror:
>
> ```python
> import json, subprocess
> from pathlib import Path
> ref = 'D:/Development/bamdude/references/BambuStudio'
> tag = 'v02.08.04.57'
> local = Path('backend/app/data/printers')
> paths = subprocess.check_output(['git', '-C', ref, 'ls-tree', '-r', '--name-only', tag, 'resources/printers'], text=True).splitlines()
> names = {Path(p).name for p in paths if p.endswith('.json')}
> assert names == {p.name for p in local.glob('*.json')}
> for path in paths:
>     if not path.endswith('.json'):
>         continue
>     upstream = json.loads(subprocess.check_output(['git', '-C', ref, 'show', f'{tag}:{path}']))
>     assert json.loads((local / Path(path).name).read_text(encoding='utf-8')) == upstream, path
> ```

## License

These are BambuStudio files (AGPL-3.0), with possible trailing-newline
normalization. We mirror them as factual per-model configuration for
interoperability; see the project's
`CONTRIBUTING` / attribution notes.
