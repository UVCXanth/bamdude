import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { paintColour } from '../../part-render/colour';
import { runJob } from '../../part-render/job';
import { MANIFEST_MAX, PNG_FRAME_OVERHEAD, RenderError, type RenderJob } from '../../part-render/protocol';
import { drawSegments } from '../../part-render/raster';

const FIXTURES = join(process.cwd(), '..', 'backend', 'app', 'data', 'render_probe');
const gcode = (name: string) => readFileSync(join(FIXTURES, name), 'utf8');
// outputBytes covers the PNG frames AND the manifest reserve (MANIFEST_MAX)
const job = (objects: RenderJob['objects'], outputBytes = 8 * 2 ** 20): RenderJob => ({ size: 64, objects, outputBytes });
const reasonOf = (run: () => unknown) => {
  try { run(); } catch (e) { return (e as RenderError).reason; }
  return 'no error';
};

describe('runJob', () => {
  it('renders each marked object and reports an unmarked id as missing', () => {
    const pngs = new Map<number, Uint8Array>();
    const m = runJob(job([{ id: 101, mode: 'toolpath' }, { id: 202, mode: 'toolpath' }, { id: 999, mode: 'toolpath' }]),
      gcode('two-objects.gcode'), (id, png) => pngs.set(id, png));
    expect([...pngs.keys()]).toEqual([101, 202]);
    expect(m.renderer).toBe(3); // spec §34: dark filament raised to its lightness floor
    expect(m.objects.map((o) => [o.id, o.method])).toEqual([[101, 'toolpath'], [202, 'toolpath'], [999, 'missing']]);
    expect(m.objects[2]).toMatchObject({ reason: 'empty_selection' });
    expect(m.objects[0]).toMatchObject({ tools: [0, 2], width: 64, height: 64, bytes: pngs.get(101)!.length });
  });

  it('renders the model of a markerless single object only inside its plate box', () => {
    const inside = runJob(job([{ id: 1, mode: 'model', bbox: [119, 119, 126, 126] }]), gcode('single-no-markers.gcode'), () => {});
    expect(inside.objects[0].method).toBe('model');
    const outside = runJob(job([{ id: 1, mode: 'model', bbox: [0, 0, 5, 5] }]), gcode('single-no-markers.gcode'), () => {});
    expect(outside.objects[0]).toMatchObject({ method: 'missing', reason: 'model_unproven' });
  });

  // BambuStudio's plate_N.json box is the FIRST LAYER's (Plater::priv::generate_first_layer_bbox): a part whose
  // upper layers overhang its footprint is still the part -- a real box overhung by 3-4 mm (E7 acceptance).
  const overhung = (text: string) =>
    text.replace(
      /(; Z_HEIGHT: 0\.4[\s\S]*?; FEATURE: Outer wall\n)[\s\S]*?(; FEATURE: Custom)/,
      '$1G1 X114 Y114 F12000\nG1 X131 Y114 E0.4\nG1 X131 Y131 E0.4\nG1 X114 Y131 E0.4\nG1 X114 Y114 E0.4\n$2',
    );

  it('proves the model by its first layer against the first-layer box, whatever the layers above overhang', () => {
    const text = overhung(gcode('single-no-markers.gcode'));
    expect(text).toContain('G1 X131 Y131 E0.4');
    const m = runJob(job([{ id: 1, mode: 'model', bbox: [119, 119, 126, 126] }]), text, () => {});
    expect(m.objects[0].method).toBe('model');
  });

  it('still refuses a typed purge line on the first layer beside the model', () => {
    const text = gcode('single-no-markers.gcode').replace(
      '; FEATURE: Outer wall\n; LINE_WIDTH: 0.42\n',
      '; FEATURE: Outer wall\n; LINE_WIDTH: 0.42\nG1 X18 Y1 F12000\nG1 X218 Y1 E12\n',
    );
    expect(text).toContain('G1 X218 Y1 E12\nG1 X120 Y120');
    const m = runJob(job([{ id: 1, mode: 'model', bbox: [119, 119, 126, 126] }]), text, () => {});
    expect(m.objects[0]).toMatchObject({ method: 'missing', reason: 'model_unproven' });
  });

  it('reports a fully transparent render as missing empty_render, without a PNG', () => {
    const m = runJob(job([{ id: 101, mode: 'toolpath' }]), gcode('two-objects.gcode'),
      () => { throw new Error('no PNG for an empty render'); }, () => {});
    expect(m.objects[0]).toMatchObject({ method: 'missing', reason: 'empty_render' });
  });

  it('refuses a palette without the colour of a used tool as parse_failed', () => {
    const noPalette = gcode('two-objects.gcode').replace(/^; filament_colour = .*$/m, '; filament_colour = ');
    expect(noPalette).not.toBe(gcode('two-objects.gcode'));
    expect(reasonOf(() => runJob(job([{ id: 101, mode: 'toolpath' }]), noPalette, () => {}))).toBe('parse_failed');
  });

  it('stops at the output budget with invalid_output', () => {
    expect(reasonOf(() => runJob(job([{ id: 101, mode: 'toolpath' }], 10), gcode('two-objects.gcode'), () => {}))).toBe('invalid_output');
  });

  it('keeps room for the whole manifest frame, its 5-byte header included', () => {
    // Python counts every stdout byte: the P frame and the M frame at its largest, header and all
    const one: RenderJob['objects'] = [{ id: 101, mode: 'toolpath' }];
    let png = 0;
    runJob(job(one), gcode('two-objects.gcode'), (_, bytes) => { png = bytes.length; });
    const exact = png + PNG_FRAME_OVERHEAD + 5 + MANIFEST_MAX;
    expect(reasonOf(() => runJob(job(one, exact), gcode('two-objects.gcode'), () => {}))).toBe('no error');
    expect(reasonOf(() => runJob(job(one, exact - 1), gcode('two-objects.gcode'), () => {}))).toBe('invalid_output');
  });

  it('paints a black filament in its raised colour, so its faces show (spec §34)', () => {
    const black = gcode('two-objects.gcode').replace(/^; filament_colour = .+$/m, '; filament_colour = #000000;#000000;#000000');
    const seen: number[] = [];
    runJob(job([{ id: 202, mode: 'toolpath' }]), black, () => {}, (data, rgb, cam, target) => {
      seen.push(rgb[0], rgb[1], rgb[2]);
      drawSegments(data, rgb, cam, target);
    });
    expect(seen).toEqual(Array.from(new Float32Array(paintColour([0, 0, 0])))); // the rgb buffer is float32
    expect(seen[0]).toBeGreaterThan(0.2);
  });

  it('gives the same bytes twice', () => {
    const a: Uint8Array[] = [], b: Uint8Array[] = [];
    runJob(job([{ id: 101, mode: 'toolpath' }]), gcode('two-objects.gcode'), (_, p) => a.push(p));
    runJob(job([{ id: 101, mode: 'toolpath' }]), gcode('two-objects.gcode'), (_, p) => b.push(p));
    expect(Buffer.from(a[0]).equals(Buffer.from(b[0]))).toBe(true);
  });
});
