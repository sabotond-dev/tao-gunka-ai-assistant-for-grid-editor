// Mimics agent CLIs for harness tests. Default persona is Claude
// stream-json; argv shape switches it to Codex (exec +
// --output-last-message) or Gemini (--approval-mode, plain stdout).
// MOCK_MODE=ok (default) streams a two-part answer; MOCK_MODE=nologin
// reproduces the signed-out CLI's behavior.

const fs = require("fs");
const mode = process.env.MOCK_MODE || "ok";
const argv = process.argv.slice(2);

// Login persona: `codex login` succeeds without touching stdin.
if (argv.includes("login")) {
  process.exit(mode === "nologin" ? 1 : 0);
}

let input = "";
process.stdin.on("data", (d) => (input += d));
process.stdin.on("end", () => {
  // Codex persona: write the answer (echoing received stdin so tests
  // can assert the transcript prefix) into the --output-last-message
  // file; stdout is just progress noise.
  if (argv.includes("exec")) {
    const outFile = argv[argv.indexOf("--output-last-message") + 1];
    if (mode === "nologin") {
      process.stderr.write("Please run codex login first\n");
      process.exit(1);
    }
    process.stdout.write("codex progress noise\n");
    fs.writeFileSync(outFile, `CODEX[${input.slice(0, 400)}]`);
    process.exit(0);
  }
  // Gemini persona: plain text answer on stdout.
  if (argv.includes("--approval-mode")) {
    if (mode === "nologin") {
      process.stderr.write("No credentials found, please sign in\n");
      process.exit(1);
    }
    process.stdout.write(`GEMINI[${input.slice(0, 60)}]`);
    process.exit(0);
  }
  if (mode === "nologin") {
    process.stderr.write("Not logged in · Please run /login\n");
    process.exit(1);
  }
  const out = (o) => process.stdout.write(JSON.stringify(o) + "\n");
  if (mode === "args") {
    // Reports its own argv so the harness can assert spawn arguments.
    out({ type: "system", subtype: "init", model: "mock" });
    out({
      type: "assistant",
      message: {
        content: [{ type: "text", text: "ARGS:" + JSON.stringify(process.argv.slice(2)) }],
      },
    });
    out({ type: "result", subtype: "success", duration_ms: 5 });
    process.exit(0);
  }
  if (mode === "nologin-stdout") {
    // The real CLI's actual signed-out behavior (verified 2.1.215):
    // the message arrives as a normal assistant text event.
    out({ type: "system", subtype: "init", model: "mock" });
    out({
      type: "assistant",
      message: {
        content: [{ type: "text", text: "Not logged in · Please run /login" }],
      },
    });
    out({ type: "result", subtype: "success", duration_ms: 10 });
    process.exit(0);
  }
  out({ type: "system", subtype: "init", model: "mock" });
  out({
    type: "assistant",
    message: {
      content: [{ type: "text", text: `Echo[${input.trim().slice(0, 20)}] ` }],
    },
  });
  out({
    type: "assistant",
    message: { content: [{ type: "text", text: "second chunk." }] },
  });
  out({
    type: "result",
    subtype: "success",
    duration_ms: 1234,
    session_id: "mock-session-1",
  });
  process.exit(0);
});
