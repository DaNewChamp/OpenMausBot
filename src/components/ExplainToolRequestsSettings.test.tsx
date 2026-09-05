import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { ExplainToolRequestsSettings } from "./ApprovalReviewerSettings";

describe("ExplainToolRequestsSettings (approval explanations)", () => {
  it("renders only Off, When unclear, Always modes without provider/model dropdowns", () => {
    const html = renderToStaticMarkup(
      <ExplainToolRequestsSettings
        status={{
          mode: "when-unclear",
          selection: { instanceId: "openai", model: "gpt-5.4" },
          providers: [
            {
              id: "openai",
              label: "OpenAI",
              instanceId: "openai",
              available: true,
              configured: true,
              reason: null,
              models: [{ id: "gpt-5.4", label: "GPT-5.4" }],
            },
          ],
        }}
        saving={false}
        onSave={() => {}}
      />
    );

    expect(html).toContain("Off");
    expect(html).toContain("When unclear");
    expect(html).toContain("Always");
    // Banning provider/model plumbing in normal settings
    expect(html).not.toContain("approval-reviewer-provider");
    expect(html).not.toContain("GPT-5.4");
    expect(html).not.toContain("OpenAI");
    expect(html).not.toMatch(/provider/i);
  });
});
