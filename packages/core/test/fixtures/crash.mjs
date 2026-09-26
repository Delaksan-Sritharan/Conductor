console.error("boom");
setTimeout(() => process.exit(Number(process.env.EXIT ?? 1)), Number(process.env.DELAY ?? 100));
