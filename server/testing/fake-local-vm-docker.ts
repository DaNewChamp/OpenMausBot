// POSIX fake `docker` for harness tests that must prove Local VM invoke routes
// reach a ready browser VM and execute CDP actions through the real runner.
import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import {
  BROWSER_VM_KIND,
  BROWSER_VM_KIND_LABEL,
  BROWSER_VM_LAYER_LABEL,
  BROWSER_VM_LAYER_VERSION,
  BROWSER_VM_MEMORY_BYTES,
  BROWSER_VM_NANO_CPUS,
  BROWSER_VM_PIDS_LIMIT,
  BROWSER_VM_SHM_BYTES,
} from "../browser-vm-image.ts";
import {
  IMAGE,
  MANAGED_LABEL,
  WORKSPACE_LABEL,
  VM_WORKSPACE_GUEST,
} from "../container-computer.ts";

const MANAGED_IMAGE_ID = "sha256:managed-image-id";

export function preparedImageInspectJson(): string {
  return JSON.stringify([
    {
      Id: MANAGED_IMAGE_ID,
      Config: {
        Labels: {
          [MANAGED_LABEL]: "1",
          [BROWSER_VM_KIND_LABEL]: BROWSER_VM_KIND,
          [BROWSER_VM_LAYER_LABEL]: BROWSER_VM_LAYER_VERSION,
        },
      },
    },
  ]);
}

/** Container inspect JSON for a ready shared Local VM target. */
export function localVmContainerInspectJson(workspaceDir: string): string {
  return JSON.stringify([
    {
      Config: {
        Image: IMAGE,
        Labels: {
          [MANAGED_LABEL]: "1",
          [BROWSER_VM_KIND_LABEL]: BROWSER_VM_KIND,
          [BROWSER_VM_LAYER_LABEL]: BROWSER_VM_LAYER_VERSION,
          [WORKSPACE_LABEL]: "1",
        },
      },
      State: { Running: true },
      Image: MANAGED_IMAGE_ID,
      HostConfig: {
        Memory: BROWSER_VM_MEMORY_BYTES,
        MemorySwap: BROWSER_VM_MEMORY_BYTES,
        NanoCpus: BROWSER_VM_NANO_CPUS,
        PidsLimit: BROWSER_VM_PIDS_LIMIT,
        CapDrop: ["ALL"],
        CapAdd: ["CAP_SETUID", "CAP_SETGID"],
        Privileged: false,
        IpcMode: "private",
        CgroupnsMode: "private",
        ShmSize: BROWSER_VM_SHM_BYTES,
        RestartPolicy: { Name: "no", MaximumRetryCount: 0 },
        PortBindings: { "9222/tcp": [{ HostIp: "127.0.0.1" }] },
      },
      Mounts: [
        {
          Type: "bind",
          Source: workspaceDir,
          Destination: VM_WORKSPACE_GUEST,
          RW: true,
        },
      ],
      NetworkSettings: {
        Ports: { "9222/tcp": [{ HostIp: "127.0.0.1", HostPort: "9222" }] },
      },
    },
  ]);
}

const FAKE_DOCKER_SCRIPT = `#!/bin/sh
printf '%s\\n' "$*" >> "$FAKE_DOCKER_LOG"
case "$1" in
  info) echo "29.0.0" ;;
  image) cat "$FAKE_DOCKER_DIR/image.json" ;;
  inspect) name="$2"; sed "s|__NAME__|$name|g" "$FAKE_DOCKER_DIR/container.json.tpl" ;;
  exec)
    case "$*" in
      *"json/version"*) echo '{"Browser":"Chrome"}' ;;
      *"openmausbot-cdp.mjs"*) echo '{"ok":true}' ;;
      *"base64"*) cat "$FAKE_DOCKER_DIR/screenshot.b64" ;;
      *"bash"*) echo "ok" ;;
      *) echo "unexpected docker exec: $*" >&2; exit 64 ;;
    esac ;;
  *) echo "unexpected docker invocation: $*" >&2; exit 64 ;;
esac
`;

export function browserCdpPayloadsFromDockerLog(log: string): Array<{ action: string; payload: unknown }> {
  const payloads: Array<{ action: string; payload: unknown }> = [];
  for (const line of log.split("\n")) {
    const match = line.match(/openmausbot-cdp\.mjs\s+(\S+)\s+(\S+)/);
    if (!match) continue;
    payloads.push({
      action: match[1],
      payload: JSON.parse(Buffer.from(match[2], "base64url").toString("utf8")),
    });
  }
  return payloads;
}

export function installFakeLocalVmDockerRuntime(
  fakeBin: string,
  home: string,
): { dockerLog: string; workspaceDir: string } {
  const workspaceDir = join(home, ".openmausbot", "vm-home");
  mkdirSync(fakeBin, { recursive: true });
  mkdirSync(workspaceDir, { recursive: true });
  const dockerLog = join(fakeBin, "docker.log");
  writeFileSync(join(fakeBin, "docker"), FAKE_DOCKER_SCRIPT, { mode: 0o755 });
  chmodSync(join(fakeBin, "docker"), 0o755);
  writeFileSync(join(fakeBin, "image.json"), preparedImageInspectJson());
  writeFileSync(join(fakeBin, "container.json.tpl"), localVmContainerInspectJson(workspaceDir));
  const jpeg = Buffer.concat([
    Buffer.from([0xff, 0xd8]),
    Buffer.alloc(600),
    Buffer.from([0xff, 0xd9]),
  ]);
  writeFileSync(join(fakeBin, "screenshot.b64"), jpeg.toString("base64"));
  writeFileSync(dockerLog, "");
  return { dockerLog, workspaceDir };
}
