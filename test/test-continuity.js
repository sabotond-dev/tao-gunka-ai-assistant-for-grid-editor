// Real two-turn conversation through the package: turn 2 only answers
// correctly if --resume carried turn 1's context.
const pkg = require("C:/Users/sabot/Documents/Claude/grid-agent-package/index.js");

const listeners = [];
let onDone;
let text = "";
const port = {
  on(ev, cb) {
    if (ev === "message") listeners.push(cb);
  },
  start() {},
  close() {},
  postMessage(m) {
    if (m.type === "chat-chunk") text += m.text;
    if (m.type === "chat-done") onDone?.();
    if (m.type === "chat-error" || m.type === "chat-login-needed") {
      console.log("FAILED:", m.message ?? m.type);
      process.exit(1);
    }
  },
};

function ask(prompt) {
  return new Promise((resolve) => {
    text = "";
    onDone = () => resolve(text.trim());
    for (const cb of listeners) cb({ data: { type: "chat", prompt } });
  });
}

(async () => {
  await pkg.loadPackage({ sendMessageToEditor() {} });
  await pkg.addMessagePort(port, "grid-agent-chat");
  const a1 = await ask(
    "For this conversation: my VSN1 knob is mapped to Lumetri Tint. Just acknowledge in three words.",
  );
  console.log("turn1:", a1.slice(0, 80));
  const a2 = await ask(
    "What did I tell you my VSN1 knob is mapped to? Answer with the parameter name only.",
  );
  console.log("turn2:", a2.slice(0, 80));
  const pass = /tint/i.test(a2);
  console.log(pass ? "CONTINUITY OK" : "CONTINUITY FAILED");
  process.exit(pass ? 0 : 1);
})();
setTimeout(() => {
  console.log("TIMEOUT");
  process.exit(1);
}, 240000);
