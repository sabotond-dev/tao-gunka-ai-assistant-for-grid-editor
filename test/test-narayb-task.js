// Narayb's exact failing task, against local Gemma 4 with the
// upgraded reference. Pass = grid-block proposals using real APIs
// (self:gms, gtt/gtp, Timer event) and no invented ones (os.*, midi.*).
const pkg = require("C:/Users/sabot/Documents/Claude/grid-agent-package/index.js");

const listeners = [];
let text = "";
const port = {
  on(ev, cb) {
    if (ev === "message") listeners.push(cb);
  },
  start() {},
  close() {},
  postMessage(m) {
    if (m.type === "chat-chunk") text += m.text;
    if (m.type === "chat-done") {
      const proposals = [];
      const re = /```grid-block[^\n]*\n([\s\S]*?)```/g;
      let match;
      while ((match = re.exec(text))) {
        try {
          proposals.push(JSON.parse(match[1]));
        } catch (e) {}
      }
      console.log("=== raw answer (first 600) ===");
      console.log(text.slice(0, 600));
      console.log("=== proposals:", proposals.length, "===");
      for (const p of proposals) {
        console.log(`[${p.name}] -> ${p.where}`);
        console.log(p.lua);
        console.log("---");
      }
      const allLua = proposals.map((p) => p.lua ?? "").join("\n");
      const usesReal =
        /gms\(/.test(allLua) && /gtt\(/.test(allLua) && /bst\(\)/.test(allLua);
      const usesFake = /os\.|midi\.|clock\(\)/.test(allLua + text);
      console.log(
        usesReal && !usesFake && proposals.length >= 2
          ? "VERDICT: PASS"
          : `VERDICT: FAIL (real:${usesReal} fake:${usesFake} count:${proposals.length})`,
      );
      process.exit(0);
    }
    if (m.type === "chat-error") {
      console.log("ERR", m.message);
      process.exit(1);
    }
  },
};

(async () => {
  await pkg.loadPackage(
    { sendMessageToEditor() {} },
    { backend: "local", localModel: "gemma4:12b", shareProfiles: true },
  );
  await pkg.addMessagePort(port, "grid-agent-chat");
  listeners.forEach((cb) =>
    cb({
      data: {
        type: "chat",
        prompt:
          "create an action that sends a 0,176,0,127 on a press, " +
          "1,176,0,127 on a long press and 2,176,0,127 on a " +
          "doublepress, long press should use a 1000ms delay",
      },
    }),
  );
})();
setTimeout(() => {
  console.log("TIMEOUT");
  process.exit(1);
}, 340000);
