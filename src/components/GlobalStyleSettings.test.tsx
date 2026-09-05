import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { GlobalStyleSettingsView } from "./GlobalStyleSettings";

describe("GlobalStyleSettings component", () => {
  it("renders Global style copy and bans House style jargon", () => {
    const html = renderToStaticMarkup(
      <GlobalStyleSettingsView
        enabled={true}
        instructions="Always respond in pirate voice."
        saving={false}
        error=""
        onToggle={() => {}}
        onChangeInstructions={() => {}}
        onBlurInstructions={() => {}}
      />
    );

    expect(html).toContain("Applies to every bot");
    expect(html).toContain("Always respond in pirate voice.");
    expect(html).toContain("Global style instructions");
    expect(html).toMatch(/A bot(&#x27;|')s own instructions win over this/);
    // Banning House style and raw marker copy
    expect(html.toLowerCase()).not.toContain("house style");
    expect(html).not.toContain("[house-style: off]");
  });
});
