import http from "node:http";
import net from "node:net";

// A real backend needs the entity service at boot. If devflow started us too early, we crash.
await new Promise((resolve) => {
  const s = net.connect(18081, "127.0.0.1");
  s.once("connect", () => (s.destroy(), console.log("backend: connected to entity-service"), resolve()));
  s.once("error", () => (console.error("backend: FATAL entity-service is not reachable"), process.exit(1)));
});
console.log("backend: warming up…");
setTimeout(() => {
  http
    .createServer((req, res) => res.end(req.url === "/health" ? '{"status":"UP"}' : "backend"))
    .listen(18080, () => console.log("Started application on :18080"));
}, 3000);
