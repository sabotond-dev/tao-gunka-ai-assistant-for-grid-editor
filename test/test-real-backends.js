// Smoke test against the REAL codex/gemini shims (both signed out):
// each should yield chat-login-needed or a clean error, not a hang.
const pkg = require("C:/Users/sabot/Documents/Claude/grid-agent-package/index.js");

const listeners = [];
let resolveTurn;
const port = {
  on(ev, cb) {
    if (ev === "message") listeners.push(cb);
  },
  start() {},
  close() {},
  postMessage(m) {
    if (["chat-done", "chat-error", "chat-login-needed"].includes(m.type)) {
      resolveTurn?.(m);
    }
  },
};
const emit = (data) => listeners.forEach((cb) => cb({ data }));
const turn = () => new Promise((r) => (resolveTurn = r));

(async () => {
  await pkg.loadPackage({ sendMessageToEditor() {} });
  await pkg.addMessagePort(port, "grid-agent-chat");
  for (const backend of ["codex", "gemini"]) {
    emit({ type: "set-backend", backend });
    const p = turn();
    emit({ type: "chat", prompt: "Reply with the word PONG." });
    const result = await Promise.race([
      p,
      new Promise((r) => setTimeout(() => r({ type: "timeout" }), 90000)),
    ]);
    console.log(
      `${backend}: ${result.type}` +
        (result.message ? ` | ${String(result.message).slice(0, 160)}` : "") +
        (result.backend ? ` | backend=${result.backend}` : ""),
    );
  }
  process.exit(0);
})();
