const res = await fetch("http://127.0.0.1:18080/health").catch(() => null);
if (!res?.ok) (console.error("frontend: FATAL backend is not healthy"), process.exit(1));
console.log("frontend: compiling…");
setTimeout(() => console.log("  Local:   http://localhost:5173/"), 1000);
setInterval(() => {}, 1000);
