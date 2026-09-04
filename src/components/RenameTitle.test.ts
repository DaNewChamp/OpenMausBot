import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import { RenameTitle } from "./RenameTitle";

describe("RenameTitle", () => {
  it("does not expose an inert profile button when onActivate is absent", () => {
    const markup = renderToStaticMarkup(createElement(RenameTitle, {
      value: "Maus",
      onCommit: vi.fn(),
      showEditButton: true,
    }));

    expect(markup).not.toContain("Open Maus&#x27;s profile");
    expect(markup).toContain('aria-label="Rename Maus"');
  });

  it("exposes the profile button when onActivate is provided", () => {
    const markup = renderToStaticMarkup(createElement(RenameTitle, {
      value: "Maus",
      onCommit: vi.fn(),
      onActivate: vi.fn(),
      showEditButton: true,
    }));

    expect(markup).toContain("Open Maus&#x27;s profile");
  });

  it("uses a pointer cursor on the idle title so roster names do not look like text fields", () => {
    const markup = renderToStaticMarkup(createElement(RenameTitle, {
      value: "Hermes",
      onCommit: vi.fn(),
    }));
    expect(markup).toContain("cursor-pointer");
    expect(markup).not.toContain("cursor-text");
  });
});
