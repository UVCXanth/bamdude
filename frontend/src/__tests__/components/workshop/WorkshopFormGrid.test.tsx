/**
 * The Workshop form grid (WS-13 E2 D07): two columns, one under 760 px, a field
 * that can span both. It lays fields out and nothing else — no schema, no field
 * generation. The geometry is measured in the browser fixture; here only what a
 * form leans on: the label names its control, the hint is addressable.
 */

import { describe, it, expect } from 'vitest';
import { screen } from '@testing-library/react';
import { render } from '../../utils';
import { WorkshopField, WorkshopFormGrid } from '../../../components/workshop/WorkshopFormGrid';

describe('WorkshopFormGrid', () => {
  it('labels each control and gives its hint an id the control can point at', () => {
    render(
      <WorkshopFormGrid>
        <WorkshopField label="Name" htmlFor="f-name" hint="As the customer sees it">
          <input id="f-name" aria-describedby="f-name-hint" />
        </WorkshopField>
        <WorkshopField label="Note" htmlFor="f-note" full>
          <textarea id="f-note" />
        </WorkshopField>
      </WorkshopFormGrid>,
    );

    expect(screen.getByLabelText('Name')).toHaveAccessibleDescription('As the customer sees it');
    expect(screen.getByLabelText('Note').tagName).toBe('TEXTAREA');
  });
});
