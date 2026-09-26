process.on("SIGTERM", () => console.log("ignoring SIGTERM"));
console.log("stubborn ready");
setInterval(() => {}, 1000);
