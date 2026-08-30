// attachments.ts: save + read-back, the mime allowlist, size ceiling, and
// the name-lock that keeps the serving route inside the attachments dir.
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

// The module reads DATA_DIR at import time, so the env var must be set
// before the import is evaluated.
const DATA_ROOT = mkdtempSync(join(tmpdir(), "omb-attachments-"));
process.env.OMB_DATA_DIR = join(DATA_ROOT, "data");

const { ATTACHMENTS_DIR, IMAGE_MAX_BYTES, VIDEO_MAX_BYTES, extensionForMime, readAttachment, saveAttachment } = await import("./attachments.ts");

describe("extensionForMime", () => {
  it("maps the accepted image and video mimes to extensions", () => {
    expect(extensionForMime("image/png")).toBe(".png");
    expect(extensionForMime("image/jpeg")).toBe(".jpg");
    expect(extensionForMime("image/gif")).toBe(".gif");
    expect(extensionForMime("image/webp")).toBe(".webp");
    expect(extensionForMime("video/mp4")).toBe(".mp4");
    expect(extensionForMime("video/quicktime")).toBe(".mov");
  });

  it("tolerates parameters and casing", () => {
    expect(extensionForMime("Image/PNG; charset=binary")).toBe(".png");
    expect(extensionForMime("  image/webp  ")).toBe(".webp");
  });

  it("refuses everything else — including svg, which executes script", () => {
    expect(extensionForMime("image/svg+xml")).toBeNull();
    expect(extensionForMime("text/plain")).toBeNull();
    expect(extensionForMime(undefined)).toBeNull();
  });
});

describe("saveAttachment", () => {
  beforeEach(() => {
    rmSync(ATTACHMENTS_DIR, { recursive: true, force: true });
  });
  afterEach(() => {
    rmSync(ATTACHMENTS_DIR, { recursive: true, force: true });
  });

  it("persists bytes under the attachments dir with a generated name", () => {
    const saved = saveAttachment(Buffer.from("png-bytes"), "image/png");
    expect(saved.path.startsWith(ATTACHMENTS_DIR)).toBe(true);
    expect(saved.path.endsWith(".png")).toBe(true);
    expect(saved.bytes).toBe(9);
    expect(saved.mime).toBe("image/png");
    if (process.platform !== "win32") {
      expect(statSync(ATTACHMENTS_DIR).mode & 0o777).toBe(0o700);
      expect(statSync(saved.path).mode & 0o777).toBe(0o600);
    }
  });

  it("round-trips through readAttachment with the right mime", () => {
    const saved = saveAttachment(Buffer.from("gif!"), "image/gif");
    const name = saved.path.split(/[\\/]/).pop()!;
    const back = readAttachment(name);
    expect(back?.bytes.toString()).toBe("gif!");
    expect(back?.mime).toBe("image/gif");
  });

  it("rejects unsupported mimes, empty bodies, and oversize bodies", () => {
    expect(() => saveAttachment(Buffer.from("x"), "image/svg+xml")).toThrow(/unsupported attachment type/);
    expect(() => saveAttachment(Buffer.alloc(0), "image/png")).toThrow(/empty/);
    expect(() => saveAttachment(Buffer.alloc(IMAGE_MAX_BYTES + 1), "image/png")).toThrow(/exceeds/);
    expect(() => saveAttachment(Buffer.alloc(VIDEO_MAX_BYTES + 1), "video/mp4")).toThrow(/exceeds/);
  });

  it("persists mp4 and mov videos under the attachments dir", () => {
    const saved = saveAttachment(Buffer.from("ftyp"), "video/mp4");
    expect(saved.path.endsWith(".mp4")).toBe(true);
    expect(saved.mime).toBe("video/mp4");
  });
});

describe("readAttachment name lock", () => {
  beforeEach(() => {
    rmSync(ATTACHMENTS_DIR, { recursive: true, force: true });
  });
  afterEach(() => {
    rmSync(ATTACHMENTS_DIR, { recursive: true, force: true });
  });

  it("refuses traversal, dotfiles, and names the saver never writes", () => {
    expect(readAttachment("..%2F..%2Fconfig.json")).toBeNull();
    expect(readAttachment(".env")).toBeNull();
    expect(readAttachment("a/b.png")).toBeNull();
    expect(readAttachment("no-extension")).toBeNull();
    expect(readAttachment("uuid.jpeg")).toBeNull(); // saved as .jpg
  });
});
