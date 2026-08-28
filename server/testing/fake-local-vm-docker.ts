// POSIX fake `docker` for harness tests that must prove Local VM invoke routes
// reach a ready desktop and execute Cua `launch_app` through the real runner.
import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import {
  BASE_IMAGE_DIGEST,
  BASE_IMAGE_LABEL,
  CUA_DRIVER_VERSION,
  DRIVER_LABEL,
  IMAGE,
  IMAGE_LAYER_LABEL,
  IMAGE_LAYER_VERSION,
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
          [DRIVER_LABEL]: CUA_DRIVER_VERSION,
          [BASE_IMAGE_LABEL]: BASE_IMAGE_DIGEST,
          [IMAGE_LAYER_LABEL]: IMAGE_LAYER_VERSION,
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
          [DRIVER_LABEL]: CUA_DRIVER_VERSION,
          [BASE_IMAGE_LABEL]: BASE_IMAGE_DIGEST,
          [IMAGE_LAYER_LABEL]: IMAGE_LAYER_VERSION,
          [WORKSPACE_LABEL]: "1",
        },
        Env: ["VNC_PW=secret123"],
      },
      State: { Running: true },
      Image: MANAGED_IMAGE_ID,
      HostConfig: {
        Memory: 4 * 1024 * 1024 * 1024,
        MemorySwap: 4 * 1024 * 1024 * 1024,
        NanoCpus: 2_000_000_000,
        PidsLimit: 512,
        CapDrop: ["ALL"],
        CapAdd: ["CAP_SETUID", "CAP_SETGID"],
        Privileged: false,
        IpcMode: "private",
        CgroupnsMode: "private",
        ShmSize: 512 * 1024 * 1024,
        RestartPolicy: { Name: "no", MaximumRetryCount: 0 },
        PortBindings: { "6901/tcp": [{ HostIp: "127.0.0.1" }] },
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
        Ports: { "6901/tcp": [{ HostIp: "127.0.0.1", HostPort: "6080" }] },
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
      *"--version"*) echo "cua-driver ${CUA_DRIVER_VERSION}" ;;
      *"--screenshot-out-file"*) echo "{}" ;;
      *"health_report"*) echo '{"schema_version":"1","overall":"ok","checks":[]}' ;;
      *"get_desktop_state"*) echo "{}" ;;
      *"launch_app"*) echo "launched" ;;
      *"base64"*) cat "$FAKE_DOCKER_DIR/screenshot.b64" ;;
      *"status"*) echo "running" ;;
      *"rm -f"*) : ;;
      *) echo "unexpected docker exec: $*" >&2; exit 64 ;;
    esac ;;
  *) echo "unexpected docker invocation: $*" >&2; exit 64 ;;
esac
`;

export function launchAppPayloadsFromDockerLog(log: string): Array<{ app?: string; arguments?: string[] }> {
  const payloads: Array<{ app?: string; arguments?: string[] }> = [];
  for (const line of log.split("\n")) {
    const match = line.match(/launch_app\s+(\{.*\})\s+--socket/);
    if (match) payloads.push(JSON.parse(match[1]));
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
  const png = Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    Buffer.alloc(600),
    Buffer.from("IEND", "ascii"),
  ]);
  writeFileSync(join(fakeBin, "screenshot.b64"), png.toString("base64"));
  writeFileSync(dockerLog, "");
  return { dockerLog, workspaceDir };
}
