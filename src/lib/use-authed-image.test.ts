import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { AttachedImageGallery } from "@/components/AttachmentPreview";
import { BotAvatar } from "@/components/Avatar";
import {
  fetchAuthedImage,
  isAuthedImageUrl,
  releaseAuthedImage,
  useAuthedImage,
} from "./use-authed-image";
import { setHubApiBase, setHubDeviceToken } from "./web-client-session";

const token = "omb_" + "a".repeat(43);
let createdUrls: string[] = [];
let revokedUrls: string[] = [];

beforeEach(() => {
  createdUrls = [];
  revokedUrls = [];
  (URL as unknown as { createObjectURL: (blob: Blob) => string }).createObjectURL = () => {
    const next = `blob:authed-${createdUrls.length + 1}`;
    createdUrls.push(next);
    return next;
  };
  (URL as unknown as { revokeObjectURL: (url: string) => void }).revokeObjectURL = (url) => {
    revokedUrls.push(url);
  };
  setHubApiBase("");
  setHubDeviceToken(null);
});

afterEach(() => {
  delete (URL as unknown as { createObjectURL?: unknown }).createObjectURL;
  delete (URL as unknown as { revokeObjectURL?: unknown }).revokeObjectURL;
  vi.unstubAllGlobals();
});

function stubWebClientMode(web: boolean) {
  vi.stubGlobal("location", web
    ? { hostname: "vbot.posival.com", search: "" }
    : { hostname: "localhost", search: "" });
}

function Probe({ url }: { url: string | null }) {
  const { src, failed } = useAuthedImage(url);
  if (failed) return createElement("span", { "data-authed-image": "failed" });
  return src
    ? createElement("img", { src, alt: "" })
    : createElement("span", { "data-authed-image": "pending" });
}

describe("isAuthedImageUrl", () => {
  it("claims attachment paths and hub-origin attachment URLs", () => {
    expect(isAuthedImageUrl("/api/attachments/x.png")).toBe(true);
    setHubApiBase("https://hub.example");
    expect(isAuthedImageUrl("https://hub.example/api/attachments/x.png")).toBe(true);
    expect(isAuthedImageUrl("https://hub.example/api/other")).toBe(false);
    expect(isAuthedImageUrl("https://cdn.example/x.png")).toBe(false);
    setHubApiBase("");
    expect(isAuthedImageUrl("https://hub.example/api/attachments/x.png")).toBe(false);
  });
});

describe("fetchAuthedImage", () => {
  it("fetches with the device token and returns an object URL", async () => {
    setHubApiBase("https://hub.example");
    setHubDeviceToken(token);
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, blob: async () => new Blob(["img"]) });
    vi.stubGlobal("fetch", fetchMock);
    await expect(fetchAuthedImage("https://hub.example/api/attachments/x.png")).resolves.toBe(
      "blob:authed-1",
    );
    expect(fetchMock.mock.calls[0]![1]!.headers).toMatchObject({ authorization: `Bearer ${token}` });
    expect(revokedUrls).toEqual([]);
    vi.unstubAllGlobals();
  });

  it("returns null for a refusal without creating an object URL", async () => {
    setHubDeviceToken(token);
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, status: 401 }));
    await expect(fetchAuthedImage("/api/attachments/x.png")).resolves.toBeNull();
    expect(createdUrls).toEqual([]);
    vi.unstubAllGlobals();
  });

  it("propagates network failures for the hook to catch", async () => {
    setHubDeviceToken(token);
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new TypeError("network")));
    await expect(fetchAuthedImage("/api/attachments/x.png")).rejects.toThrow("network");
    vi.unstubAllGlobals();
  });
});

describe("releaseAuthedImage", () => {
  it("revokes the object URL", () => {
    releaseAuthedImage("blob:authed-1");
    expect(revokedUrls).toEqual(["blob:authed-1"]);
  });
});

describe("useAuthedImage", () => {
  it("holds a hub URL back from a paired web client until it is fetched", () => {
    stubWebClientMode(true);
    setHubApiBase("https://hub.example");
    setHubDeviceToken(token);
    const html = renderToStaticMarkup(
      createElement(Probe, { url: "https://hub.example/api/attachments/x.png" }),
    );
    expect(html).toContain("pending");
    expect(html).not.toContain("hub.example/api/attachments");
  });

  it("renders external URLs directly even in a paired web client", () => {
    stubWebClientMode(true);
    setHubApiBase("https://hub.example");
    setHubDeviceToken(token);
    const html = renderToStaticMarkup(createElement(Probe, { url: "https://cdn.example/x.png" }));
    expect(html).toContain('src="https://cdn.example/x.png"');
  });

  it("renders plain src outside the web client", () => {
    stubWebClientMode(false);
    setHubApiBase("https://hub.example");
    setHubDeviceToken(token);
    const html = renderToStaticMarkup(createElement(Probe, { url: "/api/attachments/x.png" }));
    expect(html).toContain('src="/api/attachments/x.png"');
  });

  it("keeps bot avatars off the bare hub URL in a paired web client", () => {
    stubWebClientMode(true);
    setHubApiBase("https://hub.example");
    setHubDeviceToken(token);
    const html = renderToStaticMarkup(
      createElement(BotAvatar, {
        bot: { name: "Scout", color: "green", avatarUrl: "x.png" },
        size: 30,
        animated: false,
      }),
    );
    expect(html).toContain("svg");
    expect(html).not.toContain("hub.example/api/attachments");
  });

  it("hides attachment thumbnails from a paired web client until fetched", () => {
    stubWebClientMode(true);
    setHubApiBase("https://hub.example");
    setHubDeviceToken(token);
    const html = renderToStaticMarkup(
      createElement(AttachedImageGallery, { paths: ["x.png"] }),
    );
    expect(html).not.toContain("<img");
    expect(html).not.toContain("/api/attachments/x.png");
  });

  it("still renders attachment thumbnails same-origin outside the web client", () => {
    stubWebClientMode(false);
    const html = renderToStaticMarkup(
      createElement(AttachedImageGallery, { paths: ["x.png"] }),
    );
    expect(html).toContain('src="/api/attachments/x.png"');
  });
});
