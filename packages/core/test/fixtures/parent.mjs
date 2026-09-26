// Like `npm run dev`: a long-lived parent that spawns the real server as a child.
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
spawn(process.execPath, [path.join(here, "server.mjs")], { stdio: "inherit" });
setInterval(() => {}, 1000);
