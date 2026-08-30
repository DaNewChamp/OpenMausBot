import { existsSync, readFileSync } from "node:fs";

const file = process.argv[2];
if (!file) throw new Error("usage: verify-vbot-update-metadata.mjs <app-update.yml>");

// electron-builder omits app-update.yml when publish is []; that is the safe
// default. If a packaging lane supplies one, it must be an explicit generic
// HTTPS feed and must never inherit the old public GitHub provider.
if (!existsSync(file)) {
  console.log("V Bot updater metadata absent: updates remain disabled until VBOT_UPDATE_FEED_URL is configured.");
  process.exit(0);
}

const text = readFileSync(file, "utf8");
if (!/^provider:\s*generic\s*$/m.test(text)) {
  throw new Error("V Bot updater metadata must use provider: generic");
}
const match = text.match(/^url:\s*(\S+)\s*$/m);
if (!match) throw new Error("V Bot updater metadata is missing an explicit HTTPS url");
let url;
try {
  url = new URL(match[1]);
} catch {
  throw new Error("V Bot updater metadata url is invalid");
}
if (url.protocol !== "https:" || url.username || url.password || url.port || url.search || url.hash) {
  throw new Error("V Bot updater metadata url must be an HTTPS private feed without credentials, port, query, or hash");
}
if (/github\.com|githubusercontent\.com|openmausbot-releases/i.test(url.hostname)) {
  throw new Error("V Bot updater metadata must not target the public or legacy OpenMausBot GitHub feed");
}
if (/^publisherName:\s*/m.test(text)) {
  throw new Error("V Bot unsigned packages must not carry publisherName");
}
console.log(`V Bot updater metadata verified: generic HTTPS feed ${url.origin}${url.pathname}`);
