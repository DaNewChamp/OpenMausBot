/** Hosted V Bot chrome matches the desktop Grok window: bot roster,
 * conversation, and the bot's computer. No traffic lights — the browser
 * already owns those. */
export const WEB_CLIENT_NAV_ITEMS = ["Bots", "Rooms", "Find", "Account"] as const;

export type WebClientLayout = {
  leftRail: "bots";
  main: "conversation";
  rightPane: "computer";
  trafficLights: false;
};

export function webClientLayout(): WebClientLayout {
  return {
    leftRail: "bots",
    main: "conversation",
    rightPane: "computer",
    trafficLights: false,
  };
}
