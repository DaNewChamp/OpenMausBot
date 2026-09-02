/** Compact browser-only chrome contract. Keep this separate from the
 * Electron shell layout: the hosted client is a two-column conversation UI,
 * not a responsive three-column desktop window. */
export const WEB_CLIENT_NAV_ITEMS = ["Bots", "Rooms", "Find", "Account"] as const;

export type WebClientLayout = {
  leftRail: "bots";
  main: "conversation";
  rightPane: "on-demand";
  trafficLights: false;
};

export function webClientLayout(): WebClientLayout {
  return {
    leftRail: "bots",
    main: "conversation",
    rightPane: "on-demand",
    trafficLights: false,
  };
}
