import http from "node:http";
console.log("entity-service: loading schema…");
setTimeout(() => {
  http.createServer((_, res) => res.end("entity ok")).listen(18081, () => console.log("Server started on :18081"));
}, 2000);
