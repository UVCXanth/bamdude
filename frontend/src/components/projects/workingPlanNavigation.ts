import { createContext, useContext } from 'react';

export const WorkingPlanNavigationDecision = createContext<() => boolean>(() => true);
export const useWorkingPlanDeparture = () => useContext(WorkingPlanNavigationDecision);
