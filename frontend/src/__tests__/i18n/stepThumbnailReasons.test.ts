import { describe, expect, it } from 'vitest';
import en from '../../i18n/locales/en';
import uk from '../../i18n/locales/uk';
import { THUMBNAIL_REASONS, thumbnailReasonKey } from '../../utils/stepThumbnailReasons';

type Tree = Record<string, unknown>;

function reasons(locale: Tree): Record<string, string> {
  const fileManager = locale.fileManager as Tree;
  return (fileManager.stepThumbnail as Tree).reasons as Record<string, string>;
}

describe('STEP thumbnail reasons', () => {
  it('give every closed reason its own sentence in both locales', () => {
    for (const locale of [en, uk] as Tree[]) {
      for (const code of THUMBNAIL_REASONS) {
        expect(reasons(locale)[code], code).toBeTruthy();
      }
    }
  });

  it('name a file that is not a STEP model as such, never as an internal error', () => {
    expect(thumbnailReasonKey('not_step')).toBe('fileManager.stepThumbnail.reasons.not_step');
    expect(reasons(en as Tree).not_step).toMatch(/not a STEP/i);
  });

  it('say a model is too large or complex, not that it needs memory, for every size cap', () => {
    expect(reasons(en as Tree).resource_limit).not.toMatch(/memory/i);
    expect(reasons(uk as Tree).resource_limit).not.toMatch(/пам/i);
  });

  it('never tell the reader to install or repair what this server cannot install', () => {
    expect(reasons(en as Tree).cad_unavailable).not.toMatch(/install|repair/i);
    expect(reasons(uk as Tree).cad_unavailable).not.toMatch(/встанов|віднов/i);
  });
});
