import { api } from "@/state/store";

interface ExportedPackage {
  package: {
    name: string;
    agents: unknown[];
  };
}

function downloadManifest(manifest: ExportedPackage): { name: string; members: number } {
  const slug =
    manifest.package.name
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "") || "openmaus-package";
  const blob = new Blob([`${JSON.stringify(manifest, null, 2)}\n`], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = `${slug}.mauspack.json`;
  document.body.appendChild(link);
  link.click();
  link.remove();
  // There is no browser event for "download has consumed this URL". Keep it
  // alive long enough for slower engines to start reading, then clean it up.
  window.setTimeout(() => URL.revokeObjectURL(url), 60_000);
  return { name: manifest.package.name, members: manifest.package.agents.length };
}

/** Export every active sidebar bot in one click. The server excludes hidden bots. */
export async function downloadAllBots(): Promise<{ name: string; members: number }> {
  const manifest = (await api("/api/teams/export", {
    method: "POST",
    body: JSON.stringify({ format: "package" }),
  })) as ExportedPackage;
  return downloadManifest(manifest);
}
