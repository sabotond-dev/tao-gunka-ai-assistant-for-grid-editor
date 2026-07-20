// Chat panel for the Grid Agent package: a plain custom element the
// editor mounts as the package's preference component. Talks to
// index.js over the package message port; renders the streamed reply.

(function () {
  const PKG = "package-grid-agent";
  const ACCENT = "20,206,150"; // editor green, rgb triplet

  const STYLE = `
    .ga-root { display:flex; flex-direction:column; gap:10px; width:100%;
      font-size:12px; color:var(--foreground,#ededed); }

    /* Conversation ---------------------------------------------------- */
    .ga-log { display:flex; flex-direction:column; gap:10px;
      min-height:260px; max-height:440px; overflow-y:auto;
      padding:4px 2px; scroll-behavior:smooth; }
    .ga-log::-webkit-scrollbar { width:6px; }
    .ga-log::-webkit-scrollbar-thumb { background:rgba(255,255,255,0.12);
      border-radius:3px; }
    .ga-log::-webkit-scrollbar-track { background:transparent; }

    .ga-wrap { position:relative; display:flex; }
    .ga-wrap-user { justify-content:flex-end; }
    .ga-wrap-ai { justify-content:flex-start; }

    .ga-msg { line-height:1.55; white-space:pre-wrap;
      word-break:break-word; user-select:text !important;
      -webkit-user-select:text !important; cursor:text; }
    .ga-msg ::selection { background:rgba(${ACCENT},0.35); }
    .ga-user { max-width:85%; padding:7px 11px;
      background:rgba(${ACCENT},0.14);
      border:1px solid rgba(${ACCENT},0.25);
      border-radius:10px 10px 3px 10px; }
    .ga-ai { max-width:100%; width:100%; padding:2px 0 2px 11px;
      border-left:2px solid rgba(${ACCENT},0.55); }
    .ga-error { border-left-color:rgba(224,140,80,0.8);
      color:var(--foreground-muted,#c9a); }

    .ga-msg pre { position:relative; background:rgba(0,0,0,0.35);
      border:1px solid rgba(255,255,255,0.08); border-radius:6px;
      padding:7px 9px; margin:6px 0; overflow-x:auto;
      font-family:Consolas,monospace; font-size:11px; line-height:1.5;
      user-select:text !important; -webkit-user-select:text !important; }
    .ga-msg pre:hover { border-color:rgba(${ACCENT},0.35); }
    .ga-msg code { font-family:Consolas,monospace; font-size:11px;
      background:rgba(0,0,0,0.3); border-radius:3px; padding:0 4px;
      user-select:text !important; -webkit-user-select:text !important; }

    .ga-copy { position:absolute; top:-2px; right:0; padding:2px 8px;
      font-size:10px; border-radius:5px; cursor:pointer;
      color:var(--foreground-muted,#9d9d9d);
      background:rgba(0,0,0,0.5); border:1px solid rgba(255,255,255,0.14);
      opacity:0; transition:opacity 0.12s; }
    .ga-wrap:hover .ga-copy { opacity:1; }
    .ga-copy:hover { color:var(--foreground,#ededed);
      border-color:rgba(${ACCENT},0.5); }

    /* Empty state ----------------------------------------------------- */
    .ga-empty { display:flex; flex-direction:column; gap:8px;
      margin:auto 0; padding:12px 4px; align-items:flex-start; }
    .ga-empty-title { color:var(--foreground-muted,#9d9d9d);
      line-height:1.5; }
    .ga-chip { padding:5px 10px; font-size:11px; border-radius:999px;
      cursor:pointer; color:var(--foreground,#ededed); text-align:left;
      background:rgba(255,255,255,0.05);
      border:1px solid rgba(255,255,255,0.14); }
    .ga-chip:hover { border-color:rgba(${ACCENT},0.5);
      background:rgba(${ACCENT},0.08); }

    /* Composer -------------------------------------------------------- */
    .ga-composer { display:flex; gap:8px; align-items:flex-end; }
    .ga-input { flex:1; min-width:0; padding:8px 10px; border-radius:8px;
      font-size:12px; line-height:1.45; font-family:inherit;
      color:var(--foreground,#ededed); background:rgba(0,0,0,0.25);
      border:1px solid rgba(255,255,255,0.14); resize:none;
      max-height:120px; overflow-y:auto; }
    .ga-input:focus { outline:none; border-color:rgba(${ACCENT},0.6); }
    .ga-send { padding:8px 16px; border-radius:8px; cursor:pointer;
      font-size:12px; flex:none; color:#0d1f19;
      background:rgba(${ACCENT},0.85); border:1px solid transparent;
      font-weight:600; }
    .ga-send:hover { background:rgba(${ACCENT},1); }
    .ga-send.ga-stop { color:var(--foreground,#ededed);
      background:rgba(224,80,80,0.2);
      border-color:rgba(224,80,80,0.5); font-weight:400; }
    .ga-send.ga-stop:hover { background:rgba(224,80,80,0.32); }

    /* Meta row -------------------------------------------------------- */
    .ga-meta { display:flex; justify-content:space-between;
      align-items:center; min-height:20px; }
    .ga-status { font-size:11px; color:var(--foreground-muted,#9d9d9d); }
    .ga-thinking i { display:inline-block; width:4px; height:4px;
      margin-left:3px; border-radius:50%;
      background:rgba(${ACCENT},0.9); animation:ga-blink 1.2s infinite;
      font-style:normal; }
    .ga-thinking i:nth-child(2) { animation-delay:0.2s; }
    .ga-thinking i:nth-child(3) { animation-delay:0.4s; }
    @keyframes ga-blink { 0%,80%,100% { opacity:0.2; }
      40% { opacity:1; } }
    .ga-new { padding:4px 10px; border-radius:6px; cursor:pointer;
      font-size:11px; color:var(--foreground-muted,#9d9d9d);
      background:none; border:1px solid rgba(255,255,255,0.14);
      flex:none; }
    .ga-new:hover { color:var(--foreground,#ededed);
      border-color:rgba(255,255,255,0.3); }
    .ga-backend { padding:4px 6px; border-radius:6px; cursor:pointer;
      font-size:11px; color:var(--foreground,#ededed);
      background:rgba(0,0,0,0.25);
      border:1px solid rgba(255,255,255,0.14); flex:none;
      max-width:150px; }
    .ga-backend:focus { outline:none;
      border-color:rgba(${ACCENT},0.6); }

    /* Block proposal cards -------------------------------------------- */
    .ga-card { border:1px solid rgba(${ACCENT},0.4); border-radius:8px;
      padding:8px 10px; margin:6px 0 0 11px; max-width:100%;
      background:rgba(${ACCENT},0.06); }
    .ga-card-name { font-weight:600; margin-bottom:2px; }
    .ga-card-where { font-size:11px;
      color:var(--foreground-muted,#9d9d9d); margin-bottom:6px; }
    .ga-card-btn { padding:5px 12px; border-radius:6px; cursor:pointer;
      font-size:11px; font-weight:600; color:#0d1f19;
      background:rgba(${ACCENT},0.85); border:none; }
    .ga-card-btn:hover { background:rgba(${ACCENT},1); }
    .ga-card-btn[disabled] { background:rgba(255,255,255,0.12);
      color:var(--foreground-muted,#9d9d9d); cursor:default;
      font-weight:400; }
    .ga-proposal { font-size:11px; font-style:italic;
      color:var(--foreground-muted,#9d9d9d); margin:4px 0; }
    .ga-blocks-row { display:flex; justify-content:space-between;
      align-items:center; gap:6px; }
    .ga-blocks-x { padding:1px 7px; border-radius:5px; cursor:pointer;
      font-size:10px; color:var(--foreground-muted,#9d9d9d);
      background:none; border:1px solid rgba(255,255,255,0.14);
      flex:none; }
    .ga-blocks-x:hover { border-color:rgba(224,80,80,0.6);
      color:var(--foreground,#ededed); }

    /* Footer ----------------------------------------------------------- */
    .ga-footer { display:flex; flex-direction:column; gap:6px;
      border-top:1px solid rgba(255,255,255,0.1); padding-top:8px; }
    .ga-note { font-size:11px; line-height:1.45;
      color:var(--foreground-muted,#9d9d9d); }
    .ga-code { font-family:Consolas,monospace; font-size:10.5px; }
  `;

  // Markdown-lite for assistant messages: escape everything first,
  // then bring back the handful of shapes the agent actually uses.
  function esc(s) {
    return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  }

  function renderMarkdown(raw) {
    const blocks = [];
    let text = raw.replace(
      /```([^\n]*)\n([\s\S]*?)(```|$)/g,
      (m, lang, body) => {
        blocks.push(
          /^grid-block/.test(lang.trim())
            ? `<div class="ga-proposal">Block proposal - Apply card below</div>`
            : `<pre>${esc(body.replace(/\n$/, ""))}</pre>`,
        );
        return `\u0000${blocks.length - 1}\u0000`;
      },
    );
    text = esc(text)
      .replace(/`([^`\n]+)`/g, "<code>$1</code>")
      .replace(/\*\*([^*\n]+)\*\*/g, "<b>$1</b>")
      .replace(/^#{1,4} (.*)$/gm, "<b>$1</b>")
      .replace(/^[-*] /gm, "• ");
    text = text.replace(/\u0000(\d+)\u0000/g, (m, i) => blocks[Number(i)]);
    return text;
  }

  const STARTERS = [
    "What do my saved configs do?",
    "Build me a screen readout for a fader",
    "Why does my knob feel too coarse?",
  ];

  // Config UI for agent-created blocks: nothing to configure, the
  // block carries the Lua the agent wrote. Same editor handshake as
  // the other packages' components (deferred dispatch, re-fired per
  // connect, so pasted blocks receive their config).
  class GridAgentBlock extends HTMLElement {
    connectedCallback() {
      if (!this._built) {
        this._built = true;
        const note = document.createElement("div");
        note.style.cssText =
          "font-size:11px;line-height:1.45;color:var(--foreground-muted,#9d9d9d);";
        note.textContent =
          "Created by the Grid Assistant. The Lua below is the block; " +
          "edit it in the code view if you want to tweak it.";
        this.appendChild(note);
        this.preEl = document.createElement("pre");
        this.preEl.style.cssText =
          "background:rgba(0,0,0,0.35);border-radius:6px;padding:6px 8px;" +
          "margin-top:6px;overflow-x:auto;font-family:Consolas,monospace;" +
          "font-size:10.5px;white-space:pre-wrap;word-break:break-word;" +
          "user-select:text;color:var(--foreground,#ededed);";
        this.appendChild(this.preEl);
      }
      setTimeout(() => {
        if (!this.isConnected) return;
        this.dispatchEvent(
          new CustomEvent("updateConfigHandler", {
            bubbles: true,
            detail: {
              handler: (config) => {
                this._script = String(config?.script ?? "");
                if (this.preEl) this.preEl.textContent = this._script;
              },
            },
          }),
        );
      }, 0);
    }
  }

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
        <div class="ga-log">
          <div class="ga-empty">
            <div class="ga-empty-title">Ask about blocks, Lua, or your
              saved configs. Answers come from your own agent, on your
              machine.</div>
            ${STARTERS.map(
              (s) => `<button class="ga-chip">${s}</button>`,
            ).join("")}
          </div>
        </div>
        <div class="ga-composer">
          <textarea class="ga-input" rows="1"
            placeholder="Ask about your Grid setup…"></textarea>
          <button class="ga-send">Send</button>
        </div>
        <div class="ga-meta">
          <select class="ga-backend" title="Which agent answers">
            <option value="claude">Claude Code</option>
            <option value="codex">Codex (ChatGPT)</option>
            <option value="gemini">Gemini</option>
          </select>
          <div class="ga-status" style="flex:1;margin:0 8px;"></div>
          <button class="ga-new">New chat</button>
        </div>
        <div class="ga-footer">
          <div class="ga-blocks" style="display:none;">
            <div class="ga-note" style="font-weight:600;">Assistant blocks
              in your palette</div>
            <div class="ga-blocks-list"></div>
          </div>
          <label class="ga-note" style="display:flex;gap:6px;cursor:pointer;">
            <input type="checkbox" class="ga-share" checked
              style="accent-color:rgb(${ACCENT});flex:none;" />
            <span class="ga-share-label">Let the agent read my saved
              profiles and presets</span>
          </label>
          <div class="ga-note">
            Answers come from your own agent, run headless on your
            machine: Claude Code on your subscription, Codex on your
            ChatGPT account, or Gemini on your Google account. No API
            key stored anywhere. Every agent reads the built-in Grid
            reference and, with the toggle, your saved configs in
            <span class="ga-code">grid-userdata</span>. Hover a reply to
            copy it; click a code block to copy the code.
          </div>
        </div>`;
      this.appendChild(root);

      this.log = root.querySelector(".ga-log");
      this.empty = root.querySelector(".ga-empty");
      this.input = root.querySelector(".ga-input");
      this.sendBtn = root.querySelector(".ga-send");
      this.status = root.querySelector(".ga-status");
      this.shareToggle = root.querySelector(".ga-share");
      this.shareLabel = root.querySelector(".ga-share-label");
      this.backendSel = root.querySelector(".ga-backend");
      this.blocksBox = root.querySelector(".ga-blocks");
      this.blocksList = root.querySelector(".ga-blocks-list");
      this.busy = false;
      this.current = null;
      this.cardSeq = 0;
      this.pendingCards = new Map();

      this.backendSel.addEventListener("change", () => {
        this.port?.postMessage({
          type: "set-backend",
          backend: this.backendSel.value,
        });
      });

      for (const chip of root.querySelectorAll(".ga-chip")) {
        chip.addEventListener("click", () => {
          this.input.value = chip.textContent.trim();
          this.autoGrow();
          this.input.focus();
        });
      }

      this.shareToggle.addEventListener("change", () => {
        this.port?.postMessage({
          type: "set-share-profiles",
          enabled: this.shareToggle.checked,
        });
      });
      root.querySelector(".ga-new").addEventListener("click", () => {
        this.port?.postMessage({ type: "chat-new" });
        for (const el of [...this.log.children]) {
          if (el !== this.empty) el.remove();
        }
        this.empty.style.display = "";
        this.finish("");
      });
      this.sendBtn.addEventListener("click", () => {
        if (this.busy) {
          this.port?.postMessage({ type: "chat-stop" });
        } else {
          this.send();
        }
      });
      this.input.addEventListener("input", () => this.autoGrow());
      this.input.addEventListener("keydown", (e) => {
        if (e.key === "Enter" && !e.shiftKey) {
          e.preventDefault();
          this.send();
        }
      });

      // Click-to-copy on code blocks - but never clobber a manual
      // text selection in progress.
      this.log.addEventListener("click", (e) => {
        const pre = e.target.closest?.("pre");
        if (!pre || String(window.getSelection?.() ?? "").length > 0) return;
        this.copyText(pre.textContent, "Code copied");
      });

      try {
        this.port = window.createPackageMessagePort(PKG, "grid-agent-chat");
        this.port.onmessage = (e) => this.onPortMessage(e.data);
        this.port.start?.();
      } catch (e) {
        this.status.textContent = "Package messaging unavailable.";
      }
    }

    autoGrow() {
      this.input.style.height = "auto";
      this.input.style.height = Math.min(this.input.scrollHeight, 120) + "px";
    }

    copyText(text, doneLabel) {
      navigator.clipboard?.writeText(text).then(
        () => this.flashStatus(doneLabel),
        () => this.flashStatus("Copy failed"),
      );
    }

    flashStatus(text) {
      const prev = this.busy ? null : this.status.innerHTML;
      this.status.textContent = text;
      clearTimeout(this._flashTimer);
      this._flashTimer = setTimeout(() => {
        if (!this.busy) this.status.innerHTML = prev ?? "";
      }, 1400);
    }

    nearBottom() {
      return (
        this.log.scrollTop + this.log.clientHeight >=
        this.log.scrollHeight - 48
      );
    }

    scrollDown(force) {
      if (force || this.nearBottom()) {
        this.log.scrollTop = this.log.scrollHeight;
      }
    }

    addMsg(kind, text) {
      this.empty.style.display = "none";
      const wrap = document.createElement("div");
      wrap.className = `ga-wrap ga-wrap-${kind === "user" ? "user" : "ai"}`;
      const el = document.createElement("div");
      el.className = `ga-msg ga-${kind}`;
      el.textContent = text;
      el._raw = text;
      wrap.appendChild(el);

      const copy = document.createElement("button");
      copy.className = "ga-copy";
      copy.textContent = "Copy";
      copy.addEventListener("click", (e) => {
        e.stopPropagation();
        this.copyText(el._raw ?? el.textContent, "Copied");
      });
      wrap.appendChild(copy);

      this.log.appendChild(wrap);
      this.scrollDown(true);
      return el;
    }

    // Turn grid-block fences in a finished answer into Apply cards.
    addProposalCards(raw, afterEl) {
      const re = /```grid-block[^\n]*\n([\s\S]*?)```/g;
      let m;
      let anchor = afterEl;
      while ((m = re.exec(raw))) {
        let block;
        try {
          block = JSON.parse(m[1]);
        } catch (e) {
          continue;
        }
        if (!block?.name || !block?.lua) continue;
        const card = document.createElement("div");
        card.className = "ga-card";
        const name = document.createElement("div");
        name.className = "ga-card-name";
        name.textContent = block.name;
        card.appendChild(name);
        if (block.where) {
          const where = document.createElement("div");
          where.className = "ga-card-where";
          where.textContent = `Goes on: ${block.where}`;
          card.appendChild(where);
        }
        const btn = document.createElement("button");
        btn.className = "ga-card-btn";
        btn.textContent = "Add to block palette";
        btn.addEventListener("click", () => {
          btn.disabled = true;
          btn.textContent = "Creating…";
          const requestId = ++this.cardSeq;
          this.pendingCards.set(requestId, card);
          this.port?.postMessage({ type: "create-block", requestId, block });
        });
        card.appendChild(btn);
        anchor.after(card);
        anchor = card;
      }
      this.scrollDown(true);
    }

    renderBlocksList(blocks) {
      if (!this.blocksBox) return;
      this.blocksBox.style.display = blocks?.length ? "" : "none";
      if (!blocks?.length) return;
      this.blocksList.textContent = "";
      for (const b of blocks) {
        const row = document.createElement("div");
        row.className = "ga-note ga-blocks-row";
        const label = document.createElement("span");
        label.textContent = b.name;
        const x = document.createElement("button");
        x.className = "ga-blocks-x";
        x.textContent = "✕";
        x.title = "Remove from palette";
        x.addEventListener("click", () => {
          this.port?.postMessage({ type: "delete-block", short: b.short });
        });
        row.appendChild(label);
        row.appendChild(x);
        this.blocksList.appendChild(row);
      }
    }

    send() {
      const prompt = this.input.value.trim();
      if (!prompt || this.busy) return;
      this.input.value = "";
      this.autoGrow();
      this.busy = true;
      this.sendBtn.textContent = "Stop";
      this.sendBtn.classList.add("ga-stop");
      this.addMsg("user", prompt);
      this.current = null;
      this.currentRaw = "";
      this.status.innerHTML =
        'Thinking<span class="ga-thinking"><i></i><i></i><i></i></span>';
      this.port?.postMessage({ type: "chat", prompt });
    }

    finish(statusText) {
      this.busy = false;
      this.sendBtn.textContent = "Send";
      this.sendBtn.classList.remove("ga-stop");
      this.status.textContent = statusText ?? "";
      this.current = null;
      this.currentRaw = "";
    }

    onPortMessage(msg) {
      if (!msg) return;
      if (msg.type === "chat-chunk") {
        if (!this.current) this.current = this.addMsg("ai", "");
        this.currentRaw = (this.currentRaw ?? "") + msg.text;
        this.current._raw = this.currentRaw;
        this.current.innerHTML = renderMarkdown(this.currentRaw);
        this.scrollDown(false);
      } else if (msg.type === "chat-done") {
        const raw = this.currentRaw;
        const anchor = this.current?.parentElement;
        this.finish(
          msg.stopped ? "Stopped." : msg.seconds ? `${msg.seconds}s` : "",
        );
        if (raw && anchor) this.addProposalCards(raw, anchor);
      } else if (msg.type === "chat-error") {
        const el = this.addMsg("ai", msg.message);
        el.classList.add("ga-error");
        this.finish();
      } else if (msg.type === "agent-status") {
        if (this.shareToggle) this.shareToggle.checked = !!msg.shareProfiles;
        if (this.shareLabel) {
          this.shareLabel.textContent = msg.profilesFound
            ? `Let the agent read my saved profiles and presets ` +
              `(${msg.profileCount} found)`
            : "No saved profiles found in grid-userdata";
        }
        this.renderBlocksList(msg.blocks);
        if (this.backendSel) {
          if (msg.backend) this.backendSel.value = msg.backend;
          const av = msg.backends ?? {};
          for (const opt of this.backendSel.options) {
            const ok = av[opt.value] !== false;
            opt.disabled = !ok;
            opt.textContent =
              opt.textContent.replace(" (not installed)", "") +
              (ok ? "" : " (not installed)");
          }
        }
      } else if (msg.type === "chat-login-needed") {
        const backend = msg.backend ?? "claude";
        const guides = {
          claude:
            "Claude Code is not signed in yet. One click opens a " +
            "terminal with the CLI: type /login there, pick the " +
            "subscription sign-in, then ask again.",
          codex:
            "Codex is not signed in yet. One click opens the ChatGPT " +
            "sign-in in your browser; finish it there and ask again.",
          gemini:
            "Gemini is not signed in yet. Open a terminal, run gemini " +
            "and complete the Google sign-in. Then ask again.",
        };
        const el = this.addMsg("ai", guides[backend]);
        el.classList.add("ga-error");
        if (backend !== "gemini") {
          const btn = document.createElement("button");
          btn.className = "ga-chip";
          btn.style.marginTop = "6px";
          btn.textContent =
            backend === "codex" ? "Sign in with ChatGPT" : "Open Claude sign-in";
          btn.addEventListener("click", () => {
            btn.disabled = true;
            btn.textContent = "Waiting for sign-in…";
            this.port?.postMessage({ type: "backend-login", backend });
          });
          el.appendChild(document.createElement("br"));
          el.appendChild(btn);
        }
        this.finish();
      } else if (msg.type === "block-created") {
        const card = this.pendingCards.get(msg.requestId);
        this.pendingCards.delete(msg.requestId);
        if (card) {
          const btn = card.querySelector(".ga-card-btn");
          if (msg.ok) {
            btn.disabled = true;
            btn.textContent = "Added";
            const hint = document.createElement("div");
            hint.className = "ga-card-where";
            hint.style.marginTop = "6px";
            hint.textContent =
              (msg.where ? `Select ${msg.where}, ` : "Select the event, ") +
              "click + to add an action, and pick it from the top of the " +
              "list (or search its name). Then Store.";
            card.appendChild(hint);
          } else {
            btn.textContent = "Could not create";
          }
        }
      } else if (msg.type === "login-result") {
        if (msg.ok === true) {
          this.flashStatus("Signed in - ask again");
        } else if (msg.ok === false) {
          this.flashStatus("Sign-in did not complete");
        }
        for (const b of this.log.querySelectorAll("button.ga-chip[disabled]")) {
          b.disabled = false;
          b.textContent =
            msg.backend === "codex"
              ? "Sign in with ChatGPT"
              : "Open Claude sign-in";
        }
      }
    }
  }

  if (!customElements.get("grid-agent-chat")) {
    customElements.define("grid-agent-chat", GridAgentChat);
  }
  if (!customElements.get("grid-agent-block")) {
    customElements.define("grid-agent-block", GridAgentBlock);
  }
})();
