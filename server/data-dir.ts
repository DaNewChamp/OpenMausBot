import { homedir } from "node:os";
import { join } from "node:path";

// OMB_DATA_DIR isolates test/soak rigs from the user's real fleet.
// OMB_USER_DATA is what hosted/cloud launch scripts set (Electron userData on Mac).
export const DATA_DIR =
  process.env.OMB_DATA_DIR ??
  process.env.OMB_USER_DATA ??
  join(homedir(), ".openmausbot");
