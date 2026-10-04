import { useQuery } from '@tanstack/react-query';
import { api } from '../api/client';

/**
 * The curated settings a page renders with — date and time formats, the currency — readable
 * without `settings:read` (#1293). The Workshop's pages read their formats here (WS-13 E13
 * T17): a stock keeper or an order clerk is not a settings reader, and `GET /settings/` would
 * answer them 403 and every price and date would fall back to the defaults.
 */
export function useUiPreferences() {
  return useQuery({ queryKey: ['ui-preferences'], queryFn: api.getUiPreferences, staleTime: 60_000 });
}
