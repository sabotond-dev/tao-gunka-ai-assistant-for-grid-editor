// Chat panel for the Grid Agent package: a plain custom element the
// editor mounts as the package's preference component. Talks to
// index.js over the package message port; renders the streamed reply.

(function () {
  const PKG = "package-grid-agent";

  const STYLE = `
    .ga-root { display:flex; flex-direction:column; gap:8px; width:100%; }
    .ga-log { display:flex; flex-direction:column; gap:6px; max-height:340px;
      overflow-y:auto; padding:2px; }
    .ga-msg { padding:6px 9px; border-radius:8px; font-size:12px;
      line-height:1.45; white-space:pre-wrap; word-break:break-word; }
    .ga-user { align-self:flex-end; max-width:85%;
      background:rgba(20,206,150,0.16); color:var(--foreground,#ededed); }
    .ga-ai { align-self:flex-start; max-width:95%;
      background:rgba(255,255,255,0.07); color:var(--foreground,#ededed); }
    .ga-row { display:flex; gap:6px; }
    .ga-input { flex:1; min-width:0; padding:6px 8px; border-radius:6px;
      font-size:12px; color:var(--foreground,#ededed);
      background-color:rgba(0,0,0,0.25);
      border:1px solid rgba(255,255,255,0.14); resize:none; }
    .ga-input:focus { outline:none; border-color:rgba(20,206,150,0.6); }
    .ga-send { padding:6px 12px; border-radius:6px; cursor:pointer;
      font-size:12px; color:var(--foreground,#ededed);
      background-color:rgba(0,0,0,0.25);
      border:1px solid rgba(255,255,255,0.14); flex:none; }
    .ga-note { font-size:11px; line-height:1.4;
      color:var(--foreground-muted,#9d9d9d); }
    .ga-code { font-family:Consolas,monospace; font-size:10.5px;
      color:var(--foreground,#ededed); }
  `;

  class GridAgentChat extends HTMLElement {
    connectedCallback() {
      if (this._built) return;
      this._built = true;

      const style = document.createElement("style");
      style.textContent = STYLE;
      this.appendChild(style);

      const root = document.createElement("div");
      root.className = "ga-root";
      root.innerHTML = `
        <div class="ga-log"></div>
        <div class="ga-row">
          <textarea class="ga-input" rows="2"
            placeholder="Ask about your Grid setup…"></textarea>
          <button class="ga-send">Send</button>
        </div>
        <div class="ga-note ga-status"></div>
        <label class="ga-note" style="display:flex;gap:6px;cursor:pointer;">
          <input type="checkbox" class="ga-share" checked
            style="accent-color:#14ce96;flex:none;" />
          <span class="ga-share-label">Let the agent read my saved
            profiles and presets</span>
        </label>
        <div class="ga-note">
          Answers come from your own agent. The package runs your
          installed Claude Code headless: your subscription, your
          machine, no API key stored anywhere. It reads the built-in
          Grid reference, and with the toggle above, your saved
          configs in <span class="ga-code">grid-userdata</span>.
        </div>`;
      this.appendChild(root);

      this.log = root.querySelector(".ga-log");
      this.input = root.querySelector(".ga-input");
      this.sendBtn = root.querySelector(".ga-send");
      this.status = root.querySelector(".ga-status");
      this.shareToggle = root.querySelector(".ga-share");
      this.shareLabel = root.querySelector(".ga-share-label");
      this.busy = false;
      this.current = null;

      this.shareToggle.addEventListener("change", () => {
        this.port?.postMessage({
          type: "set-share-profiles",
          enabled: this.shareToggle.checked,
        });
      });
      this.sendBtn.addEventListener("click", () => this.send());
      this.input.addEventListener("keydown", (e) => {
        if (e.key === "Enter" && !e.shiftKey) {
          e.preventDefault();
          this.send();
        }
      });

      try {
        this.port = window.createPackageMessagePort(PKG, "grid-agent-chat");
        this.port.onmessage = (e) => this.onPortMessage(e.data);
        this.port.start?.();
      } catch (e) {
        this.status.textContent = "Package messaging unavailable.";
      }
    }

    addMsg(cls, text) {
      const el = document.createElement("div");
      el.className = `ga-msg ${cls}`;
      el.textContent = text;
      this.log.appendChild(el);
      this.log.scrollTop = this.log.scrollHeight;
      return el;
    }

    send() {
      const prompt = this.input.value.trim();
      if (!prompt || this.busy) return;
      this.input.value = "";
      this.busy = true;
      this.sendBtn.textContent = "…";
      this.addMsg("ga-user", prompt);
      this.current = null;
      this.status.textContent = "Thinking…";
      this.port?.postMessage({ type: "chat", prompt });
    }

    finish(statusText) {
      this.busy = false;
      this.sendBtn.textContent = "Send";
      this.status.textContent = statusText ?? "";
      this.current = null;
    }

    onPortMessage(msg) {
      if (!msg) return;
      if (msg.type === "chat-chunk") {
        if (!this.current) this.current = this.addMsg("ga-ai", "");
        this.current.textContent += msg.text;
        this.log.scrollTop = this.log.scrollHeight;
      } else if (msg.type === "chat-done") {
        this.finish(
          msg.stopped ? "Stopped." : msg.seconds ? `${msg.seconds}s` : "",
        );
      } else if (msg.type === "chat-error") {
        this.addMsg("ga-ai", msg.message);
        this.finish();
      } else if (msg.type === "agent-status") {
        if (this.shareToggle) this.shareToggle.checked = !!msg.shareProfiles;
        if (this.shareLabel) {
          this.shareLabel.textContent = msg.profilesFound
            ? `Let the agent read my saved profiles and presets ` +
              `(${msg.profileCount} found)`
            : "No saved profiles found in grid-userdata";
        }
      } else if (msg.type === "chat-login-needed") {
        this.addMsg(
          "ga-ai",
          "Your agent CLI is not signed in yet. One-time setup: open a " +
            "terminal, run  claude setup-token  and follow the browser " +
            "sign-in. After that, ask again.",
        );
        this.finish();
      }
    }
  }

  if (!customElements.get("grid-agent-chat")) {
    customElements.define("grid-agent-chat", GridAgentChat);
  }
})();
