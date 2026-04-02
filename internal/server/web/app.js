// Go Call Graph - Interactive Source Code Analyzer
// Main view: Force-directed call graph | Right panel: Code + Info

const App = {
  state: {
    currentFuncId: null,
    currentFile: null,
    highlights: null,       // {callers:[], current:'', callees:[]}
    bookmarks: {},
    muted: [],
    bookmarkChainMode: false,
    cache: {},
    graphData: null,        // kept for API compat
    stdlibIds: new Set(),   // set of known stdlib function IDs
    history: [],            // navigation history [{type, filePath, line, funcId}]
    historyIdx: -1,         // current position in history
    _navigating: false,     // flag to suppress history push during back/forward
    locateMode: false,      // when true, clicking code lines focuses the graph node
    userFolds: {},          // { filePath: [{start, end}] } — user-defined fold ranges
    foldStart: null,        // line number of pending fold start (temporary)
  },

  async init() {
    this.loadLocalState();
    this.bindEvents();
    this.chain.init();
    await this.tree.load();
    this.mute.renderList();
    this.bookmarks.renderList();
  },

  // ---- Persistence ----
  loadLocalState() {
    try {
      const bm = localStorage.getItem('gcg-bookmarks');
      if (bm) {
        const parsed = JSON.parse(bm);
        // Migrate old format: { "pkg.Func": { note, addedAt } } → new format
        const migrated = {};
        let needsMigration = false;
        for (const [key, val] of Object.entries(parsed)) {
          if (val.type === 'line' || val.type === 'func') {
            migrated[key] = val; // already new format
          } else {
            needsMigration = true;
            migrated['func:' + key] = { type: 'func', funcId: key, label: val.note || '', addedAt: val.addedAt || new Date().toISOString() };
          }
        }
        this.state.bookmarks = migrated;
        if (needsMigration) this.saveLocalState();
      }
    } catch {}
    try { const mt = localStorage.getItem('gcg-muted'); if (mt) this.state.muted = JSON.parse(mt); } catch {}
    if (this.state.muted.length === 0) {
      this.state.muted = [
        { type: 'stdlib', pattern: '*', builtin: true },
      ];
      this.saveLocalState();
    }
  },

  saveLocalState() {
    localStorage.setItem('gcg-bookmarks', JSON.stringify(this.state.bookmarks));
    localStorage.setItem('gcg-muted', JSON.stringify(this.state.muted));
  },

  // ---- Events ----
  bindEvents() {
    // Left panel tabs
    document.querySelectorAll('.panel-tabs .tab').forEach(tab => {
      tab.addEventListener('click', () => {
        document.querySelectorAll('.panel-tabs .tab').forEach(t => t.classList.remove('active'));
        document.querySelectorAll('.tab-content').forEach(c => c.classList.remove('active'));
        tab.classList.add('active');
        document.getElementById('tab-' + tab.dataset.tab).classList.add('active');
      });
    });

    // Right panel tabs
    document.querySelectorAll('.right-tabs .rtab').forEach(tab => {
      tab.addEventListener('click', () => {
        document.querySelectorAll('.right-tabs .rtab').forEach(t => t.classList.remove('active'));
        document.querySelectorAll('.rtab-content').forEach(c => c.classList.remove('active'));
        tab.classList.add('active');
        document.getElementById('rtab-' + tab.dataset.rtab).classList.add('active');
      });
    });

    // Search
    const searchInput = document.getElementById('search-input');
    let searchTimeout;
    searchInput.addEventListener('input', () => {
      clearTimeout(searchTimeout);
      searchTimeout = setTimeout(() => this.search.run(searchInput.value), 200);
    });
    searchInput.addEventListener('blur', () => {
      setTimeout(() => document.getElementById('search-results').classList.add('hidden'), 200);
    });

    // Keyboard
    document.addEventListener('keydown', (e) => {
      if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') {
        if (e.key === 'Escape') e.target.blur();
        return;
      }
      if ((e.altKey || e.metaKey) && e.key === 'ArrowLeft') {
        e.preventDefault(); this.navBack(); return;
      }
      if ((e.altKey || e.metaKey) && e.key === 'ArrowRight') {
        e.preventDefault(); this.navForward(); return;
      }
      if (e.key === 'Escape') {
        if (this.state.foldStart !== null) {
          this.state.foldStart = null;
          this.codeView.render();
          return;
        }
        this.chain.clearHighlights();
        document.getElementById('search-results').classList.add('hidden');
        document.getElementById('context-menu').classList.add('hidden');
      } else if (e.key === '/' || (e.key === 'f' && (e.metaKey || e.ctrlKey))) {
        e.preventDefault();
        searchInput.focus();
      } else if (e.key === 'b' && this.state.currentFuncId) {
        this.bookmarks.toggleFunc(this.state.currentFuncId);
      } else if (e.key === 'm' && this.state.currentFuncId) {
        this.mute.addFunc(this.state.currentFuncId);
      }
    });

    document.addEventListener('click', () => {
      document.getElementById('context-menu').classList.add('hidden');
    });

    // Navigation back/forward
    document.getElementById('nav-back').addEventListener('click', () => this.navBack());
    document.getElementById('nav-forward').addEventListener('click', () => this.navForward());

    // Resize handle for right panel
    const resizeHandle = document.getElementById('resize-handle');
    const appEl = document.getElementById('app');
    const rightPanel = document.getElementById('right-panel');
    let resizing = false;
    resizeHandle.addEventListener('mousedown', (e) => {
      e.preventDefault();
      resizing = true;
      resizeHandle.classList.add('active');
      document.body.style.cursor = 'col-resize';
      document.body.style.userSelect = 'none';
    });
    document.addEventListener('mousemove', (e) => {
      if (!resizing) return;
      const newWidth = Math.max(200, Math.min(window.innerWidth - 400, window.innerWidth - e.clientX));
      appEl.style.setProperty('--right-panel-width', newWidth + 'px');
    });
    document.addEventListener('mouseup', () => {
      if (!resizing) return;
      resizing = false;
      resizeHandle.classList.remove('active');
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
    });

    // Code-internal search
    const codeSearchInput = document.getElementById('code-search-input');
    let codeSearchTimeout;
    codeSearchInput.addEventListener('input', () => {
      clearTimeout(codeSearchTimeout);
      codeSearchTimeout = setTimeout(() => this.codeView.fileSearch(codeSearchInput.value), 200);
    });
    codeSearchInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); if (e.shiftKey) this.codeView.fileSearchPrev(); else this.codeView.fileSearchNext(); }
      if (e.key === 'Escape') { codeSearchInput.value = ''; this.codeView.clearSearch(); codeSearchInput.blur(); }
    });

    // Locate mode toggle
    document.getElementById('locate-toggle').addEventListener('click', (e) => {
      const btn = e.currentTarget;
      this.state.locateMode = !this.state.locateMode;
      btn.classList.toggle('active', this.state.locateMode);
      document.getElementById('code-view').classList.toggle('locate-mode', this.state.locateMode);
    });

    // Word wrap toggle
    document.getElementById('wrap-toggle').addEventListener('click', (e) => {
      const btn = e.currentTarget;
      btn.classList.toggle('active');
      document.getElementById('code-view').classList.toggle('word-wrap');
    });

    // Outline toggle
    document.getElementById('outline-toggle').addEventListener('click', (e) => {
      const btn = e.currentTarget;
      const panel = document.getElementById('code-outline');
      btn.classList.toggle('active');
      panel.classList.toggle('hidden');
      localStorage.setItem('gcg-outline', panel.classList.contains('hidden') ? '0' : '1');
      if (!panel.classList.contains('hidden')) {
        this.codeView.updateOutlineActive();
      }
    });

    // Restore outline state from localStorage
    if (localStorage.getItem('gcg-outline') === '1') {
      document.getElementById('outline-toggle').classList.add('active');
      document.getElementById('code-outline').classList.remove('hidden');
    }

    // Set up scroll tracking for outline
    this.codeView.trackScrollForOutline();

    // Toolbar
    document.getElementById('fit-btn').addEventListener('click', () => this.chain.fitToView());
    document.getElementById('chain-reset-btn').addEventListener('click', () => this.chain.reset());

    // Bookmark chain
    document.getElementById('bookmark-chain-btn').addEventListener('click', (e) => {
      this.state.bookmarkChainMode = !this.state.bookmarkChainMode;
      e.target.classList.toggle('active', this.state.bookmarkChainMode);
      if (this.state.bookmarkChainMode) this.bookmarks.showChain();
      else this.chain.clearHighlights();
    });

    // Context menu actions
    document.querySelectorAll('.ctx-item').forEach(item => {
      item.addEventListener('click', (e) => {
        e.stopPropagation();
        const action = item.dataset.action;
        const funcId = document.getElementById('context-menu').dataset.funcId;
        if (action === 'mute-func') this.mute.addFunc(funcId);
        else if (action === 'mute-pkg') this.mute.addPackage(funcId);
        else if (action === 'bookmark') this.bookmarks.toggleFunc(funcId);
        document.getElementById('context-menu').classList.add('hidden');
      });
    });

    document.getElementById('add-mute-btn').addEventListener('click', () => {
      const pattern = prompt('Enter mute pattern (e.g., "middleware.*", "log"):');
      if (pattern) {
        this.state.muted.push({ type: 'pattern', pattern });
        this.saveLocalState();
        this.mute.renderList();
        this.chain.reloadCurrent();
      }
    });

    // Code view interactions
    document.getElementById('code-view').addEventListener('click', (e) => {
      // Call-links always work
      const link = e.target.closest('.call-link');
      if (link) {
        e.preventDefault();
        const funcId = link.dataset.funcId;
        if (funcId) this.selectFunc(funcId);
        return;
      }
      // In locate mode, clicking a func-block line focuses the graph node
      if (this.state.locateMode) {
        const block = e.target.closest('.func-block');
        if (block && block.dataset.funcId) {
          this.selectFunc(block.dataset.funcId);
        }
      }
    });
  },

  // ---- API ----
  async api(endpoint) {
    if (this.state.cache[endpoint]) return this.state.cache[endpoint];
    const resp = await fetch(endpoint);
    if (!resp.ok) throw new Error(`API error: ${resp.status}`);
    const data = await resp.json();
    this.state.cache[endpoint] = data;
    return data;
  },

  // ---- Select Function (main action) ----
  async selectFunc(funcId) {
    this.state.currentFuncId = funcId;
    this.pushHistory({ type: 'func', funcId });
    await this.chain.activate(funcId);
    await this.showFuncCode(funcId);
    await this.infoPanel.show(funcId);
  },

  async showFuncCode(funcId) {
    // Switch to code tab
    document.querySelectorAll('.right-tabs .rtab').forEach(t => t.classList.remove('active'));
    document.querySelectorAll('.rtab-content').forEach(c => c.classList.remove('active'));
    document.querySelector('[data-rtab="code"]').classList.add('active');
    document.getElementById('rtab-code').classList.add('active');

    try {
      const data = await this.api('/api/func?id=' + encodeURIComponent(funcId));
      if (data.filePath) {
        const fileData = await this.api('/api/file?path=' + encodeURIComponent(data.filePath));
        this.state.currentFile = fileData;
        document.getElementById('current-file-path').textContent = data.filePath.split('/').slice(-2).join('/');
        this.codeView.render();
        this.syncTreeSelection(data.filePath);
        // Scroll to the function using virtual scroll
        if (data.startLine) {
          this.scrollToLine(data.startLine);
        }
      }
    } catch {}
  },

  showContextMenu(e, funcId) {
    const menu = document.getElementById('context-menu');
    menu.dataset.funcId = funcId;
    menu.style.left = e.clientX + 'px';
    menu.style.top = e.clientY + 'px';
    menu.classList.remove('hidden');
  },

  // ============================================================
  //  CHAIN VIEW (code-chain canvas replacing the old graph)
  // ============================================================
  chain: {
    vx: 0, vy: 0, vscale: 1,
    isPanning: false, panStart: null,
    _eventsBound: false,
    _dragBox: null,       // file-box being dragged
    _dragStart: null,
    fileBoxes: {},        // filePath → {el, x, y, fileData, _userPositioned, funcEls:{}}
    activeChains: new Set(),
    arrowData: [],        // [{fromFuncId, toFuncId, fromFilePath, toFilePath, fromLine?, el}]
    _funcDataCache: {},   // funcId → API response (for depth=0 arrow sync)
    canvas: null,
    svgOverlay: null,
    container: null,

    init() {
      this.container = document.getElementById('chain-container');
      this.canvas = document.getElementById('chain-canvas');
      this.svgOverlay = document.getElementById('chain-svg');
      this._bindEvents();
    },

    _bindEvents() {
      if (this._eventsBound) return;
      this._eventsBound = true;
      const container = this.container;

      // Pan on empty area
      container.addEventListener('mousedown', (e) => {
        // Only pan if clicking on container/svg/hint (not on file boxes)
        if (e.target === container || e.target === this.svgOverlay ||
            e.target.id === 'chain-empty-hint' || e.target.tagName === 'svg') {
          this.isPanning = true;
          this._panDist = 0;
          this.panStart = { x: e.clientX, y: e.clientY, vx: this.vx, vy: this.vy };
          container.classList.add('grabbing');
        }
      });

      window.addEventListener('mousemove', (e) => {
        if (this._dragBox) {
          const dx = (e.clientX - this._dragStart.mx) / this.vscale;
          const dy = (e.clientY - this._dragStart.my) / this.vscale;
          this._dragBox.x = this._dragStart.bx + dx;
          this._dragBox.y = this._dragStart.by + dy;
          this._dragBox.el.style.left = this._dragBox.x + 'px';
          this._dragBox.el.style.top = this._dragBox.y + 'px';
          this._dragBox._userPositioned = true;
          this._updateArrows();
          return;
        }
        if (this.isPanning && this.panStart) {
          const dx = e.clientX - this.panStart.x;
          const dy = e.clientY - this.panStart.y;
          this._panDist = Math.sqrt(dx * dx + dy * dy);
          this.vx = this.panStart.vx + dx;
          this.vy = this.panStart.vy + dy;
          this._applyTransform();
        }
      });

      window.addEventListener('mouseup', () => {
        if (this._dragBox) {
          this._dragBox = null;
          this._dragStart = null;
        }
        if (this.isPanning) {
          this.isPanning = false;
          container.classList.remove('grabbing');
          this.panStart = null;
        }
      });

      // Zoom toward mouse — but let file boxes scroll natively
      container.addEventListener('wheel', (e) => {
        if (e.target.closest('.file-box')) return; // let native scroll handle it
        e.preventDefault();
        e.stopPropagation();
        const rect = container.getBoundingClientRect();
        const mx = e.clientX - rect.left;
        const my = e.clientY - rect.top;

        const oldScale = this.vscale;
        const delta = e.deltaY > 0 ? 0.9 : 1.1;
        this.vscale = Math.max(0.1, Math.min(5, this.vscale * delta));

        this.vx = mx - (mx - this.vx) * (this.vscale / oldScale);
        this.vy = my - (my - this.vy) * (this.vscale / oldScale);

        this._applyTransform();
        document.getElementById('zoom-level').textContent = Math.round(this.vscale * 100) + '%';
      }, { passive: false });

      // Depth change → reload current chain
      document.getElementById('chain-depth').addEventListener('change', () => {
        this.reloadCurrent();
      });
    },

    _applyTransform() {
      this.canvas.style.transform = `translate(${this.vx}px, ${this.vy}px) scale(${this.vscale})`;
      this._updateArrows();
    },

    // ---- File box management ----
    _pendingFileBoxes: {},  // filePath → Promise — dedup concurrent calls

    async _ensureFileBox(filePath) {
      if (this.fileBoxes[filePath]) return this.fileBoxes[filePath];

      // If another call is already creating this file box, wait for it
      if (this._pendingFileBoxes[filePath]) return this._pendingFileBoxes[filePath];

      const p = this._createFileBox(filePath);
      this._pendingFileBoxes[filePath] = p;
      try { return await p; } finally { delete this._pendingFileBoxes[filePath]; }
    },

    async _createFileBox(filePath) {
      // Hide empty hint
      const hint = document.getElementById('chain-empty-hint');
      if (hint) hint.style.display = 'none';

      const fileData = await App.api('/api/file?path=' + encodeURIComponent(filePath));

      const box = document.createElement('div');
      box.className = 'file-box';

      // Header
      const header = document.createElement('div');
      header.className = 'file-box-header';
      const fname = document.createElement('span');
      fname.className = 'file-name';
      fname.textContent = filePath.split('/').slice(-2).join('/');
      fname.title = filePath;
      header.appendChild(fname);
      const closeBtn = document.createElement('span');
      closeBtn.className = 'file-close';
      closeBtn.textContent = '\u00d7';
      closeBtn.title = 'Close';
      closeBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        this._removeFileBox(filePath);
      });
      header.appendChild(closeBtn);
      box.appendChild(header);

      // Right-click on file header → mute package
      header.addEventListener('contextmenu', (e) => {
        e.preventDefault();
        e.stopPropagation();
        // Use first function's ID to derive package for mute
        const firstFn = fileData.functions && fileData.functions[0];
        if (firstFn) App.showContextMenu(e, firstFn.id);
      });

      // Drag via header
      header.addEventListener('mousedown', (e) => {
        if (e.target === closeBtn) return;
        e.stopPropagation();
        const fb = this.fileBoxes[filePath];
        this._dragBox = fb;
        this._dragStart = { mx: e.clientX, my: e.clientY, bx: fb.x, by: fb.y };
      });

      // Func list
      const funcList = document.createElement('div');
      funcList.className = 'file-box-funcs';
      funcList.addEventListener('scroll', () => this._updateArrows());

      const funcEls = {};
      const funcs = fileData.functions ? [...fileData.functions].sort((a, b) => a.startLine - b.startLine) : [];

      for (const fn of funcs) {
        if (App.mute.isMatch(fn.id)) continue;
        if (fn.id.includes('$')) continue; // anonymous funcs are inlined into parent
        const block = document.createElement('div');
        block.className = 'func-block-chain';
        block.dataset.funcId = fn.id;

        const hdr = document.createElement('div');
        hdr.className = 'func-header-chain';
        const sig = document.createElement('span');
        sig.className = 'func-sig';
        sig.textContent = fn.signature || fn.name;
        sig.title = fn.id;
        hdr.appendChild(sig);

        const actBtn = document.createElement('button');
        actBtn.className = 'activate-btn';
        actBtn.textContent = '+';
        actBtn.title = 'Load call chain';
        actBtn.addEventListener('click', (e) => {
          e.stopPropagation();
          if (this.activeChains.has(fn.id)) {
            this.deactivate(fn.id);
          } else {
            App.selectFunc(fn.id);
          }
        });
        hdr.appendChild(actBtn);

        // Right-click context menu (mute / bookmark)
        hdr.addEventListener('contextmenu', (e) => {
          e.preventDefault();
          e.stopPropagation();
          App.showContextMenu(e, fn.id);
        });
        block.appendChild(hdr);

        // Collapsible body (code)
        const body = document.createElement('div');
        body.className = 'func-body-chain';
        body.addEventListener('scroll', () => this._updateArrows());
        block.appendChild(body);

        // Drag handle to resize code area height
        const bodyResize = document.createElement('div');
        bodyResize.className = 'func-body-resize';
        bodyResize.addEventListener('mousedown', (e) => {
          e.stopPropagation();
          e.preventDefault();
          bodyResize.classList.add('active');
          const startY = e.clientY;
          const startH = body.offsetHeight;
          const onMove = (ev) => {
            const dy = (ev.clientY - startY) / this.vscale;
            const newH = Math.max(34, startH + dy);
            body.style.maxHeight = newH + 'px';
            body.style.height = newH + 'px';
            this._updateArrows();
          };
          const onUp = () => {
            bodyResize.classList.remove('active');
            window.removeEventListener('mousemove', onMove);
            window.removeEventListener('mouseup', onUp);
          };
          window.addEventListener('mousemove', onMove);
          window.addEventListener('mouseup', onUp);
        });
        block.appendChild(bodyResize);

        // Click header to toggle expand
        hdr.addEventListener('click', (e) => {
          if (e.target === actBtn) return;
          block.classList.toggle('expanded');
          if (block.classList.contains('expanded') && body.childElementCount === 0) {
            this._renderFuncBody(body, fn, fileData);
          }
          // Re-layout arrows after expand/collapse
          requestAnimationFrame(() => this._updateArrows());
        });

        funcList.appendChild(block);
        funcEls[fn.id] = block;
      }

      box.appendChild(funcList);

      // Custom resize handle (larger grab area)
      const resizeGrip = document.createElement('div');
      resizeGrip.className = 'file-box-resize';
      resizeGrip.addEventListener('mousedown', (e) => {
        e.stopPropagation();
        e.preventDefault();
        resizeGrip.classList.add('active');
        const startX = e.clientX, startY = e.clientY;
        const startW = box.offsetWidth, startH = box.offsetHeight;
        const onMove = (ev) => {
          const dxR = (ev.clientX - startX) / this.vscale;
          const dyR = (ev.clientY - startY) / this.vscale;
          box.style.width = Math.max(280, startW + dxR) + 'px';
          box.style.height = Math.max(80, startH + dyR) + 'px';
        };
        const onUp = () => {
          resizeGrip.classList.remove('active');
          window.removeEventListener('mousemove', onMove);
          window.removeEventListener('mouseup', onUp);
          this._updateArrows();
        };
        window.addEventListener('mousemove', onMove);
        window.addEventListener('mouseup', onUp);
      });
      box.appendChild(resizeGrip);

      this.canvas.appendChild(box);

      // Re-draw arrows when the box is resized by the user
      const ro = new ResizeObserver(() => this._updateArrows());
      ro.observe(box);

      const fbObj = {
        el: box, x: 0, y: 0, fileData, filePath,
        _userPositioned: false,
        funcEls, _resizeObserver: ro,
      };
      this.fileBoxes[filePath] = fbObj;
      return fbObj;
    },

    _renderFuncBody(body, fn, fileData) {
      const sourceLines = fileData.source.split('\n');
      // Build call-target map for this function
      const callTargets = {};
      if (fn.statements) {
        for (const stmt of fn.statements) {
          if (stmt.callTarget && stmt.startLine) {
            const t = stmt.callTarget;
            const cls = t.isStdLib ? 'call-link stdlib' : (t.isExternal ? 'call-link external' : 'call-link');
            const escaped = App.codeView.esc(t.function);
            callTargets[stmt.startLine] = {
              cls, escaped,
              linkHtml: `<span class="${cls}" data-func-id="${App.codeView.esc(t.funcId)}" title="${App.codeView.esc(t.funcId)}">${escaped}</span>`,
            };
          }
        }
      }
      for (let line = fn.startLine; line <= fn.endLine; line++) {
        if (line < 1 || line > sourceLines.length) continue;
        const el = document.createElement('div');
        el.className = 'chain-code-line';
        el.dataset.line = line;
        let codeHtml = App.codeView.highlightSyntax(App.codeView.esc(sourceLines[line - 1]));
        const ct = callTargets[line];
        if (ct) {
          const idx = codeHtml.indexOf(ct.escaped);
          if (idx !== -1) codeHtml = codeHtml.substring(0, idx) + ct.linkHtml + codeHtml.substring(idx + ct.escaped.length);
        }
        el.innerHTML = `<span class="chain-line-num">${line}</span><span class="chain-line-code">${codeHtml}</span>`;
        body.appendChild(el);
      }

      // Wire up call-links inside chain body
      body.addEventListener('click', (e) => {
        const link = e.target.closest('.call-link');
        if (link) {
          e.preventDefault();
          e.stopPropagation();
          const funcId = link.dataset.funcId;
          if (funcId) App.selectFunc(funcId);
        }
      });
    },

    _expandFunc(filePath, funcId, role) {
      // Resolve anonymous function to parent (e.g. "pkg.main$1" → "pkg.main")
      while (funcId.includes('$')) {
        funcId = funcId.substring(0, funcId.lastIndexOf('$'));
      }
      const fb = this.fileBoxes[filePath];
      if (!fb) return;
      const block = fb.funcEls[funcId];
      if (!block) return;

      // Expand and render body
      block.classList.add('expanded');
      block.classList.remove('active-func', 'caller-func', 'callee-func', 'dimmed');
      // Update toggle button
      const btn = block.querySelector('.activate-btn');
      if (btn) { btn.textContent = '\u2212'; btn.title = 'Remove from chain'; }
      block.classList.add(role);

      const body = block.querySelector('.func-body-chain');
      if (body && body.childElementCount === 0) {
        const fn = fb.fileData.functions.find(f => f.id === funcId);
        if (fn) this._renderFuncBody(body, fn, fb.fileData);
      }
    },

    _collapseAllExcept(activeFuncIds) {
      const activeSet = new Set(activeFuncIds);
      for (const fb of Object.values(this.fileBoxes)) {
        for (const [fid, block] of Object.entries(fb.funcEls)) {
          if (!activeSet.has(fid)) {
            block.classList.add('dimmed');
          }
        }
      }
    },

    _removeFileBox(filePath) {
      const fb = this.fileBoxes[filePath];
      if (!fb) return;
      if (fb._resizeObserver) fb._resizeObserver.disconnect();
      fb.el.remove();
      delete this.fileBoxes[filePath];
      // Remove arrows related to this file
      this.arrowData = this.arrowData.filter(a => {
        if (a.fromFilePath === filePath || a.toFilePath === filePath) {
          if (a.el) a.el.remove();
          return false;
        }
        return true;
      });
      // Remove active chains for funcs in this file
      for (const fid of [...this.activeChains]) {
        // Remove if belongs to this file (check in arrowData not needed, just cleanup)
      }
      this._updateArrows();
      // Show hint if canvas empty
      if (Object.keys(this.fileBoxes).length === 0) {
        const hint = document.getElementById('chain-empty-hint');
        if (hint) hint.style.display = '';
      }
    },

    // ---- dagre layout for file boxes ----
    _layoutFileBoxes() {
      const entries = Object.entries(this.fileBoxes);
      if (entries.length === 0) return;

      const g = new dagre.graphlib.Graph();
      g.setGraph({ rankdir: 'LR', nodesep: 40, ranksep: 80, edgesep: 20 });
      g.setDefaultEdgeLabel(() => ({}));

      // Measure each file box
      for (const [fp, fb] of entries) {
        const w = fb.el.offsetWidth || 300;
        const h = fb.el.offsetHeight || 100;
        g.setNode(fp, { width: w, height: h });
      }

      // Add cross-file edges
      const addedEdges = new Set();
      for (const arrow of this.arrowData) {
        if (arrow.fromFilePath !== arrow.toFilePath) {
          const key = arrow.fromFilePath + '->' + arrow.toFilePath;
          if (!addedEdges.has(key)) {
            addedEdges.add(key);
            g.setEdge(arrow.fromFilePath, arrow.toFilePath);
          }
        }
      }

      dagre.layout(g);

      for (const [fp, fb] of entries) {
        if (fb._userPositioned) continue;
        const ln = g.node(fp);
        if (ln) {
          fb.x = ln.x - (fb.el.offsetWidth || 300) / 2;
          fb.y = ln.y - (fb.el.offsetHeight || 100) / 2;
          fb.el.style.left = fb.x + 'px';
          fb.el.style.top = fb.y + 'px';
        }
      }
    },

    // ---- Arrow rendering ----

    // Compute the visible Y-center of an element, clamped to the
    // intersection of its scrollable ancestors' visible rects.
    // ancestor chain: element → .func-body-chain → .file-box-funcs → .file-box
    _visibleYCenter(el, fileBoxEl) {
      const elRect = el.getBoundingClientRect();
      let top = elRect.top;
      let bottom = elRect.bottom;

      // Clamp to .func-body-chain (inner scroll container)
      const body = el.closest('.func-body-chain');
      if (body) {
        const br = body.getBoundingClientRect();
        top = Math.max(top, br.top);
        bottom = Math.min(bottom, br.bottom);
      }

      // Clamp to .file-box-funcs (outer scroll container)
      const funcs = el.closest('.file-box-funcs');
      if (funcs) {
        const fr = funcs.getBoundingClientRect();
        top = Math.max(top, fr.top);
        bottom = Math.min(bottom, fr.bottom);
      }

      // If element is fully clipped (scrolled out of view),
      // snap to the nearest edge of the visible code area.
      if (top >= bottom) {
        const rawMid = (elRect.top + elRect.bottom) / 2;
        const clipRect = (funcs || fileBoxEl).getBoundingClientRect();
        return rawMid < clipRect.top ? clipRect.top : clipRect.bottom;
      }

      return (top + bottom) / 2;
    },

    _updateArrows() {
      const svg = this.svgOverlay;
      if (!svg) return;
      const container = this.container;
      const containerRect = container.getBoundingClientRect();

      // Remove old path elements (keep defs)
      svg.querySelectorAll('path.chain-arrow').forEach(p => p.remove());

      const ns = 'http://www.w3.org/2000/svg';

      for (const arrow of this.arrowData) {
        const fromFb = this.fileBoxes[arrow.fromFilePath];
        const toFb = this.fileBoxes[arrow.toFilePath];
        if (!fromFb || !toFb) continue;

        // Resolve anonymous function IDs to parent for DOM lookup
        let fromFuncId = arrow.fromFuncId;
        while (fromFuncId.includes('$')) fromFuncId = fromFuncId.substring(0, fromFuncId.lastIndexOf('$'));
        let toFuncId = arrow.toFuncId;
        while (toFuncId.includes('$')) toFuncId = toFuncId.substring(0, toFuncId.lastIndexOf('$'));
        const fromBlock = fromFb.funcEls[fromFuncId];
        const toBlock = toFb.funcEls[toFuncId];
        if (!fromBlock || !toBlock) continue;

        // Source: specific call-site line, fallback to func header
        let fromEl = null;
        if (arrow.fromLine && fromBlock.classList.contains('expanded')) {
          fromEl = fromBlock.querySelector(`.chain-code-line[data-line="${arrow.fromLine}"]`);
        }
        if (!fromEl) fromEl = fromBlock.querySelector('.func-header-chain');
        if (!fromEl) fromEl = fromBlock;

        // Target: function signature header
        let toEl = toBlock.querySelector('.func-header-chain');
        if (!toEl) toEl = toBlock;

        // Compute Y clamped to the visible code area
        const y1 = this._visibleYCenter(fromEl, fromFb.el) - containerRect.top;
        const y2 = this._visibleYCenter(toEl, toFb.el) - containerRect.top;

        const fromBoxRect = fromFb.el.getBoundingClientRect();
        const toBoxRect = toFb.el.getBoundingClientRect();
        let d;

        if (fromFb === toFb) {
          // Same file box: compact arc on the right side
          const x = fromBoxRect.right - containerRect.left;
          const bulge = 30 + Math.min(Math.abs(y2 - y1) * 0.3, 60);
          d = `M ${x} ${y1} C ${x + bulge} ${y1}, ${x + bulge} ${y2}, ${x} ${y2}`;
        } else {
          // Cross file-box: determine left-to-right or right-to-left
          const goRight = fromBoxRect.right <= toBoxRect.left + 20;
          let x1, x2;
          if (goRight) {
            x1 = fromBoxRect.right - containerRect.left;
            x2 = toBoxRect.left - containerRect.left;
          } else {
            x1 = fromBoxRect.left - containerRect.left;
            x2 = toBoxRect.right - containerRect.left;
          }
          const dx = Math.max(Math.abs(x2 - x1) * 0.4, 30);
          const cx1 = goRight ? x1 + dx : x1 - dx;
          const cx2 = goRight ? x2 - dx : x2 + dx;
          d = `M ${x1} ${y1} C ${cx1} ${y1}, ${cx2} ${y2}, ${x2} ${y2}`;
        }

        const path = document.createElementNS(ns, 'path');
        path.setAttribute('class', 'chain-arrow');
        path.setAttribute('d', d);
        path.setAttribute('fill', 'none');
        path.setAttribute('stroke', '#a6e3a1');
        path.setAttribute('stroke-width', '1.5');
        path.setAttribute('marker-end', 'url(#arrow-chain)');
        svg.appendChild(path);
        arrow.el = path;
      }
    },

    // ---- Core: activate a function ----
    async activate(funcId) {
      this.activeChains.add(funcId);
      const depthVal = parseInt(document.getElementById('chain-depth').value, 10);
      const depth = Number.isNaN(depthVal) ? 1 : depthVal;
      const visited = new Set();
      const allActiveFuncIds = [];
      const boxCountBefore = Object.keys(this.fileBoxes).length;

      try {
        await this._activateOne(funcId, depth, true, visited, allActiveFuncIds);

        // Manual mode (depth=0): rebuild arrows between all active functions
        if (depth === 0) {
          this._syncActiveArrows();
          for (const id of this.activeChains) {
            if (!allActiveFuncIds.includes(id)) allActiveFuncIds.push(id);
          }
        }

        this._collapseAllExcept(allActiveFuncIds);
        this._layoutFileBoxes();
        await new Promise(r => requestAnimationFrame(r));
        this._updateArrows();
        // Only auto-fit when new file boxes were added in auto mode (depth>0)
        if (!this._skipFitToView && depth > 0 && Object.keys(this.fileBoxes).length > boxCountBefore) {
          this.fitToView();
        }
      } catch (e) {
        console.error('Chain activate error:', e);
      }
    },

    deactivate(funcId) {
      this.activeChains.delete(funcId);
      delete this._funcDataCache[funcId];

      // Remove arrows involving this function
      this.arrowData = this.arrowData.filter(a => a.fromFuncId !== funcId && a.toFuncId !== funcId);

      // Collapse the function block and restore '+' button
      for (const fb of Object.values(this.fileBoxes)) {
        let resolvedId = funcId;
        while (resolvedId.includes('$')) resolvedId = resolvedId.substring(0, resolvedId.lastIndexOf('$'));
        const block = fb.funcEls[resolvedId];
        if (block) {
          block.classList.remove('expanded', 'active-func', 'caller-func', 'callee-func');
          block.classList.add('dimmed');
          const body = block.querySelector('.func-body-chain');
          if (body) body.innerHTML = '';
          const btn = block.querySelector('.activate-btn');
          if (btn) { btn.textContent = '+'; btn.title = 'Load call chain'; }
        }
      }

      // Remove file boxes that have no active functions left
      for (const [path, fb] of Object.entries(this.fileBoxes)) {
        const hasActive = Object.entries(fb.funcEls).some(([fid, el]) =>
          el.classList.contains('expanded')
        );
        if (!hasActive) this._removeFileBox(path);
      }

      this._updateArrows();
    },

    // Recursive core: expand one function and its callers/callees
    // isRoot=true means this is the user-activated node (show callers); callees recurse with isRoot=false
    async _activateOne(funcId, depth, isRoot, visited, allActiveFuncIds) {
      if (visited.has(funcId)) return;
      visited.add(funcId);

      const data = await App.api('/api/func?id=' + encodeURIComponent(funcId));
      this._funcDataCache[funcId] = data;
      const filePath = data.filePath;
      if (!filePath) return;

      await this._ensureFileBox(filePath);
      this._expandFunc(filePath, funcId, isRoot ? 'active-func' : 'callee-func');
      allActiveFuncIds.push(funcId);

      // Manual mode (depth=0): only expand self, arrows handled by _syncActiveArrows
      if (depth <= 0) return;

      // Process callees from statements
      const calleeInfos = []; // collect for recursive expansion
      if (data.statements) {
        for (const stmt of data.statements) {
          if (!stmt.callTarget) continue;
          const t = stmt.callTarget;
          if (App.mute.isMatch(t.funcId)) continue;
          if (t.isStdLib || t.isExternal) continue;
          if (!t.filePath) continue;

          await this._ensureFileBox(t.filePath);
          this._expandFunc(t.filePath, t.funcId, 'callee-func');
          allActiveFuncIds.push(t.funcId);
          // Add arrow
          if (!this.arrowData.some(a => a.fromFilePath === filePath && a.fromLine === stmt.startLine && a.toFuncId === t.funcId)) {
            this.arrowData.push({
              fromFuncId: funcId, toFuncId: t.funcId,
              fromFilePath: filePath, toFilePath: t.filePath,
              fromLine: stmt.startLine,
            });
          }
          if (depth > 1 && !visited.has(t.funcId)) {
            calleeInfos.push(t.funcId);
          }
        }
      }

      // Process callers — only for the root node, don't recurse
      if (isRoot && data.callers) {
        const callerPromises = [];
        for (const callerId of data.callers) {
          if (App.mute.isMatch(callerId)) continue;
          callerPromises.push((async () => {
            try {
              const callerData = await App.api('/api/func?id=' + encodeURIComponent(callerId));
              if (!callerData.filePath) return;
              await this._ensureFileBox(callerData.filePath);
              let displayCallerId = callerId;
              while (displayCallerId.includes('$')) {
                displayCallerId = displayCallerId.substring(0, displayCallerId.lastIndexOf('$'));
              }
              this._expandFunc(callerData.filePath, displayCallerId, 'caller-func');
              allActiveFuncIds.push(displayCallerId);
              let callLine = null;
              if (callerData.statements) {
                for (const s of callerData.statements) {
                  if (s.callTarget && s.callTarget.funcId === funcId && s.startLine) {
                    callLine = s.startLine; break;
                  }
                }
              }
              if (!this.arrowData.some(a => a.fromFilePath === callerData.filePath && a.fromLine === callLine && a.toFuncId === funcId)) {
                this.arrowData.push({
                  fromFuncId: displayCallerId, toFuncId: funcId,
                  fromFilePath: callerData.filePath, toFilePath: filePath,
                  fromLine: callLine,
                });
              }
            } catch {}
          })());
        }
        await Promise.all(callerPromises);
      }

      // Recurse into callees
      for (const calleeId of calleeInfos) {
        await this._activateOne(calleeId, depth - 1, false, visited, allActiveFuncIds);
      }
    },

    // Rebuild arrows between all active functions (for depth=0 manual mode)
    _syncActiveArrows() {
      this.arrowData = [];
      for (const funcId of this.activeChains) {
        const data = this._funcDataCache[funcId];
        if (!data || !data.statements || !data.filePath) continue;
        for (const stmt of data.statements) {
          if (!stmt.callTarget || !stmt.callTarget.filePath) continue;
          const t = stmt.callTarget;
          // Only connect to other active, visible functions
          let targetId = t.funcId;
          while (targetId.includes('$')) targetId = targetId.substring(0, targetId.lastIndexOf('$'));
          if (!this.activeChains.has(t.funcId) && !this.activeChains.has(targetId)) continue;
          if (!this.arrowData.some(a => a.fromFilePath === data.filePath && a.fromLine === stmt.startLine && a.toFuncId === t.funcId)) {
            this.arrowData.push({
              fromFuncId: funcId, toFuncId: t.funcId,
              fromFilePath: data.filePath, toFilePath: t.filePath,
              fromLine: stmt.startLine,
            });
          }
        }
      }
    },

    reloadCurrent() {
      if (this.activeChains.size === 0) return;
      const funcs = [...this.activeChains];
      // Preserve current view transform
      const savedVx = this.vx, savedVy = this.vy, savedScale = this.vscale;
      this._skipFitToView = true;
      this.reset();
      const done = Promise.all(funcs.map(fid => this.activate(fid)));
      done.then(() => {
        this._skipFitToView = false;
        // Restore view transform
        this.vx = savedVx; this.vy = savedVy; this.vscale = savedScale;
        this._applyTransform();
        document.getElementById('zoom-level').textContent = Math.round(this.vscale * 100) + '%';
      });
    },

    fitToView() {
      const entries = Object.values(this.fileBoxes);
      if (entries.length === 0) return;

      const W = this.container.clientWidth;
      const H = this.container.clientHeight;
      if (!W || !H) return;

      let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
      for (const fb of entries) {
        const w = fb.el.offsetWidth || 300;
        const h = fb.el.offsetHeight || 100;
        minX = Math.min(minX, fb.x);
        minY = Math.min(minY, fb.y);
        maxX = Math.max(maxX, fb.x + w);
        maxY = Math.max(maxY, fb.y + h);
      }
      if (!isFinite(minX)) return;

      const pad = 40;
      const gw = maxX - minX + pad * 2;
      const gh = maxY - minY + pad * 2;
      this.vscale = Math.min(W / gw, H / gh, 1.5);
      this.vx = (W - gw * this.vscale) / 2 - (minX - pad) * this.vscale;
      this.vy = (H - gh * this.vscale) / 2 - (minY - pad) * this.vscale;

      this._applyTransform();
      document.getElementById('zoom-level').textContent = Math.round(this.vscale * 100) + '%';
    },

    reset() {
      // Remove all file boxes
      for (const fb of Object.values(this.fileBoxes)) {
        if (fb._resizeObserver) fb._resizeObserver.disconnect();
        fb.el.remove();
      }
      this.fileBoxes = {};
      this._pendingFileBoxes = {};
      // Remove arrows
      this.svgOverlay.querySelectorAll('path.chain-arrow').forEach(p => p.remove());
      this.arrowData = [];
      this.activeChains.clear();
      this._funcDataCache = {};
      // Reset transform
      this.vx = 0; this.vy = 0; this.vscale = 1;
      this._applyTransform();
      document.getElementById('zoom-level').textContent = '100%';
      // Show hint
      const hint = document.getElementById('chain-empty-hint');
      if (hint) hint.style.display = '';
    },

    clearHighlights() {
      App.state.highlights = null;
      for (const fb of Object.values(this.fileBoxes)) {
        for (const block of Object.values(fb.funcEls)) {
          block.classList.remove('active-func', 'caller-func', 'callee-func', 'dimmed');
        }
      }
    },
  },

  // ============================================================
  //  FILE TREE
  // ============================================================
  tree: {
    async load() {
      const data = await App.api('/api/tree');
      const container = document.getElementById('file-tree');
      container.innerHTML = '';
      container.appendChild(this.renderNode(data, true));
    },

    renderNode(node, isRoot) {
      const el = document.createElement('div');
      el.className = 'tree-node';
      const label = document.createElement('div');
      label.className = 'tree-label';

      if (node.type === 'package') {
        const collapsed = !isRoot; // root expanded, others collapsed
        const icon = document.createElement('span');
        icon.className = 'tree-icon';
        icon.textContent = collapsed ? '▶' : '▼';
        label.appendChild(icon);
        const name = document.createElement('span');
        name.textContent = node.name;
        label.appendChild(name);
        el.appendChild(label);

        if (node.children) {
          const children = document.createElement('div');
          children.className = 'tree-children' + (collapsed ? ' collapsed' : '');
          node.children.forEach(child => children.appendChild(this.renderNode(child, false)));
          el.appendChild(children);
          label.addEventListener('click', () => {
            children.classList.toggle('collapsed');
            icon.textContent = children.classList.contains('collapsed') ? '▶' : '▼';
          });
        }
      } else {
        const icon = document.createElement('span');
        icon.className = 'tree-icon';
        icon.textContent = '◇';
        label.appendChild(icon);
        const name = document.createElement('span');
        name.textContent = node.name;
        label.appendChild(name);
        label.dataset.filePath = node.path;
        label.addEventListener('click', () => {
          document.querySelectorAll('.tree-label.selected').forEach(l => l.classList.remove('selected'));
          label.classList.add('selected');
          App.loadFileToCodeView(node.path);
        });
        el.appendChild(label);
      }
      return el;
    },
  },

  async loadFileToCodeView(path, scrollToLine) {
    this.pushHistory({ type: 'file', filePath: path, line: scrollToLine || 0 });
    const data = await this.api('/api/file?path=' + encodeURIComponent(path));
    this.state.currentFile = data;
    document.getElementById('current-file-path').textContent = path.split('/').slice(-2).join('/');
    // Switch to code tab
    document.querySelectorAll('.right-tabs .rtab').forEach(t => t.classList.remove('active'));
    document.querySelectorAll('.rtab-content').forEach(c => c.classList.remove('active'));
    document.querySelector('[data-rtab="code"]').classList.add('active');
    document.getElementById('rtab-code').classList.add('active');
    this.codeView.render();
    this.syncTreeSelection(path);
    if (scrollToLine > 0) {
      await new Promise(r => setTimeout(r, 30));
      this.scrollToLine(scrollToLine);
    }
  },

  // Sync left panel file tree selection with current file
  syncTreeSelection(filePath) {
    document.querySelectorAll('.tree-label.selected').forEach(l => l.classList.remove('selected'));
    const target = document.querySelector(`.tree-label[data-file-path="${CSS.escape(filePath)}"]`);
    if (target) {
      target.classList.add('selected');
      // Expand parent folders if collapsed
      let parent = target.closest('.tree-children');
      while (parent) {
        parent.classList.remove('collapsed');
        const icon = parent.previousElementSibling?.querySelector('.tree-icon');
        if (icon) icon.textContent = '▼';
        parent = parent.parentElement?.closest('.tree-children');
      }
      target.scrollIntoView({ block: 'nearest' });
    }
  },

  scrollToLine(lineNum) {
    const row = this.codeView._getVisibleRowForLine(lineNum);
    if (row >= 0) {
      const container = document.getElementById('code-view');
      const targetTop = row * this.codeView.LINE_HEIGHT;
      container.scrollTop = Math.max(0, targetTop - container.clientHeight / 3);
      // Wait for render then flash
      requestAnimationFrame(() => {
        const el = container.querySelector(`.stmt-line[data-line="${lineNum}"]`);
        if (el) {
          el.classList.add('flash');
          setTimeout(() => el.classList.remove('flash'), 1500);
        }
      });
    }
  },

  // ---- Navigation History ----
  pushHistory(entry) {
    if (this.state._navigating) return;
    // Dedup: don't push if same as current
    const cur = this.state.history[this.state.historyIdx];
    if (cur && cur.type === entry.type && cur.filePath === entry.filePath && cur.line === entry.line && cur.funcId === entry.funcId) return;
    // Truncate forward history
    this.state.history = this.state.history.slice(0, this.state.historyIdx + 1);
    this.state.history.push(entry);
    this.state.historyIdx = this.state.history.length - 1;
    this.updateNavButtons();
  },

  async navBack() {
    if (this.state.historyIdx <= 0) return;
    this.state.historyIdx--;
    await this.navigateToEntry(this.state.history[this.state.historyIdx]);
    this.updateNavButtons();
  },

  async navForward() {
    if (this.state.historyIdx >= this.state.history.length - 1) return;
    this.state.historyIdx++;
    await this.navigateToEntry(this.state.history[this.state.historyIdx]);
    this.updateNavButtons();
  },

  async navigateToEntry(entry) {
    this.state._navigating = true;
    try {
      if (entry.type === 'func') {
        await this.selectFunc(entry.funcId);
      } else {
        await this.loadFileToCodeView(entry.filePath, entry.line || 0);
      }
    } finally {
      this.state._navigating = false;
    }
  },

  updateNavButtons() {
    const back = document.getElementById('nav-back');
    const fwd = document.getElementById('nav-forward');
    if (back) back.disabled = this.state.historyIdx <= 0;
    if (fwd) fwd.disabled = this.state.historyIdx >= this.state.history.length - 1;
  },

  // ============================================================
  //  USER FOLDS
  // ============================================================
  folds: {
    add(filePath, start, end) {
      if (start > end) [start, end] = [end, start];
      if (start === end) return;
      if (!App.state.userFolds[filePath]) App.state.userFolds[filePath] = [];
      const folds = App.state.userFolds[filePath];
      // Remove any existing folds that overlap with the new range
      App.state.userFolds[filePath] = folds.filter(f => f.end < start || f.start > end);
      App.state.userFolds[filePath].push({ start, end });
      App.state.userFolds[filePath].sort((a, b) => a.start - b.start);
    },
    remove(filePath, start, end) {
      if (!App.state.userFolds[filePath]) return;
      App.state.userFolds[filePath] = App.state.userFolds[filePath].filter(
        f => !(f.start === start && f.end === end)
      );
    },
    get(filePath) {
      return (App.state.userFolds[filePath] || []).slice().sort((a, b) => a.start - b.start);
    },
    // Find the fold that contains this line (1-indexed), or null
    findFold(filePath, lineNum) {
      const folds = App.state.userFolds[filePath] || [];
      return folds.find(f => lineNum >= f.start && lineNum <= f.end) || null;
    },
  },

  // ============================================================
  //  CODE VIEW (right panel)
  // ============================================================
  codeView: {
    LINE_HEIGHT: 19,
    _lines: [],           // prepared line data [{lineNum, html, funcId, type, blockClass, foldData, expanded}]
    _visibleStart: -1,
    _visibleEnd: -1,
    _scrollBound: false,
    _syntaxCache: new Map(), // filePath -> Map(lineIdx -> html)
    _searchQuery: '',
    _searchMatchLines: [], // [{dataIdx, positions}]
    _searchIdx: -1,

    render() {
      const container = document.getElementById('code-view');
      const file = App.state.currentFile;
      if (!file) {
        container.innerHTML = '<div style="padding:16px;color:var(--text-dim);font-size:12px">Click a node to view code</div>';
        this._lines = [];
        return;
      }

      // Prepare line data
      this._prepareLines(file);

      // Count visible lines
      const visibleCount = this._lines.filter(l => !l.hidden).length;
      const totalHeight = visibleCount * this.LINE_HEIGHT;

      container.innerHTML = '';
      const spacer = document.createElement('div');
      spacer.className = 'vscroll-spacer';
      spacer.style.height = totalHeight + 'px';
      const content = document.createElement('div');
      content.className = 'vscroll-content';
      spacer.appendChild(content);
      container.appendChild(spacer);

      // Bind scroll once
      if (!this._scrollBound) {
        this._scrollBound = true;
        let ticking = false;
        document.getElementById('code-view').addEventListener('scroll', () => {
          if (ticking) return;
          ticking = true;
          requestAnimationFrame(() => {
            ticking = false;
            this._renderVisible();
            this.updateOutlineActive();
          });
        });
      }

      this._visibleStart = -1;
      this._visibleEnd = -1;
      this._renderVisible();
      this.renderOutline();

      // Re-apply search if active
      if (this._searchQuery) {
        this._computeSearchMatches(this._searchQuery);
      }
    },

    _prepareLines(file) {
      this._lines = [];
      const sourceLines = file.source.split('\n');
      const filePath = file.path || '';
      const folds = App.folds.get(filePath);

      // Build call-target map: lineNum -> {cls, escaped, linkHtml}
      const callTargets = {};
      if (file.functions) {
        for (const fn of file.functions) {
          if (!fn.statements) continue;
          for (const stmt of fn.statements) {
            if (stmt.callTarget && stmt.startLine) {
              const t = stmt.callTarget;
              const cls = t.isStdLib ? 'call-link stdlib' : (t.isExternal ? 'call-link external' : 'call-link');
              const escaped = this.esc(t.function);
              callTargets[stmt.startLine] = {
                cls, escaped,
                linkHtml: `<span class="${cls}" data-func-id="${this.esc(t.funcId)}" title="${this.esc(t.funcId)}">${escaped}</span>`,
              };
            }
          }
        }
      }

      // Build func ranges for highlight classes
      const funcRanges = [];
      if (file.functions) {
        const funcs = [...file.functions].sort((a, b) => a.startLine - b.startLine);
        for (const fn of funcs) {
          funcRanges.push({ id: fn.id, start: fn.startLine, end: fn.endLine, isMuted: App.mute.isMatch(fn.id) });
        }
      }

      // Get or create syntax cache for this file
      let syntaxMap = this._syntaxCache.get(filePath);
      if (!syntaxMap) {
        syntaxMap = new Map();
        this._syntaxCache.set(filePath, syntaxMap);
        // Limit cache to 5 files
        if (this._syntaxCache.size > 5) {
          const first = this._syntaxCache.keys().next().value;
          this._syntaxCache.delete(first);
        }
      }

      const getHighlighted = (lineIdx) => {
        if (syntaxMap.has(lineIdx)) return syntaxMap.get(lineIdx);
        const html = this.highlightSyntax(this.esc(sourceLines[lineIdx]));
        syntaxMap.set(lineIdx, html);
        return html;
      };

      // Walk through all source lines, building _lines entries
      let lineNum = 1;
      const totalLines = sourceLines.length;

      // Find which func-block each line belongs to
      const lineFuncId = (ln) => {
        for (const fr of funcRanges) {
          if (ln >= fr.start && ln <= fr.end) return fr;
        }
        return null;
      };

      while (lineNum <= totalLines) {
        const fr = lineFuncId(lineNum);

        // Muted function block — emit summary only
        if (fr && fr.isMuted && lineNum === fr.start) {
          this._lines.push({
            lineNum, type: 'muted-block', funcId: fr.id, hidden: false,
            html: '', blockClass: 'func-block muted-block',
            mutedLabel: `[muted] ${fr.id}`,
          });
          lineNum = fr.end + 1;
          continue;
        }

        // Check user fold
        const fold = folds.find(f => f.start === lineNum);
        if (fold && fold.end >= lineNum) {
          // Fold summary line
          const count = fold.end - fold.start + 1;
          this._lines.push({
            lineNum, type: 'user-fold-summary', hidden: false,
            funcId: fr ? fr.id : null,
            blockClass: fr ? 'func-block' : '',
            foldData: { start: fold.start, end: fold.end, count },
            expanded: false,
          });
          // Folded content lines (hidden by default)
          for (let i = fold.start; i <= fold.end; i++) {
            if (i < 1 || i > totalLines) continue;
            let codeHtml = getHighlighted(i - 1);
            const ct = callTargets[i];
            if (ct) {
              const idx = codeHtml.indexOf(ct.escaped);
              if (idx !== -1) codeHtml = codeHtml.substring(0, idx) + ct.linkHtml + codeHtml.substring(idx + ct.escaped.length);
            }
            this._lines.push({
              lineNum: i, type: 'user-fold-content', hidden: true,
              funcId: fr ? fr.id : null, blockClass: fr ? 'func-block' : '',
              html: codeHtml, foldOwner: fold.start,
            });
          }
          lineNum = fold.end + 1;
          continue;
        }
        // Skip lines inside a fold
        if (folds.some(f => lineNum > f.start && lineNum <= f.end)) { lineNum++; continue; }

        // Check comment fold (>2 consecutive comment lines)
        if (this.isCommentLine(sourceLines[lineNum - 1])) {
          let j = lineNum;
          const limit = fr ? fr.end : totalLines;
          while (j <= limit && j <= totalLines && this.isCommentLine(sourceLines[j - 1])) j++;
          const commentCount = j - lineNum;
          if (commentCount > 2) {
            // First 2 lines visible
            for (let i = lineNum; i < lineNum + 2; i++) {
              this._lines.push({
                lineNum: i, type: 'line', hidden: false,
                funcId: fr ? fr.id : null, blockClass: fr ? 'func-block' : '',
                html: getHighlighted(i - 1),
              });
            }
            // Comment fold summary
            this._lines.push({
              lineNum: lineNum + 2, type: 'comment-fold-summary', hidden: false,
              funcId: fr ? fr.id : null, blockClass: fr ? 'func-block' : '',
              foldData: { start: lineNum + 2, end: j - 1, count: commentCount - 2 },
              expanded: false,
            });
            // Hidden comment content
            for (let i = lineNum + 2; i < j; i++) {
              this._lines.push({
                lineNum: i, type: 'comment-fold-content', hidden: true,
                funcId: fr ? fr.id : null, blockClass: fr ? 'func-block' : '',
                html: getHighlighted(i - 1), foldOwner: lineNum + 2,
              });
            }
            lineNum = j;
            continue;
          }
        }

        // Regular line
        let codeHtml = getHighlighted(lineNum - 1);
        const ct = callTargets[lineNum];
        if (ct) {
          const idx = codeHtml.indexOf(ct.escaped);
          if (idx !== -1) codeHtml = codeHtml.substring(0, idx) + ct.linkHtml + codeHtml.substring(idx + ct.escaped.length);
        }
        this._lines.push({
          lineNum, type: 'line', hidden: false,
          funcId: fr ? fr.id : null, blockClass: fr ? 'func-block' : '',
          html: codeHtml,
        });
        lineNum++;
      }
    },

    _renderVisible() {
      const container = document.getElementById('code-view');
      if (!container) return;
      const content = container.querySelector('.vscroll-content');
      if (!content) return;

      const scrollTop = container.scrollTop;
      const clientHeight = container.clientHeight;
      const LH = this.LINE_HEIGHT;
      const buffer = 30;

      // Build visible-index array (lines that aren't hidden)
      // Use cached version for performance
      if (!this._visibleIndices || this._visibleIndices._ver !== this._lines) {
        const arr = [];
        for (let i = 0; i < this._lines.length; i++) {
          if (!this._lines[i].hidden) arr.push(i);
        }
        arr._ver = this._lines;
        this._visibleIndices = arr;
      }
      const visIdx = this._visibleIndices;

      const startRow = Math.max(0, Math.floor(scrollTop / LH) - buffer);
      const endRow = Math.min(visIdx.length - 1, Math.ceil((scrollTop + clientHeight) / LH) + buffer);

      if (startRow === this._visibleStart && endRow === this._visibleEnd) return;
      this._visibleStart = startRow;
      this._visibleEnd = endRow;

      content.innerHTML = '';
      content.style.transform = `translateY(${startRow * LH}px)`;

      const filePath = App.state.currentFile ? App.state.currentFile.path : '';
      const searchQ = this._searchQuery ? this._searchQuery.toLowerCase() : '';

      // Track func blocks for borders
      let currentFuncId = null;
      let funcBlockDiv = null;
      let funcBodyDiv = null;

      for (let r = startRow; r <= endRow && r < visIdx.length; r++) {
        const dataIdx = visIdx[r];
        const entry = this._lines[dataIdx];

        // Manage func-block grouping
        if (entry.funcId !== currentFuncId) {
          if (funcBlockDiv) {
            if (funcBodyDiv) funcBlockDiv.appendChild(funcBodyDiv);
            content.appendChild(funcBlockDiv);
          }
          currentFuncId = entry.funcId;
          if (currentFuncId) {
            funcBlockDiv = document.createElement('div');
            funcBlockDiv.className = 'func-block';
            funcBlockDiv.dataset.funcId = currentFuncId;
            funcBodyDiv = document.createElement('div');
            funcBodyDiv.className = 'func-body';
          } else {
            funcBlockDiv = null;
            funcBodyDiv = null;
          }
        }

        const target = funcBodyDiv || content;

        if (entry.type === 'muted-block') {
          const block = document.createElement('div');
          block.className = 'func-block muted-block';
          block.dataset.funcId = entry.funcId;
          const label = document.createElement('div');
          label.className = 'muted-label';
          label.textContent = entry.mutedLabel;
          block.appendChild(label);
          content.appendChild(block);
          currentFuncId = null; funcBlockDiv = null; funcBodyDiv = null;
          continue;
        }

        if (entry.type === 'user-fold-summary') {
          const fd = entry.foldData;
          const group = document.createElement('div');
          group.className = 'fold-group user-fold';
          const summary = document.createElement('div');
          summary.className = 'fold-summary';
          const text = document.createElement('span');
          text.textContent = entry.expanded
            ? `▼ [${fd.start}-${fd.end} (${fd.count} lines)]`
            : `▶ [${fd.start}-${fd.end} folded (${fd.count} lines)]`;
          summary.appendChild(text);
          const removeBtn = document.createElement('span');
          removeBtn.className = 'fold-remove';
          removeBtn.textContent = '×';
          removeBtn.title = 'Remove fold';
          removeBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            App.folds.remove(filePath, fd.start, fd.end);
            App.codeView.render();
          });
          summary.appendChild(removeBtn);
          group.appendChild(summary);
          group.addEventListener('click', (e) => {
            if (e.target.closest('.fold-remove')) return;
            entry.expanded = !entry.expanded;
            // Toggle hidden state of content lines
            for (const l of this._lines) {
              if (l.foldOwner === fd.start && l.type === 'user-fold-content') {
                l.hidden = !entry.expanded;
              }
            }
            this._visibleIndices = null; // invalidate
            this._recalcHeight();
            this._visibleStart = -1; this._visibleEnd = -1;
            this._renderVisible();
          });
          target.appendChild(group);
          continue;
        }

        if (entry.type === 'comment-fold-summary') {
          const fd = entry.foldData;
          const group = document.createElement('div');
          group.className = 'fold-group';
          const summary = document.createElement('div');
          summary.className = 'fold-summary';
          summary.textContent = entry.expanded
            ? `▼ [${fd.count} comment lines]`
            : `▶ [${fd.count} more comment lines]`;
          group.appendChild(summary);
          group.addEventListener('click', () => {
            entry.expanded = !entry.expanded;
            for (const l of this._lines) {
              if (l.foldOwner === fd.start && l.type === 'comment-fold-content') {
                l.hidden = !entry.expanded;
              }
            }
            this._visibleIndices = null;
            this._recalcHeight();
            this._visibleStart = -1; this._visibleEnd = -1;
            this._renderVisible();
          });
          target.appendChild(group);
          continue;
        }

        // Regular line, user-fold-content, or comment-fold-content
        const line = document.createElement('div');
        line.className = 'stmt-line';
        line.dataset.line = entry.lineNum;
        line.appendChild(this.makeLineNum(entry.lineNum));
        const codeSpan = document.createElement('span');
        codeSpan.className = 'line-code';
        let html = entry.html;
        // Apply search highlights inline
        if (searchQ && html) {
          html = this._applySearchHighlight(html, searchQ);
        }
        codeSpan.innerHTML = html;
        line.appendChild(codeSpan);
        target.appendChild(line);
      }

      // Flush last func block
      if (funcBlockDiv) {
        if (funcBodyDiv) funcBlockDiv.appendChild(funcBodyDiv);
        content.appendChild(funcBlockDiv);
      }

      // Apply highlight classes to func blocks
      if (App.state.highlights) {
        const hl = App.state.highlights;
        content.querySelectorAll('.func-block').forEach(block => {
          const fid = block.dataset.funcId;
          if (fid === hl.current) block.classList.add('highlight-current');
          else if (hl.callers.includes(fid)) block.classList.add('highlight-caller');
          else if (hl.callees.includes(fid)) block.classList.add('highlight-callee');
        });
      }
    },

    _recalcHeight() {
      const container = document.getElementById('code-view');
      if (!container) return;
      const spacer = container.querySelector('.vscroll-spacer');
      if (!spacer) return;
      const visibleCount = this._lines.filter(l => !l.hidden).length;
      spacer.style.height = (visibleCount * this.LINE_HEIGHT) + 'px';
    },

    _applySearchHighlight(html, query) {
      // Apply <mark> to visible text matches, preserving HTML tags
      // Strategy: split by HTML tags, highlight text segments, rejoin
      const parts = html.split(/(<[^>]+>)/);
      const qLower = query.toLowerCase();
      for (let i = 0; i < parts.length; i++) {
        if (parts[i].startsWith('<')) continue; // HTML tag
        const text = parts[i];
        const lower = text.toLowerCase();
        if (!lower.includes(qLower)) continue;
        let result = '';
        let pos = 0;
        let idx;
        while ((idx = lower.indexOf(qLower, pos)) !== -1) {
          result += text.substring(pos, idx);
          result += '<mark>' + text.substring(idx, idx + query.length) + '</mark>';
          pos = idx + query.length;
        }
        result += text.substring(pos);
        parts[i] = result;
      }
      return parts.join('');
    },

    // Get the visible-row index for a given lineNum
    _getVisibleRowForLine(lineNum) {
      if (!this._visibleIndices) return -1;
      let row = 0;
      for (const dataIdx of this._visibleIndices) {
        if (this._lines[dataIdx].lineNum === lineNum && this._lines[dataIdx].type === 'line') return row;
        row++;
      }
      // Also check fold summaries
      row = 0;
      for (const dataIdx of this._visibleIndices) {
        if (this._lines[dataIdx].lineNum === lineNum) return row;
        row++;
      }
      return -1;
    },

    // Get the visible-row index for a func-block start
    _getVisibleRowForFunc(funcId) {
      if (!this._visibleIndices) return -1;
      let row = 0;
      for (const dataIdx of this._visibleIndices) {
        if (this._lines[dataIdx].funcId === funcId) return row;
        row++;
      }
      return -1;
    },

    renderOutline() {
      const panel = document.getElementById('code-outline');
      if (!panel) return;
      panel.innerHTML = '';
      const file = App.state.currentFile;
      if (!file || !file.functions || file.functions.length === 0) return;
      const funcs = [...file.functions].sort((a, b) => a.startLine - b.startLine);
      funcs.forEach(fn => {
        const item = document.createElement('div');
        item.className = 'outline-item';
        item.dataset.funcId = fn.id;
        item.dataset.line = fn.startLine;
        let label = '';
        if (fn.recvType) label += '<span class="outline-recv">' + this.esc(fn.recvType) + ' </span>';
        if (fn.isExported) label += '<span class="outline-exported">' + this.esc(fn.name) + '</span>';
        else label += this.esc(fn.name);
        item.innerHTML = label;
        item.title = fn.signature || fn.name;
        item.addEventListener('click', () => {
          App.scrollToLine(fn.startLine);
        });
        panel.appendChild(item);
      });
    },

    _scrollTrackTimer: null,
    trackScrollForOutline() {
      // Scroll tracking is now integrated into the main scroll handler in render()
      this._scrollTrackTimer = true;
    },

    updateOutlineActive() {
      const codeView = document.getElementById('code-view');
      const panel = document.getElementById('code-outline');
      if (!codeView || !panel || panel.classList.contains('hidden')) return;
      // Use scroll position to determine which func is visible
      const scrollTop = codeView.scrollTop;
      const midRow = Math.floor((scrollTop + codeView.clientHeight / 3) / this.LINE_HEIGHT);
      if (!this._visibleIndices || midRow >= this._visibleIndices.length) return;
      const dataIdx = this._visibleIndices[Math.min(midRow, this._visibleIndices.length - 1)];
      const entry = this._lines[dataIdx];
      const items = panel.querySelectorAll('.outline-item');
      items.forEach(it => it.classList.remove('active'));
      if (entry && entry.funcId) {
        const activeItem = panel.querySelector(`.outline-item[data-func-id="${CSS.escape(entry.funcId)}"]`);
        if (activeItem) {
          activeItem.classList.add('active');
          const panelRect = panel.getBoundingClientRect();
          const itemRect = activeItem.getBoundingClientRect();
          if (itemRect.top < panelRect.top || itemRect.bottom > panelRect.bottom) {
            activeItem.scrollIntoView({ block: 'nearest' });
          }
        }
      }
    },

    // Create a line-number span with bookmark dot and click/dblclick handlers
    makeLineNum(lineNum) {
      const filePath = App.state.currentFile ? App.state.currentFile.path : '';
      const bm = App.bookmarks.getLineBookmark(filePath, lineNum);
      const isFoldStart = App.state.foldStart === lineNum;
      const span = document.createElement('span');
      let cls = 'line-number';
      if (bm) cls += ' has-bookmark';
      if (isFoldStart) cls += ' fold-start';
      span.className = cls;
      if (bm) {
        span.innerHTML = '<span class="bm-dot" title="' + App.codeView.esc(bm.label) + '">●</span>' + lineNum;
      } else if (isFoldStart) {
        span.innerHTML = '<span class="fold-marker">▼</span>' + lineNum;
      } else {
        span.textContent = lineNum;
      }
      // Single click: fold operations
      span.addEventListener('click', (e) => {
        e.stopPropagation();
        if (App.state.foldStart === null) {
          App.state.foldStart = lineNum;
          span.classList.add('fold-start');
          span.innerHTML = '<span class="fold-marker">▼</span>' + lineNum;
        } else if (App.state.foldStart === lineNum) {
          App.state.foldStart = null;
          span.classList.remove('fold-start');
          span.textContent = lineNum;
        } else {
          const start = Math.min(App.state.foldStart, lineNum);
          const end = Math.max(App.state.foldStart, lineNum);
          App.state.foldStart = null;
          App.folds.add(filePath, start, end);
          App.codeView.render();
        }
      });
      // Double click: bookmark (original behavior)
      span.addEventListener('dblclick', (e) => {
        e.stopPropagation();
        e.preventDefault();
        App.state.foldStart = null;
        App.bookmarks.toggleLine(filePath, lineNum);
      });
      return span;
    },

    isCommentLine(line) {
      const t = line.trimStart();
      return t.startsWith('//') || t.startsWith('/*') || t.startsWith('*') && !t.startsWith('*/');
    },

    renderStatement(container, stmt, sourceLines) {
      for (let line = stmt.startLine; line <= stmt.endLine; line++) {
        if (line < 1 || line > sourceLines.length) continue;
        const el = document.createElement('div');
        el.className = 'stmt-line';
        let codeHtml = this.highlightSyntax(this.esc(sourceLines[line - 1]));
        if (line === stmt.startLine && stmt.callTarget) {
          const t = stmt.callTarget;
          const cls = t.isStdLib ? 'call-link stdlib' : (t.isExternal ? 'call-link external' : 'call-link');
          const escaped = this.esc(t.function);
          const linkHtml = `<span class="${cls}" data-func-id="${this.esc(t.funcId)}" title="${this.esc(t.funcId)}">${escaped}</span>`;
          const idx = codeHtml.indexOf(escaped);
          if (idx !== -1) codeHtml = codeHtml.substring(0, idx) + linkHtml + codeHtml.substring(idx + escaped.length);
        }
        el.innerHTML = `<span class="line-number">${line}</span><span class="line-code">${codeHtml}</span>`;
        container.appendChild(el);
      }
    },

    renderFoldGroup(container, stmts, category, count, sourceLines) {
      const group = document.createElement('div');
      group.className = 'fold-group';
      const labels = { log: 'log statement', error_check: 'error check', defer: 'defer' };
      const label = labels[category] || category;
      const summary = document.createElement('div');
      summary.className = 'fold-summary';
      summary.textContent = `▶ [${count} ${label}${count > 1 ? 's' : ''} hidden]`;
      group.appendChild(summary);
      const content = document.createElement('div');
      content.className = 'fold-content';
      stmts.forEach(stmt => this.renderStatement(content, stmt, sourceLines));
      group.appendChild(content);
      group.addEventListener('click', () => {
        group.classList.toggle('expanded');
        summary.textContent = group.classList.contains('expanded')
          ? `▼ [${count} ${label}${count > 1 ? 's' : ''}]`
          : `▶ [${count} ${label}${count > 1 ? 's' : ''} hidden]`;
      });
      container.appendChild(group);
    },

    esc(str) {
      return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    },

    // ---- File-internal search ----
    _searchMatches: [],

    _computeSearchMatches(query) {
      this._searchMatches = [];
      this._searchIdx = -1;
      const q = query.toLowerCase();
      const countEl = document.getElementById('code-search-count');
      for (let i = 0; i < this._lines.length; i++) {
        const entry = this._lines[i];
        if (entry.type !== 'line' && entry.type !== 'user-fold-content' && entry.type !== 'comment-fold-content') continue;
        // Get plain text from html by stripping tags
        const plainText = (entry.html || '').replace(/<[^>]+>/g, '').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>');
        if (plainText.toLowerCase().includes(q)) {
          this._searchMatches.push({ dataIdx: i, lineNum: entry.lineNum });
        }
      }
      if (countEl) {
        countEl.textContent = this._searchMatches.length > 0 ? `0/${this._searchMatches.length}` : 'No results';
      }
      // Force re-render to apply highlights
      this._visibleStart = -1; this._visibleEnd = -1;
      this._renderVisible();
    },

    fileSearch(query) {
      this._searchQuery = query || '';
      const countEl = document.getElementById('code-search-count');
      if (!query || query.length < 1) {
        this._searchMatches = [];
        this._searchIdx = -1;
        this._searchQuery = '';
        if (countEl) countEl.textContent = '';
        this._visibleStart = -1; this._visibleEnd = -1;
        this._renderVisible();
        return;
      }
      this._computeSearchMatches(query);
      if (this._searchMatches.length > 0) this.fileSearchNext();
    },

    fileSearchNext() {
      if (this._searchMatches.length === 0) return;
      this._searchIdx = (this._searchIdx + 1) % this._searchMatches.length;
      const match = this._searchMatches[this._searchIdx];
      // Scroll to the matched line
      const row = this._getVisibleRowForLine(match.lineNum);
      if (row >= 0) {
        const container = document.getElementById('code-view');
        container.scrollTop = Math.max(0, row * this.LINE_HEIGHT - container.clientHeight / 2);
      }
      document.getElementById('code-search-count').textContent = `${this._searchIdx + 1}/${this._searchMatches.length}`;
    },

    fileSearchPrev() {
      if (this._searchMatches.length === 0) return;
      this._searchIdx = (this._searchIdx - 1 + this._searchMatches.length) % this._searchMatches.length;
      const match = this._searchMatches[this._searchIdx];
      const row = this._getVisibleRowForLine(match.lineNum);
      if (row >= 0) {
        const container = document.getElementById('code-view');
        container.scrollTop = Math.max(0, row * this.LINE_HEIGHT - container.clientHeight / 2);
      }
      document.getElementById('code-search-count').textContent = `${this._searchIdx + 1}/${this._searchMatches.length}`;
    },

    clearSearch() {
      this._searchMatches = [];
      this._searchIdx = -1;
      this._searchQuery = '';
      this._visibleStart = -1; this._visibleEnd = -1;
      this._renderVisible();
      document.getElementById('code-search-count').textContent = '';
    },

    // Single-pass tokenizer — scans left-to-right, classifies each token, emits HTML spans.
    highlightSyntax(code) {
      const KW = new Set('func,return,if,else,for,range,switch,case,default,select,go,defer,chan,map,struct,interface,type,var,const,package,import,break,continue,fallthrough,goto'.split(','));
      const TYP = new Set('string,int,int8,int16,int32,int64,uint,uint8,uint16,uint32,uint64,float32,float64,complex64,complex128,bool,byte,rune,error,nil,true,false,iota,any,comparable'.split(','));
      const MULTI_OP = [':=','<-','...','&&','||','!=','==','>=','<=','++','--'];
      let out = '';
      let i = 0;
      const len = code.length;
      const peek = (off) => off < len ? code[off] : '';

      while (i < len) {
        if (code[i] === '/' && peek(i + 1) === '/') {
          out += '<span class=cmt>' + code.substring(i) + '</span>';
          break;
        }
        if (code[i] === '/' && peek(i + 1) === '*') {
          let j = i + 2;
          while (j < len - 1 && !(code[j] === '*' && code[j + 1] === '/')) j++;
          if (j < len - 1) j += 2; else j = len;
          out += '<span class=cmt>' + code.substring(i, j) + '</span>';
          i = j;
          continue;
        }
        if (code[i] === '&') {
          if (code.substring(i, i + 5) === '&amp;') { out += '&amp;'; i += 5; continue; }
          if (code.substring(i, i + 4) === '&lt;')  { out += '<span class=op>&lt;</span>';  i += 4; continue; }
          if (code.substring(i, i + 4) === '&gt;')  { out += '<span class=op>&gt;</span>';  i += 4; continue; }
          out += code[i]; i++; continue;
        }
        if (code[i] === '`') {
          let j = i + 1;
          while (j < len && code[j] !== '`') j++;
          if (j < len) j++;
          out += '<span class=str>' + code.substring(i, j) + '</span>';
          i = j;
          continue;
        }
        if (code[i] === '"') {
          let j = i + 1;
          while (j < len && code[j] !== '"') { if (code[j] === '\\') j++; j++; }
          if (j < len) j++;
          out += '<span class=str>' + code.substring(i, j) + '</span>';
          i = j;
          continue;
        }
        if (code[i] === "'" && i + 1 < len) {
          let j = i + 1;
          if (code[j] === '\\') j += 2; else j++;
          if (j < len && code[j] === "'") {
            j++;
            out += '<span class=str>' + code.substring(i, j) + '</span>';
            i = j;
            continue;
          }
        }
        if (/[0-9]/.test(code[i]) && (i === 0 || /[^a-zA-Z_]/.test(code[i - 1]))) {
          let j = i;
          if (code[j] === '0' && (peek(j + 1) === 'x' || peek(j + 1) === 'X')) {
            j += 2;
            while (j < len && /[0-9a-fA-F_]/.test(code[j])) j++;
          } else if (code[j] === '0' && (peek(j + 1) === 'b' || peek(j + 1) === 'B')) {
            j += 2;
            while (j < len && /[01_]/.test(code[j])) j++;
          } else if (code[j] === '0' && (peek(j + 1) === 'o' || peek(j + 1) === 'O')) {
            j += 2;
            while (j < len && /[0-7_]/.test(code[j])) j++;
          } else {
            while (j < len && /[0-9._eE]/.test(code[j])) {
              if ((code[j] === 'e' || code[j] === 'E') && (peek(j + 1) === '+' || peek(j + 1) === '-')) j++;
              j++;
            }
          }
          if (j < len && code[j] === 'i') j++;
          out += '<span class=num>' + code.substring(i, j) + '</span>';
          i = j;
          continue;
        }
        if (/[a-zA-Z_]/.test(code[i])) {
          let j = i;
          while (j < len && /[a-zA-Z0-9_]/.test(code[j])) j++;
          const word = code.substring(i, j);
          const after = code[j];
          if (KW.has(word)) {
            out += '<span class=kw>' + word + '</span>';
          } else if (TYP.has(word)) {
            out += '<span class=typ>' + word + '</span>';
          } else if (after === '(') {
            out += '<span class=fn>' + word + '</span>';
          } else if (after === '.' && j + 1 < len && /[A-Za-z_]/.test(code[j + 1])) {
            let k = j + 1;
            while (k < len && /[a-zA-Z0-9_]/.test(code[k])) k++;
            const nextWord = code.substring(j + 1, k);
            if (!KW.has(nextWord) && !TYP.has(nextWord) && code[k] === '(') {
              out += '<span class=pkg>' + word + '</span>.<span class=fn>' + nextWord + '</span>';
              i = k;
              continue;
            } else {
              out += word;
            }
          } else {
            out += word;
          }
          i = j;
          continue;
        }
        let matched = false;
        for (const op of MULTI_OP) {
          if (code.substring(i, i + op.length) === op) {
            out += '<span class=op>' + op + '</span>';
            i += op.length;
            matched = true;
            break;
          }
        }
        if (matched) continue;
        out += code[i];
        i++;
      }
      return out;
    },
  },

  // ============================================================
  //  INFO PANEL
  // ============================================================
  infoPanel: {
    async show(funcId) {
      try {
        const data = await App.api('/api/func?id=' + encodeURIComponent(funcId));
        document.getElementById('info-func-name').textContent = data.name || funcId;
        document.getElementById('info-signature').innerHTML = `<h4>Signature</h4><pre>${App.codeView.esc(data.signature || '')}</pre>`;

        const docEl = document.getElementById('info-doc');
        if (data.doc) {
          docEl.innerHTML = `<h4>Documentation</h4><pre>${App.codeView.esc(data.doc)}</pre>`;
          docEl.style.display = '';
        } else {
          docEl.style.display = 'none';
        }

        const cc = data.complexity <= 5 ? 'complexity-low' : (data.complexity <= 10 ? 'complexity-mid' : 'complexity-high');
        document.getElementById('info-meta').innerHTML = `
          <h4>Info</h4>
          <div class="meta-row"><span class="meta-label">File</span><span class="meta-value">${(data.filePath || '').split('/').slice(-2).join('/')}</span></div>
          <div class="meta-row"><span class="meta-label">Lines</span><span class="meta-value">${data.startLine} - ${data.endLine}</span></div>
          <div class="meta-row"><span class="meta-label">Complexity</span><span class="complexity-badge ${cc}">${data.complexity}</span></div>
          <div class="meta-row"><span class="meta-label">Exported</span><span class="meta-value">${data.isExported ? 'Yes' : 'No'}</span></div>
        `;

        const shortId = (id) => id.includes('/') ? id.substring(id.lastIndexOf('/') + 1) : id;

        const callersList = document.getElementById('callers-list');
        callersList.innerHTML = '';
        (data.callers || []).forEach(id => {
          const li = document.createElement('li');
          const a = document.createElement('a');
          a.textContent = shortId(id);
          a.title = id;
          a.addEventListener('click', () => App.selectFunc(id));
          li.appendChild(a);
          callersList.appendChild(li);
        });

        const calleesList = document.getElementById('callees-list');
        calleesList.innerHTML = '';
        (data.callees || []).forEach(id => {
          const li = document.createElement('li');
          const a = document.createElement('a');
          a.textContent = shortId(id);
          a.title = id;
          a.addEventListener('click', () => App.selectFunc(id));
          li.appendChild(a);
          calleesList.appendChild(li);
        });
      } catch {
        document.getElementById('info-func-name').textContent = funcId;
      }
    },
  },

  // ============================================================
  //  SEARCH
  // ============================================================
  search: {
    async run(query) {
      const container = document.getElementById('search-results');
      if (!query || query.length < 2) { container.classList.add('hidden'); return; }
      const results = await App.api('/api/search?q=' + encodeURIComponent(query));
      container.innerHTML = '';
      if (results.length === 0) {
        container.innerHTML = '<div class="search-item"><span class="sr-name">No results</span></div>';
      } else {
        results.slice(0, 30).forEach(r => {
          const item = document.createElement('div');
          item.className = 'search-item';
          if (r.type === 'text') {
            item.innerHTML = `<div class="sr-name">${App.codeView.esc(r.name)}</div><div class="sr-context">${App.codeView.esc(r.context || '')}</div>`;
          } else {
            item.innerHTML = `<div class="sr-name">${App.codeView.esc(r.name)}</div><div class="sr-path">${App.codeView.esc(r.package || r.filePath)}</div>`;
          }
          item.addEventListener('click', () => {
            container.classList.add('hidden');
            if (r.type === 'function') App.selectFunc(r.id);
            else App.loadFileToCodeView(r.filePath, r.line || 0);
          });
          container.appendChild(item);
        });
      }
      container.classList.remove('hidden');
    },
  },

  // ============================================================
  //  BOOKMARKS (line-level + function-level)
  // ============================================================
  bookmarks: {
    // Toggle a function bookmark (from graph context menu)
    toggleFunc(funcId) {
      const key = 'func:' + funcId;
      if (App.state.bookmarks[key]) {
        delete App.state.bookmarks[key];
      } else {
        const label = prompt('Bookmark label (optional):') || '';
        App.state.bookmarks[key] = { type: 'func', funcId, label, addedAt: new Date().toISOString() };
      }
      App.saveLocalState();
      this.renderList();
    },

    // Toggle a line bookmark (from clicking line number)
    toggleLine(filePath, lineNum) {
      const key = 'line:' + filePath + ':' + lineNum;
      if (App.state.bookmarks[key]) {
        delete App.state.bookmarks[key];
        App.saveLocalState();
        this.renderList();
        App.codeView.render();
        return;
      }
      const label = prompt('Bookmark label:');
      if (label === null) return; // cancelled
      App.state.bookmarks[key] = { type: 'line', filePath, line: lineNum, label: label || `Line ${lineNum}`, addedAt: new Date().toISOString() };
      App.saveLocalState();
      this.renderList();
      App.codeView.render();
    },

    // Check if a line has a bookmark
    getLineBookmark(filePath, lineNum) {
      const key = 'line:' + filePath + ':' + lineNum;
      return App.state.bookmarks[key] || null;
    },

    // Check if a func has a bookmark
    hasFuncBookmark(funcId) {
      return !!App.state.bookmarks['func:' + funcId];
    },

    renderList() {
      const container = document.getElementById('bookmark-list');
      container.innerHTML = '';
      const bm = App.state.bookmarks;
      const entries = Object.entries(bm);
      if (entries.length === 0) {
        container.innerHTML = '<div style="padding:16px;color:var(--text-dim);font-size:12px">No bookmarks yet</div>';
        return;
      }
      // Line bookmarks first, then func bookmarks
      const lineEntries = entries.filter(([, v]) => v.type === 'line');
      const funcEntries = entries.filter(([, v]) => v.type === 'func');
      lineEntries.forEach(([key, info]) => {
        const item = document.createElement('div');
        item.className = 'bookmark-item';
        const shortPath = info.filePath.split('/').slice(-2).join('/');
        item.innerHTML = `<div class="bm-name bm-line-name">${App.codeView.esc(info.label)}</div><div class="bm-note">${App.codeView.esc(shortPath)}:${info.line}</div>`;
        const removeBtn = document.createElement('span');
        removeBtn.className = 'bm-remove';
        removeBtn.textContent = '\u00d7';
        removeBtn.title = 'Remove';
        removeBtn.addEventListener('click', (e) => { e.stopPropagation(); delete App.state.bookmarks[key]; App.saveLocalState(); this.renderList(); App.codeView.render(); });
        item.appendChild(removeBtn);
        item.addEventListener('click', () => App.loadFileToCodeView(info.filePath, info.line));
        container.appendChild(item);
      });
      funcEntries.forEach(([key, info]) => {
        const item = document.createElement('div');
        item.className = 'bookmark-item';
        const name = info.funcId.split('.').pop();
        item.innerHTML = `<div class="bm-name">${App.codeView.esc(name)}</div>${info.label ? `<div class="bm-note">${App.codeView.esc(info.label)}</div>` : ''}`;
        const removeBtn = document.createElement('span');
        removeBtn.className = 'bm-remove';
        removeBtn.textContent = '\u00d7';
        removeBtn.title = 'Remove';
        removeBtn.addEventListener('click', (e) => { e.stopPropagation(); delete App.state.bookmarks[key]; App.saveLocalState(); this.renderList(); });
        item.appendChild(removeBtn);
        item.addEventListener('click', () => App.selectFunc(info.funcId));
        container.appendChild(item);
      });
    },

    async showChain() {
      // Chain mode: activate each bookmarked function in the chain canvas
      const funcIds = Object.values(App.state.bookmarks).filter(b => b.type === 'func').map(b => b.funcId);
      if (funcIds.length < 2) { alert('Need at least 2 function bookmarks for chain mode'); return; }
      App.chain.reset();
      for (const fid of funcIds) {
        await App.chain.activate(fid);
      }
    },
  },

  // ============================================================
  //  MUTE
  // ============================================================
  mute: {
    isMatch(funcId) {
      return App.state.muted.some(rule => {
        if (rule.type === 'func') return funcId === rule.pattern;
        if (rule.type === 'package') return funcId.startsWith(rule.pattern + '.');
        if (rule.type === 'stdlib') return App.state.stdlibIds.has(funcId);
        if (rule.type === 'pattern') {
          const regex = new RegExp(rule.pattern.replace(/\./g, '\\.').replace(/\*/g, '.*'));
          return regex.test(funcId);
        }
        return false;
      });
    },


    getMutedIds() { return App.state.muted.map(r => r.pattern); },

    addFunc(funcId) {
      if (!App.state.muted.some(r => r.type === 'func' && r.pattern === funcId)) {
        App.state.muted.push({ type: 'func', pattern: funcId });
        App.saveLocalState();
        this.renderList();
        App.chain.reloadCurrent();
      }
    },

    addPackage(funcId) {
      const lastDot = funcId.lastIndexOf('.');
      const pkg = lastDot > 0 ? funcId.substring(0, lastDot) : funcId;
      if (!App.state.muted.some(r => r.type === 'package' && r.pattern === pkg)) {
        App.state.muted.push({ type: 'package', pattern: pkg });
        App.saveLocalState();
        this.renderList();
        App.chain.reloadCurrent();
      }
    },

    renderList() {
      const container = document.getElementById('muted-list');
      container.innerHTML = '';
      if (App.state.muted.length === 0) {
        container.innerHTML = '<div style="padding:16px;color:var(--text-dim);font-size:12px">No mute rules</div>';
        return;
      }
      App.state.muted.forEach((rule, idx) => {
        const item = document.createElement('div');
        item.className = 'muted-item';
        item.innerHTML = `
          <span class="mute-pattern">${App.codeView.esc(rule.type)}: ${App.codeView.esc(rule.pattern)}${rule.builtin ? ' (built-in)' : ''}</span>
          <span class="mute-remove" title="Remove">×</span>
        `;
        item.querySelector('.mute-remove').addEventListener('click', () => {
          App.state.muted.splice(idx, 1);
          App.saveLocalState();
          this.renderList();
          App.chain.reloadCurrent();
        });
        container.appendChild(item);
      });
    },
  },
};

App.init();
