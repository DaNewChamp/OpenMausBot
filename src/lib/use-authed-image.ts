import { useEffect, useState } from "react";

import { isWebClientMode } from "@/lib/web-client-mode";
import { canCallHubApi, getHubApiBase, getHubDeviceToken } from "@/lib/web-client-session";

/**
 * Hub-served images answer only to a paired device's Bearer token, so a bare
 * <img> can never load one from the web client. A paired client fetches the
 * image with the device token and hangs the blob on the <img> as an object
 * URL instead; everything else — external URLs, unpaired or desktop runs —
 * renders its plain src exactly as before.
 */
export function isAuthedImageUrl(url: string): boolean {
  if (url.startsWith("/api/attachments/")) return true;
  const base = getHubApiBase();
  return Boolean(base) && url.startsWith(`${base}/api/attachments/`);
}

/** Fetch a hub image with the device token, returning an object URL or null. */
export async function fetchAuthedImage(url: string): Promise<string | null> {
  const token = getHubDeviceToken();
  const response = await fetch(url, {
    headers: token ? { authorization: `Bearer ${token}` } : undefined,
  });
  if (!response.ok) return null;
  return URL.createObjectURL(await response.blob());
}

export function releaseAuthedImage(objectUrl: string) {
  URL.revokeObjectURL(objectUrl);
}

export function useAuthedImage(url: string | null): { src: string | null; failed: boolean } {
  const authed = Boolean(url && isWebClientMode() && canCallHubApi() && isAuthedImageUrl(url));
  const [objectUrl, setObjectUrl] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    if (!url || !authed) {
      setObjectUrl(null);
      setFailed(false);
      return;
    }
    let cancelled = false;
    let loaded: string | null = null;
    setObjectUrl(null);
    setFailed(false);
    fetchAuthedImage(url)
      .then((next) => {
        if (cancelled) {
          if (next) releaseAuthedImage(next);
          return;
        }
        if (!next) {
          setFailed(true);
          return;
        }
        loaded = next;
        setObjectUrl(next);
      })
      .catch(() => {
        if (!cancelled) setFailed(true);
      });
    return () => {
      cancelled = true;
      if (loaded) releaseAuthedImage(loaded);
    };
  }, [url, authed]);

  if (!authed) return { src: url, failed: false };
  return { src: objectUrl, failed };
}
