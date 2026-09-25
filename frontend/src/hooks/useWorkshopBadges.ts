import { useQuery } from '@tanstack/react-query';
import { api } from '../api/client';
import type { ProjectsNavBadges } from '../api/client';

/**
 * The Projects section's sidebar counts (spec workshop-nav, rule 10). Keyed
 * under `['projects']`, so every order mutation and the print events the
 * socket already relays refresh it; the one-minute poll catches what other
 * people changed. Asked only when the Projects entry is visible.
 */
export function useWorkshopBadges(enabled: boolean) {
  return useQuery<ProjectsNavBadges>({
    queryKey: ['projects', 'nav-badges'],
    queryFn: () => api.getProjectsNavBadges(),
    enabled,
    staleTime: 30_000,
    refetchInterval: 60_000,
  });
}
