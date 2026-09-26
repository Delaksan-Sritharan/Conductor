// Fake service: prints, waits DELAY ms, then listens on PORT with a /health endpoint.
import http from "node:http";

const port = Number(process.env.PORT);
const delay = Number(process.env.DELAY ?? 0);
const dieAfter = process.env.DIE_AFTER ? Number(process.env.DIE_AFTER) : undefined;

console.log(`booting ${process.env.NAME ?? ""}`.trim());
setTimeout(() => {
  http
    .createServer((req, res) => {
      res.statusCode = req.url === "/health" ? 200 : 404;
      res.end("ok");
    })
    .listen(port, () => {
      console.log(`listening on ${port}`);
      if (dieAfter !== undefined) setTimeout(() => process.exit(3), dieAfter);
    });
}, delay);
process.on("SIGTERM", () => process.exit(0));
