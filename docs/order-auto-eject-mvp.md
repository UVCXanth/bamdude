# Order auto-eject MVP

The order's **Auto-eject / Автоскидання** checkbox applies to newly created
queue and auto-queue jobs. Existing jobs keep their saved value. Copies,
repeats and queue rebalancing preserve that value. Printer-wide settings are
not changed; the feature is not restricted to a printer model.

## Operator setup

Enabling the order setting opens the existing confirmation dialog. Read the
requirements and explicitly acknowledge the prepared files, installed hardware
and camera calibration before saving. Disabling the setting remains immediate.
The confirmation describes the operator's choice; it does not validate a preset
inside the file or grant model-wide admission.

### Reference profile: A1 mini Tilt Kit

The operator-supplied **A1 mini Tilt Kit End G-code**, attributed to **Infinity
Flow 3D Printing** and dated **2025-10-08**, is the reference for this trial.
Obtain the matching kit, slicer profile and G-code from the
[author's source page](https://infinityflow3d.com/pages/free-3d-printer-auto-clearing-cad-and-g-code).
The date identifies the supplied template, not a claim that it is the latest
download on that page. Use the preset for the installed tilt hardware, not the
stock A1 mini printer preset.

- Its ejection branch runs only when `max_layer_z > 5.5` mm. Shorter jobs skip
  ejection; do not use this template unchanged for those auto-eject jobs.
- After that branch, the commanded finish position is `X5 Y185 Z6`: the last
  sweep is at `X5`, the last bed move is `Y185`, and `Z1` is followed by a
  relative `Z5` lift. The shorter-job branch has a different, variable Z pose.
- Match camera references and ROI to the actual post-ejection pose. The ROI
  must cover the print area and auxiliary parts. Nothing outside the camera
  image or ROI is observable; a clear result only describes the checked area.
- Do not add blind homing before the photo. Successful G-code completion does
  not itself prove ejection; the fresh photo still decides whether to proceed.
- P1S and other printers need their own prepared hardware and finish sequence.
  Never copy the A1 mini motion coordinates to another printer model.

The existing detector compares against the best matching reference. When
changing pose or camera geometry, back up and replace references from the old
setup, rather than retaining unrelated references as alternative empty states.

### Queue and camera setup

1. Select a prepared G-code file whose successful completion includes the
   physical ejection. BamDude does not inspect or modify the ejection sequence.
2. Calibrate the existing empty-plate detector for the configured camera and
   the plate's expected position after completion. Use the existing ROI and
   reference-image controls. Keep lighting and the camera position consistent.
3. Enable auto-eject on the order before creating its jobs. Verify the mode
   badge on each queued job. This setting is incompatible with Swap Mode.
4. A fresh photo is required immediately before dispatch. Occupied plate,
   unavailable camera, missing calibration or changed printer context leaves
   the queued job waiting. Correct the cause using the existing controls.
5. After a successful auto-eject run, the next dispatch may answer that run's
   plate-clear gate through the same photo check. A preceding ordinary,
   failed, cancelled or uncertain run still requires the existing manual
   answer. Turning on the next job's flag cannot bypass that gate.

Starts from the printer screen or another slicer remain ordinary prints, with
the existing reactive detection and manual clearing. The mode belongs to a
BamDude-dispatched run, not to a printer's current global settings.

## Implementation boundaries

This extends the existing dispatcher, queue claim, plate-answer gate and
OpenCV detector. It adds three boolean columns: order setting, queue snapshot
and auto-queue snapshot. Existing rows migrate to `false`. The archive's
existing dispatch intent records the dispatched mode.

No recipe registry, model-wide admission, G-code parser, ejection command,
new scheduler, retry protocol or restart-recovery subsystem is introduced.
Existing Swap Mode operates a different plate-change workflow. OctoPrint
and Klipper provide other printer-control APIs rather than a compatible
replacement for this project's Bambu dispatcher, so they are not added as
dependencies. References: [OctoPrint printer API](https://docs.octoprint.org/en/main/api/printer.html),
[Klipper G-code commands](https://www.klipper3d.org/G-Codes.html).

Fresh checks reject older buffered/coalesced images, wait for the next frame
when the live viewer owns the camera, and do not open a competing reader.
A failed configured external camera cannot substitute a different camera's
frame against its reference. Detection errors explicitly mean unavailable.

## Validation and rollout

Automated checks use synthetic orders, printers and camera frames. They cover
mode snapshots, copies, migration, failed and ordinary predecessor gates,
camera failures, stale telemetry, changing run tokens, reconnects, cancellation
and existing queue/dispatcher regressions. The development deployment uses the
isolated port-8001 environment and cannot reach farm printers.

These checks do not establish physical ejection reliability or the detector's
ability to see a particular small part. A supervised hardware trial and
production activation require separate agreement. Keep the first hardware
trial limited to one printer with a prepared file; observe the existing check
with both an empty plate and a retained part before allowing unattended work.
