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

    /* Setup guide ------------------------------------------------------ */
    .ga-setup { display:flex; flex-direction:column; gap:10px;
      min-height:260px; max-height:440px; overflow-y:auto;
      padding:4px 2px; }
    .ga-setup::-webkit-scrollbar { width:6px; }
    .ga-setup::-webkit-scrollbar-thumb { background:rgba(255,255,255,0.12);
      border-radius:3px; }
    .ga-setup-head { display:flex; justify-content:space-between;
      align-items:center; gap:8px; }
    .ga-setup-title { font-weight:600; }
    .ga-path { display:flex; flex-direction:column; gap:2px; width:100%;
      text-align:left; padding:9px 12px; border-radius:8px; cursor:pointer;
      color:var(--foreground,#ededed); background:rgba(255,255,255,0.04);
      border:1px solid rgba(255,255,255,0.14); }
    .ga-path:hover { border-color:rgba(${ACCENT},0.5);
      background:rgba(${ACCENT},0.07); }
    .ga-path b { font-size:12px; }
    .ga-path span { font-size:11px;
      color:var(--foreground-muted,#9d9d9d); line-height:1.45; }
    .ga-step { display:flex; gap:10px; align-items:flex-start;
      border:1px solid rgba(255,255,255,0.1); border-radius:8px;
      padding:9px 11px; }
    .ga-step-done { border-color:rgba(${ACCENT},0.45); }
    .ga-step-dot { flex:none; width:20px; height:20px; border-radius:50%;
      display:flex; align-items:center; justify-content:center;
      font-size:11px; font-weight:600; margin-top:1px;
      color:var(--foreground-muted,#9d9d9d);
      border:1px solid rgba(255,255,255,0.25); }
    .ga-step-done .ga-step-dot { color:#0d1f19; border-color:transparent;
      background:rgba(${ACCENT},0.9); }
    .ga-step-main { display:flex; flex-direction:column; gap:5px;
      min-width:0; flex:1; }
    .ga-step-title { font-weight:600; }
    .ga-step-body { font-size:11px; line-height:1.5;
      color:var(--foreground-muted,#c4c4c4); white-space:pre-wrap; }
    .ga-step-done .ga-step-body { color:var(--foreground-muted,#9d9d9d); }
    .ga-cmd { display:flex; gap:6px; align-items:center; }
    .ga-cmd code { flex:1; min-width:0; overflow-x:auto;
      background:rgba(0,0,0,0.35); border:1px solid rgba(255,255,255,0.1);
      border-radius:6px; padding:6px 9px; white-space:nowrap;
      user-select:text !important; -webkit-user-select:text !important; }
    .ga-step-row { display:flex; gap:6px; flex-wrap:wrap;
      align-items:center; }
    .ga-model-btn { max-width:100%; overflow:hidden;
      text-overflow:ellipsis; }
    .ga-setup-ok { color:rgb(${ACCENT}); font-size:11px; }
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
        const tag = lang.trim();
        blocks.push(
          /^grid-block/.test(tag)
            ? `<div class="ga-proposal">Block proposal - Apply card below</div>`
            : /^grid-profile/.test(tag)
              ? `<div class="ga-proposal">Profile proposal - Save card below</div>`
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
            <div class="ga-empty-title">Ask Tao Gunka about blocks,
              Lua, or your saved configs. Answers come from your own
              agent, on your machine.</div>
            <button class="ga-chip ga-setup-open"
              style="border-color:rgba(${ACCENT},0.55);">First time
              here? Set up your assistant step by step</button>
            ${STARTERS.map(
              (s) => `<button class="ga-chip">${s}</button>`,
            ).join("")}
          </div>
        </div>
        <div class="ga-setup" style="display:none;"></div>
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
            <option value="local">Local (Ollama / Kobold)</option>
          </select>
          <div class="ga-status" style="flex:1;margin:0 8px;"></div>
          <button class="ga-new ga-setup-btn"
            title="Step-by-step agent setup">Setup</button>
          <button class="ga-new">New chat</button>
        </div>
        <div class="ga-local" style="display:none;gap:6px;">
          <input class="ga-input ga-local-url" type="text"
            placeholder="http://localhost:11434/v1"
            title="OpenAI-compatible server URL" />
          <input class="ga-input ga-local-model" type="text"
            style="max-width:130px;"
            placeholder="model (Ollama)"
            title="Model name; Kobold ignores it" />
        </div>
        <div class="ga-footer">
          <div class="ga-blocks" style="display:none;">
            <div class="ga-blocks-row">
              <div class="ga-note" style="font-weight:600;">Assistant blocks
                in your palette</div>
              <button class="ga-blocks-x ga-blocks-clear">Clear all</button>
            </div>
            <div class="ga-blocks-list"></div>
          </div>
          <label class="ga-note" style="display:flex;gap:6px;cursor:pointer;">
            <input type="checkbox" class="ga-share" checked
              style="accent-color:rgb(${ACCENT});flex:none;" />
            <span class="ga-share-label">Let the agent read my saved
              profiles and presets</span>
          </label>
          <div class="ga-note">
            Answers come from your own agent, run on your machine:
            Claude Code on your subscription, Codex on your ChatGPT
            account, or any local OpenAI-compatible server (Ollama,
            KoboldCpp, LM Studio). No API key stored anywhere. Agents
            read the built-in Grid reference and, with the toggle, your
            saved configs in <span class="ga-code">grid-userdata</span>
            (local models get the reference pushed instead; they cannot
            open files). Hover a reply to copy it; click a code block
            to copy the code.
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

      this.setupBox = root.querySelector(".ga-setup");
      this.composer = root.querySelector(".ga-composer");
      this.setupOpen = false;
      this.setupPath = null;
      this.lastStatus = null;
      this.lastProbe = null;
      root
        .querySelector(".ga-setup-open")
        .addEventListener("click", () => this.openSetup());
      root
        .querySelector(".ga-setup-btn")
        .addEventListener("click", () =>
          this.setupOpen ? this.closeSetup() : this.openSetup(),
        );

      this.localBox = root.querySelector(".ga-local");
      this.localUrl = root.querySelector(".ga-local-url");
      this.localModel = root.querySelector(".ga-local-model");
      const pushLocalConfig = () => {
        this.port?.postMessage({
          type: "set-local-config",
          url: this.localUrl.value,
          model: this.localModel.value,
        });
      };
      this.localUrl.addEventListener("change", pushLocalConfig);
      this.localModel.addEventListener("change", pushLocalConfig);

      this.backendSel.addEventListener("change", () => {
        this.localBox.style.display =
          this.backendSel.value === "local" ? "flex" : "none";
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
      const clearBtn = root.querySelector(".ga-blocks-clear");
      clearBtn.addEventListener("click", () => {
        if (clearBtn.dataset.armed) {
          delete clearBtn.dataset.armed;
          clearBtn.textContent = "Clear all";
          this.port?.postMessage({ type: "clear-blocks" });
        } else {
          clearBtn.dataset.armed = "1";
          clearBtn.textContent = "Really remove all?";
          setTimeout(() => {
            delete clearBtn.dataset.armed;
            clearBtn.textContent = "Clear all";
          }, 3000);
        }
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

    // Turn grid-profile fences in a finished answer into Save cards.
    addProfileCards(raw, afterEl) {
      const re = /```grid-profile[^\n]*\n([\s\S]*?)```/g;
      let m;
      let anchor = afterEl;
      while ((m = re.exec(raw))) {
        let profile;
        try {
          profile = JSON.parse(m[1]);
        } catch (e) {
          continue;
        }
        if (!profile?.name || !profile?.module || !profile?.elements) continue;
        const card = document.createElement("div");
        card.className = "ga-card";
        const name = document.createElement("div");
        name.className = "ga-card-name";
        name.textContent = `Profile: ${profile.name} (${profile.module})`;
        card.appendChild(name);
        const info = document.createElement("div");
        info.className = "ga-card-where";
        const els = Object.keys(profile.elements ?? {}).length;
        info.textContent =
          `Configures ${els} element${els === 1 ? "" : "s"}. Loading a ` +
          `profile replaces the module's whole current config.`;
        card.appendChild(info);
        const row = document.createElement("div");
        row.className = "ga-step-row";
        const btn = document.createElement("button");
        btn.className = "ga-card-btn";
        btn.textContent = "Save to my profiles";
        btn.addEventListener("click", () => {
          btn.disabled = true;
          btn.textContent = "Saving…";
          const requestId = ++this.cardSeq;
          this.pendingCards.set(requestId, card);
          this.port?.postMessage({ type: "create-profile", requestId, profile });
        });
        row.appendChild(btn);
        const tryBtn = document.createElement("button");
        tryBtn.className = "ga-chip";
        tryBtn.textContent = "Try now (until power off)";
        tryBtn.title =
          "Experimental: pushes the behavior into the module's memory " +
          "without storing it";
        tryBtn.addEventListener("click", () => {
          tryBtn.disabled = true;
          tryBtn.textContent = "Trying…";
          const requestId = ++this.cardSeq;
          this.pendingCards.set(requestId, card);
          this.port?.postMessage({
            type: "tryout-profile",
            requestId,
            profile,
          });
        });
        row.appendChild(tryBtn);
        card.appendChild(row);
        anchor.after(card);
        anchor = card;
      }
      return anchor;
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

    // --- Setup guide --------------------------------------------------
    // Three hand-holding paths; every step shows plain words, one
    // action, and a live checkmark driven by the package's real
    // environment checks. The last step of each path sends an actual
    // chat, so "it works" means the real thing answered.

    openSetup(path) {
      this.setupOpen = true;
      this.setupPath = path ?? this.setupPath;
      this.log.style.display = "none";
      this.composer.style.display = "none";
      this.setupBox.style.display = "flex";
      this.port?.postMessage({ type: "request-status" });
      this.renderSetup();
    }

    closeSetup() {
      this.setupOpen = false;
      this.setupBox.style.display = "none";
      this.log.style.display = "";
      this.composer.style.display = "";
    }

    setupTerminalHint() {
      const p = this.lastStatus?.platform;
      if (p === "darwin") {
        return "Open Terminal (press Cmd+Space, type Terminal, press Enter).";
      }
      if (p === "linux") {
        return "Open a terminal window.";
      }
      return (
        "Press the Windows key, type cmd, press Enter - a black " +
        "window opens."
      );
    }

    setupSteps() {
      const s = this.lastStatus;
      const paste =
        this.lastStatus?.platform === "win32"
          ? "right-click pastes it"
          : "paste it";
      if (this.setupPath === "claude") {
        return {
          label: "Claude (your Claude subscription)",
          backend: "claude",
          steps: [
            {
              title: "Get Claude Code onto this computer",
              body:
                "If you already use the Claude desktop app, this step is " +
                "already done and shows a checkmark. If not: open your " +
                "web browser, go to the address below, install the " +
                "Claude desktop app and start it once.",
              link: "claude.ai/download",
              done: !!s?.backends?.claude,
              recheck: true,
            },
            {
              title: "Sign in once with your subscription",
              body:
                "Click the button. A terminal window opens with Claude " +
                "Code running in it. Type /login and press Enter, choose " +
                "the Claude account option (not the API key one), and " +
                "finish the sign-in in the browser page that opens. Then " +
                "close the terminal and come back here.",
              action: {
                label: "Open Claude sign-in",
                msg: { type: "backend-login", backend: "claude" },
              },
              verify: true,
            },
            { test: true },
          ],
        };
      }
      if (this.setupPath === "codex") {
        return {
          label: "ChatGPT (your ChatGPT subscription)",
          backend: "codex",
          steps: [
            {
              title: "Install Node.js, one time",
              body:
                "Codex, the ChatGPT agent, needs Node.js to run. Open " +
                "your web browser, go to the address below, click the " +
                "big green LTS button, run the installer and click " +
                "through it - the standard options are fine.",
              link: "nodejs.org",
              done: !!s?.npmFound,
              recheck: true,
            },
            {
              title: "Install Codex, one time",
              body:
                this.setupTerminalHint() +
                " Copy the command below, " +
                paste +
                ", press Enter and wait until it finishes. Then click " +
                "Check again.",
              copy: "npm install -g @openai/codex",
              done: !!s?.backends?.codex,
              recheck: true,
            },
            {
              title: "Sign in with your ChatGPT account",
              body:
                "Click the button. Your browser opens the ChatGPT " +
                "sign-in; use the account that has your subscription " +
                "and approve. This panel notices on its own when the " +
                "sign-in completes.",
              action: {
                label: "Sign in with ChatGPT",
                msg: { type: "backend-login", backend: "codex" },
              },
            },
            { test: true },
          ],
        };
      }
      if (this.setupPath === "local") {
        return {
          label: "Local model (free, private, no account)",
          backend: "local",
          steps: [
            {
              title: "Install Ollama",
              body:
                "Ollama is a free program that runs AI models on your " +
                "own computer. Open your web browser, go to the address " +
                "below, download it for your system and run the " +
                "installer.",
              link: "ollama.com",
              done: this.lastProbe?.ok === true,
              probe: true,
            },
            {
              title: "Download a model, one time",
              body:
                this.setupTerminalHint() +
                " Copy the command below, " +
                paste +
                " and press Enter. It downloads about 8 GB once. When " +
                "it finishes, click Check my local server - your " +
                "models appear below, click one to use it.",
              copy: "ollama pull gemma4:12b",
              probe: true,
              models: true,
              done:
                this.lastProbe?.ok === true &&
                (this.lastProbe?.models?.length ?? 0) > 0 &&
                !!this.lastStatus?.localModel,
            },
            { test: true },
          ],
        };
      }
      return null;
    }

    renderSetup() {
      const box = this.setupBox;
      box.textContent = "";
      const head = document.createElement("div");
      head.className = "ga-setup-head";
      const title = document.createElement("div");
      title.className = "ga-setup-title";
      const back = document.createElement("button");
      back.className = "ga-new";
      head.appendChild(title);
      head.appendChild(back);
      box.appendChild(head);

      const def = this.setupSteps();
      if (!def) {
        // Path chooser.
        title.textContent = "Which subscription do you want to use?";
        back.textContent = "Close";
        back.addEventListener("click", () => this.closeSetup());
        const paths = [
          {
            id: "claude",
            name: "Claude",
            desc:
              "You pay for Claude (Pro or Max). Uses the Claude " +
              "desktop app you may already have. Recommended.",
          },
          {
            id: "codex",
            name: "ChatGPT",
            desc:
              "You pay for ChatGPT (Plus or Pro). Two one-time " +
              "installs, then sign in with your account.",
          },
          {
            id: "local",
            name: "Local model",
            desc:
              "No subscription, no account, nothing leaves this " +
              "computer. Needs a decent graphics card to feel quick.",
          },
        ];
        for (const p of paths) {
          const btn = document.createElement("button");
          btn.className = "ga-path";
          const b = document.createElement("b");
          b.textContent = p.name;
          const span = document.createElement("span");
          span.textContent = p.desc;
          btn.appendChild(b);
          btn.appendChild(span);
          btn.addEventListener("click", () => {
            this.setupPath = p.id;
            const backend = p.id;
            this.backendSel.value = backend;
            this.port?.postMessage({ type: "set-backend", backend });
            if (p.id === "local") {
              this.port?.postMessage({ type: "probe-local" });
            }
            this.renderSetup();
          });
          box.appendChild(btn);
        }
        return;
      }

      title.textContent = def.label;
      back.textContent = "Back";
      back.addEventListener("click", () => {
        this.setupPath = null;
        this.renderSetup();
      });

      def.steps.forEach((step, i) => {
        const row = document.createElement("div");
        row.className = "ga-step" + (step.done ? " ga-step-done" : "");
        const dot = document.createElement("div");
        dot.className = "ga-step-dot";
        dot.textContent = step.done ? "✓" : String(i + 1);
        row.appendChild(dot);
        const main = document.createElement("div");
        main.className = "ga-step-main";
        row.appendChild(main);

        if (step.test) {
          const t = document.createElement("div");
          t.className = "ga-step-title";
          t.textContent = "Try it";
          main.appendChild(t);
          const b = document.createElement("div");
          b.className = "ga-step-body";
          b.textContent =
            "Click the button. The guide closes and a real question " +
            "goes to your assistant; the answer appears in the chat. " +
            "If it asks you to sign in instead, use the sign-in " +
            "button it shows and try once more.";
          main.appendChild(b);
          const btn = document.createElement("button");
          btn.className = "ga-card-btn";
          btn.textContent = "Send a test question";
          btn.addEventListener("click", () => {
            this.backendSel.value = def.backend;
            this.port?.postMessage({
              type: "set-backend",
              backend: def.backend,
            });
            this.closeSetup();
            this.input.value =
              "Answer with one short line: are you connected and ready " +
              "to help with my Grid?";
            this.send();
          });
          main.appendChild(btn);
          box.appendChild(row);
          return;
        }

        const t = document.createElement("div");
        t.className = "ga-step-title";
        t.textContent = step.title;
        main.appendChild(t);
        const b = document.createElement("div");
        b.className = "ga-step-body";
        b.textContent = step.body;
        main.appendChild(b);

        if (step.link) {
          const cmd = document.createElement("div");
          cmd.className = "ga-cmd";
          const code = document.createElement("code");
          code.textContent = step.link;
          cmd.appendChild(code);
          const cp = document.createElement("button");
          cp.className = "ga-new";
          cp.textContent = "Copy address";
          cp.addEventListener("click", () =>
            this.copyText(step.link, "Address copied"),
          );
          cmd.appendChild(cp);
          main.appendChild(cmd);
        }
        if (step.copy) {
          const cmd = document.createElement("div");
          cmd.className = "ga-cmd";
          const code = document.createElement("code");
          code.textContent = step.copy;
          cmd.appendChild(code);
          const cp = document.createElement("button");
          cp.className = "ga-new";
          cp.textContent = "Copy command";
          cp.addEventListener("click", () =>
            this.copyText(step.copy, "Command copied"),
          );
          cmd.appendChild(cp);
          main.appendChild(cmd);
        }

        const actions = document.createElement("div");
        actions.className = "ga-step-row";
        if (step.action) {
          const btn = document.createElement("button");
          btn.className = "ga-card-btn";
          btn.textContent = step.action.label;
          btn.addEventListener("click", () => {
            btn.disabled = true;
            btn.textContent = "Waiting…";
            this.port?.postMessage(step.action.msg);
            setTimeout(() => {
              btn.disabled = false;
              btn.textContent = step.action.label;
            }, 60000);
          });
          actions.appendChild(btn);
        }
        if (step.recheck && !step.done) {
          const btn = document.createElement("button");
          btn.className = "ga-chip";
          btn.textContent = "Check again";
          btn.addEventListener("click", () => {
            this.port?.postMessage({ type: "setup-recheck" });
          });
          actions.appendChild(btn);
        }
        if (step.verify) {
          const btn = document.createElement("button");
          btn.className = "ga-chip";
          btn.textContent = "Check sign-in";
          btn.addEventListener("click", () => {
            // The verdict lands in the chat, where there is room for
            // the diagnosis; close the guide so it is visible.
            this.closeSetup();
            this.port?.postMessage({ type: "verify-login" });
          });
          actions.appendChild(btn);
        }
        if (step.probe) {
          const btn = document.createElement("button");
          btn.className = "ga-chip";
          btn.textContent = "Check my local server";
          btn.addEventListener("click", () => {
            this.port?.postMessage({ type: "probe-local" });
          });
          actions.appendChild(btn);
          if (this.lastProbe && !this.lastProbe.ok) {
            const warn = document.createElement("span");
            warn.className = "ga-step-body";
            warn.textContent = "Not reachable yet.";
            actions.appendChild(warn);
          }
        }
        if (actions.childNodes.length) main.appendChild(actions);

        if (step.models && this.lastProbe?.models?.length) {
          const list = document.createElement("div");
          list.className = "ga-step-row";
          for (const name of this.lastProbe.models) {
            const btn = document.createElement("button");
            btn.className = "ga-chip ga-model-btn";
            const picked = this.lastStatus?.localModel === name;
            btn.textContent = (picked ? "✓ " : "") + name;
            btn.addEventListener("click", () => {
              this.localModel.value = name;
              this.port?.postMessage({
                type: "set-local-config",
                url: this.localUrl.value || this.lastStatus?.localUrl || "",
                model: name,
              });
              this.port?.postMessage({ type: "request-status" });
            });
            list.appendChild(btn);
          }
          main.appendChild(list);
        }

        box.appendChild(row);
      });
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
        if (raw && anchor) {
          const last = this.addProfileCards(raw, anchor);
          this.addProposalCards(raw, last);
        }
      } else if (msg.type === "chat-error") {
        const el = this.addMsg("ai", msg.message);
        el.classList.add("ga-error");
        this.finish();
      } else if (msg.type === "login-verify") {
        if (this._verifyBtn) {
          this._verifyBtn.disabled = false;
          this._verifyBtn.textContent = "Check sign-in";
          this._verifyBtn = null;
        }
        const el = this.addMsg(
          "ai",
          msg.ok
            ? `Sign-in verified. ${msg.detail ?? ""}`
            : `Still not signed in for this panel.\nCLI: ${msg.cliPath}\n` +
              `It said: ${msg.detail ?? "(nothing)"}\n` +
              "If you signed in with a different Claude install, run " +
              "/login once in the exact CLI shown above (the sign-in " +
              "button opens it). On a Mac, if a Keychain permission " +
              "window appears anywhere, choose Always Allow.",
        );
        if (!msg.ok) el.classList.add("ga-error");
        this.scrollDown(true);
      } else if (msg.type === "local-probe") {
        this.lastProbe = msg;
        if (this.setupOpen) this.renderSetup();
      } else if (msg.type === "agent-status") {
        this.lastStatus = msg;
        if (this.setupOpen) this.renderSetup();
        if (this.shareToggle) this.shareToggle.checked = !!msg.shareProfiles;
        if (this.shareLabel) {
          this.shareLabel.textContent = msg.profilesFound
            ? `Let the agent read my saved profiles and presets ` +
              `(${msg.profileCount} found)`
            : "No saved profiles found in grid-userdata";
        }
        this.renderBlocksList(msg.blocks);
        if (this.localUrl && msg.localUrl !== undefined) {
          if (document.activeElement !== this.localUrl) {
            this.localUrl.value = msg.localUrl;
          }
          if (document.activeElement !== this.localModel) {
            this.localModel.value = msg.localModel ?? "";
          }
        }
        if (this.localBox && msg.backend) {
          this.localBox.style.display =
            msg.backend === "local" ? "flex" : "none";
        }
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
        if (backend === "claude" && msg.cliPath) {
          const p = document.createElement("div");
          p.className = "ga-note ga-code";
          p.style.marginTop = "4px";
          p.textContent = `Using: ${msg.cliPath}`;
          el.appendChild(p);
        }
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
          if (backend === "claude") {
            const vb = document.createElement("button");
            vb.className = "ga-chip";
            vb.style.marginTop = "6px";
            vb.style.marginLeft = "6px";
            vb.textContent = "Check sign-in";
            vb.addEventListener("click", () => {
              vb.disabled = true;
              vb.textContent = "Checking (up to a minute)…";
              this._verifyBtn = vb;
              this.port?.postMessage({ type: "verify-login" });
            });
            el.appendChild(vb);
          }
        }
        this.finish();
      } else if (msg.type === "chat-history") {
        // Restore the conversation after an editor restart; only into
        // an untouched log, so reconnects never duplicate it.
        if (!this.log.querySelector(".ga-wrap") && msg.turns?.length) {
          for (const turn of msg.turns) {
            this.addMsg("user", turn.q);
            const el = this.addMsg("ai", "");
            el._raw = turn.a;
            el.innerHTML = renderMarkdown(turn.a);
          }
          this.scrollDown(true);
        }
      } else if (msg.type === "profile-created") {
        const card = this.pendingCards.get(msg.requestId);
        this.pendingCards.delete(msg.requestId);
        if (card) {
          const btn = card.querySelector(".ga-card-btn");
          if (msg.ok) {
            btn.disabled = true;
            btn.textContent = "Saved";
            const hint = document.createElement("div");
            hint.className = "ga-card-where";
            hint.style.marginTop = "6px";
            hint.textContent =
              `Saved as "${msg.filename}". Open your profile list, ` +
              `select the ${msg.module}, load "${msg.name}" onto it, ` +
              "and Store. This replaces the module's current config.";
            card.appendChild(hint);
          } else {
            btn.disabled = false;
            btn.textContent = "Save to my profiles";
            const err = document.createElement("div");
            err.className = "ga-card-where";
            err.style.marginTop = "6px";
            err.textContent = `Could not save: ${msg.error ?? "unknown"}`;
            card.appendChild(err);
          }
        }
      } else if (msg.type === "profile-tryout") {
        const card = this.pendingCards.get(msg.requestId);
        this.pendingCards.delete(msg.requestId);
        if (card) {
          const tryBtn = card.querySelector("button.ga-chip");
          const hint = document.createElement("div");
          hint.className = "ga-card-where";
          hint.style.marginTop = "6px";
          if (msg.ok) {
            if (tryBtn) tryBtn.textContent = "Sent to the module";
            hint.textContent =
              `Pushed ${msg.applied} event handler${msg.applied === 1 ? "" : "s"} ` +
              `into the ${msg.module}'s memory (experimental). Play with ` +
              "it now - this lasts until the module powers off and does " +
              "not touch the stored config. If nothing changed, this " +
              "firmware may not allow it; Save and load instead. Make it " +
              "permanent with Save, then load and Store.";
          } else {
            if (tryBtn) {
              tryBtn.disabled = false;
              tryBtn.textContent = "Try now (until power off)";
            }
            hint.textContent = `Could not try: ${msg.error ?? "unknown"}`;
          }
          card.appendChild(hint);
        }
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
