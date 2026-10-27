import { Fragment } from 'react';
import type { PlanPartCount } from '../../api/client';
import { LivePartThumb } from '../PartThumb';

/**
 * Parts named in a run of text — the plan's «covers», «outstanding» and «surplus after» (plan E6, D3):
 * each entry its picture and its words, the separator plain text between them. The text reads as it
 * did when the names were joined into one string; a picture adds none.
 */
export function PartCounts({
  parts,
  format,
  separator,
}: {
  parts: readonly PlanPartCount[];
  format: (part: PlanPartCount) => string;
  separator: string;
}) {
  return (
    <>
      {parts.map((part, index) => (
        <Fragment key={part.part_id}>
          {index > 0 && separator}
          <span className="inline-flex items-center gap-1 align-middle">
            <LivePartThumb partId={part.part_id} image={part.image} name={part.name} size="xs" />
            {format(part)}
          </span>
        </Fragment>
      ))}
    </>
  );
}
