import { useAuth } from '../contexts/AuthContext';
import { sectionReadOf } from '../utils/sectionRead';

/** Whether the signed-in user may open a Workshop path — the question its route asks (WS-13 E13 O19). */
export function useCanOpen() {
  const { hasPermission } = useAuth();
  return (to: string) => {
    const reads = sectionReadOf(to);
    return reads == null || reads.some((p) => hasPermission(p));
  };
}
