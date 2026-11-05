import { createContext, useContext } from "react";

// Moving between office screens from anywhere: a dashboard card opens a load,
// a quick action opens the delivery-order import, and so on.

export type Tab = "operations" | "overview" | "loads" | "dispatch" | "containers" | "billing" | "fleet" | "customers" | "team" | "connections" | "mytrips" | "platform" | "m-ops" | "m-cases" | "m-dispatch" | "m-international";
/** What to open on arrival: a load's details, a delivery-order import, or a mortuary case. */
export type Intent = { loadId?: string; importOrder?: boolean; caseId?: string; queue?: string };

export const NavContext = createContext<{ go: (tab: Tab, intent?: Intent) => void; intent: Intent; clearIntent: () => void }>({
  go: () => {},
  intent: {},
  clearIntent: () => {},
});
export const useNav = () => useContext(NavContext);
