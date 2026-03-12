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
    graphData: null,        // current graph nodes/edges
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
    await this.tree.load();
    this.mute.renderList();
    this.bookmarks.renderList();
    // Don't load full project graph at startup — too many nodes cause lag.
    // Graph is shown when user clicks a function or double-clicks a node.
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
        this.graph.clearHighlights();
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
    document.getElementById('fit-btn').addEventListener('click', () => this.graph.fitToView());

    const depthSlider = document.getElementById('depth-slider');
    depthSlider.addEventListener('input', () => {
      document.getElementById('depth-value').textContent = depthSlider.value;
    });
    depthSlider.addEventListener('change', () => {
      if (this.state.currentFuncId) this.graph.loadSubgraph(this.state.currentFuncId, parseInt(depthSlider.value));
    });

    document.getElementById('color-mode').addEventListener('change', () => this.graph.recolor());

    // Bookmark chain
    document.getElementById('bookmark-chain-btn').addEventListener('click', (e) => {
      this.state.bookmarkChainMode = !this.state.bookmarkChainMode;
      e.target.classList.toggle('active', this.state.bookmarkChainMode);
      if (this.state.bookmarkChainMode) this.bookmarks.showChain();
      else this.graph.clearHighlights();
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
        this.graph.reloadCurrent();
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
    // If node is already in current graph, just highlight; otherwise load subgraph
    if (this.graph.nodeMap[funcId]) {
      await this.graph.highlightNode(funcId);
      this.graph.centerOnNode(funcId);
    } else {
      const depth = parseInt(document.getElementById('depth-slider').value);
      await this.graph.loadSubgraph(funcId, depth);
    }
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
  //  GRAPH ENGINE (dagre hierarchical layout)
  // ============================================================
  graph: {
    nodes: [],        // {id, label, pkg, x, y, w, h, isStdLib, isExported, complexity}
    edges: [],        // {from, to, fromNode, toNode, points}
    nodeMap: {},      // id -> node
    svg: null,
    gEdges: null,
    gNodes: null,
    // View transform
    vx: 0, vy: 0, vscale: 1,
    // Drag state
    dragNode: null,
    isPanning: false,
    panStart: null,
    // Package color map
    pkgColors: {},
    colorIdx: 0,
    _eventsBound: false,

    PALETTE: [
      '#89b4fa','#a6e3a1','#f9e2af','#cba6f7','#94e2d5',
      '#f38ba8','#fab387','#89dceb','#b4befe','#f2cdcd',
    ],

    // Track what's currently displayed so mute changes can refresh
    _currentFuncId: null,

    async loadSubgraph(funcId, depth) {
      try {
        this._currentFuncId = funcId;
        const muted = App.mute.getMutedIds().join(',');
        const url = `/api/callgraph?func=${encodeURIComponent(funcId)}&depth=${depth}${muted ? '&muted=' + encodeURIComponent(muted) : ''}`;
        delete App.state.cache[url];
        const data = await App.api(url);
        this.setData(data);
        this.highlightNode(funcId);
      } catch (e) { console.error('Failed to load subgraph:', e); }
    },

    reloadCurrent() {
      if (this._currentFuncId) {
        const depth = parseInt(document.getElementById('depth-slider').value);
        this.loadSubgraph(this._currentFuncId, depth);
      }
    },

    setData(data) {
      if (!data.nodes) data.nodes = [];
      if (!data.edges) data.edges = [];

      data.nodes.forEach(n => {
        if (n.isStdLib) App.state.stdlibIds.add(n.id);
      });

      App.state.graphData = data;

      const mutedSet = new Set();
      data.nodes = data.nodes.filter(n => {
        if (App.mute.isMatch(n.id)) { mutedSet.add(n.id); return false; }
        return true;
      });
      data.edges = data.edges.filter(e => !mutedSet.has(e.from) && !mutedSet.has(e.to));

      this.buildGraph(data);
      this.initSVG();
      this.renderPositions();
      this.fitToView();
    },

    buildGraph(data) {
      this.pkgColors = {};
      this.colorIdx = 0;
      this.nodeMap = {};

      const pkgSet = new Set(data.nodes.map(n => n.package || 'default'));
      for (const pkg of pkgSet) {
        this.pkgColors[pkg] = this.PALETTE[this.colorIdx % this.PALETTE.length];
        this.colorIdx++;
      }

      // Create dagre graph
      const g = new dagre.graphlib.Graph();
      g.setGraph({ rankdir: 'TB', nodesep: 40, ranksep: 80, edgesep: 20 });
      g.setDefaultEdgeLabel(() => ({}));

      this.nodes = [];
      data.nodes.forEach(n => {
        const labelLen = Math.max(n.label.length, 4);
        const w = labelLen * 8 + 24;
        const h = 30;
        g.setNode(n.id, { width: w, height: h });
        const node = {
          id: n.id, label: n.label,
          pkg: n.package || '', isStdLib: n.isStdLib,
          isExported: n.isExported, complexity: n.complexity || 1,
          x: 0, y: 0, w, h,
        };
        this.nodes.push(node);
        this.nodeMap[n.id] = node;
      });

      this.edges = [];
      data.edges.forEach(e => {
        const from = this.nodeMap[e.from];
        const to = this.nodeMap[e.to];
        if (from && to) {
          g.setEdge(e.from, e.to);
          this.edges.push({ from: e.from, to: e.to, fromNode: from, toNode: to });
        }
      });

      // Run dagre layout synchronously (fast for subgraphs)
      dagre.layout(g);

      this.nodes.forEach(node => {
        const ln = g.node(node.id);
        if (ln) { node.x = ln.x; node.y = ln.y; }
      });

      this.edges.forEach(edge => {
        const le = g.edge(edge.from, edge.to);
        if (le) edge.points = le.points;
      });
    },

    // Bind global pan/zoom/drag events once
    _bindGlobalEvents() {
      if (this._eventsBound) return;
      this._eventsBound = true;
      const container = document.getElementById('graph-container');
      const svg = document.getElementById('graph-svg');

      container.addEventListener('mousedown', (e) => {
        if (e.target === svg || e.target === container) {
          this.isPanning = true;
          this.panStart = { x: e.clientX, y: e.clientY, vx: this.vx, vy: this.vy };
          this._panDist = 0;
          container.classList.add('grabbing');
        }
      });

      window.addEventListener('mousemove', (e) => {
        if (this.dragNode) {
          const pt = this.screenToWorld(e.clientX, e.clientY);
          this.dragNode.x = pt.x;
          this.dragNode.y = pt.y;
          if (this.dragNode._dragStart) {
            const dx = e.clientX - this.dragNode._dragStart.x;
            const dy = e.clientY - this.dragNode._dragStart.y;
            this.dragNode._dragDist = Math.sqrt(dx * dx + dy * dy);
          }
          this.renderPositions();
        } else if (this.isPanning && this.panStart) {
          const dx = e.clientX - this.panStart.x;
          const dy = e.clientY - this.panStart.y;
          this._panDist = Math.sqrt(dx * dx + dy * dy);
          this.vx = this.panStart.vx + dx;
          this.vy = this.panStart.vy + dy;
          this.updateViewBox();
        }
      });

      window.addEventListener('mouseup', () => {
        if (this.dragNode) {
          this.dragNode = null;
        }
        if (this.isPanning) {
          this.isPanning = false;
          document.getElementById('graph-container').classList.remove('grabbing');
          this.panStart = null;
        }
      });

      container.addEventListener('wheel', (e) => {
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

        this.updateViewBox();
        document.getElementById('zoom-level').textContent = Math.round(this.vscale * 100) + '%';

      }, { passive: false });

      svg.addEventListener('click', () => {
        if (this._panDist > 5) return;
        this.clearHighlights();
        App.state.currentFuncId = null;
      });
    },

    initSVG() {
      this._bindGlobalEvents();
      const svg = document.getElementById('graph-svg');
      this.svg = svg;
      svg.innerHTML = '';

      const ns = 'http://www.w3.org/2000/svg';
      const defs = document.createElementNS(ns, 'defs');

      ['default','caller','callee'].forEach(type => {
        const marker = document.createElementNS(ns, 'marker');
        marker.setAttribute('id', 'arrow-' + type);
        marker.setAttribute('viewBox', '0 0 10 10');
        marker.setAttribute('refX', '10');
        marker.setAttribute('refY', '5');
        marker.setAttribute('markerWidth', '8');
        marker.setAttribute('markerHeight', '8');
        marker.setAttribute('orient', 'auto-start-reverse');
        const path = document.createElementNS(ns, 'path');
        path.setAttribute('d', 'M 0 1 L 10 5 L 0 9 z');
        const colors = { default: '#3b3e52', caller: '#89b4fa', callee: '#a6e3a1' };
        path.setAttribute('fill', colors[type]);
        marker.appendChild(path);
        defs.appendChild(marker);
      });

      svg.appendChild(defs);

      this.gEdges = document.createElementNS(ns, 'g');
      this.gEdges.setAttribute('class', 'edges-layer');
      svg.appendChild(this.gEdges);

      this.gNodes = document.createElementNS(ns, 'g');
      this.gNodes.setAttribute('class', 'nodes-layer');
      svg.appendChild(this.gNodes);

      // Create edge elements
      this.edges.forEach(edge => {
        const path = document.createElementNS(ns, 'path');
        path.setAttribute('class', 'graph-edge');
        path.setAttribute('marker-end', 'url(#arrow-default)');
        path.dataset.from = edge.from;
        path.dataset.to = edge.to;
        edge.el = path;
        this.gEdges.appendChild(path);
      });

      // Create node elements
      const colorMode = document.getElementById('color-mode').value;
      this.nodes.forEach(node => {
        const g = document.createElementNS(ns, 'g');
        g.setAttribute('class', 'graph-node');
        g.dataset.funcId = node.id;

        const rect = document.createElementNS(ns, 'rect');
        rect.setAttribute('width', node.w);
        rect.setAttribute('height', node.h);
        rect.setAttribute('rx', '6');
        rect.setAttribute('fill', this.getNodeFill(node, colorMode));
        rect.setAttribute('stroke', this.getNodeStroke(node));
        if (node.isStdLib) rect.setAttribute('stroke-dasharray', '4,3');

        const text = document.createElementNS(ns, 'text');
        text.setAttribute('text-anchor', 'middle');
        text.setAttribute('dominant-baseline', 'central');
        text.setAttribute('fill', node.isStdLib ? '#585b70' : '#cdd6f4');
        text.setAttribute('font-size', node.isStdLib ? '10' : '12');
        text.textContent = node.label.length > 18 ? node.label.substring(0, 16) + '..' : node.label;

        g.appendChild(rect);
        g.appendChild(text);
        node.el = g;
        node.rectEl = rect;
        node.textEl = text;

        g.addEventListener('click', (e) => {
          e.stopPropagation();
          if (node._dragDist > 5) return;
          // Delay single-click so double-click can cancel it
          clearTimeout(node._clickTimer);
          node._clickTimer = setTimeout(() => App.selectFunc(node.id), 250);
        });

        g.addEventListener('dblclick', (e) => {
          e.stopPropagation();
          clearTimeout(node._clickTimer);
          App.state.currentFuncId = node.id;
          const depth = parseInt(document.getElementById('depth-slider').value);
          this.loadSubgraph(node.id, depth);
        });

        g.addEventListener('contextmenu', (e) => {
          e.preventDefault();
          e.stopPropagation();
          App.showContextMenu(e, node.id);
        });

        g.addEventListener('mouseenter', (e) => {
          const tip = document.getElementById('tooltip');
          tip.textContent = `${node.id}\nPkg: ${node.pkg}\nComplexity: ${node.complexity}`;
          tip.style.left = (e.clientX + 12) + 'px';
          tip.style.top = (e.clientY + 12) + 'px';
          tip.classList.remove('hidden');
        });

        g.addEventListener('mouseleave', () => {
          document.getElementById('tooltip').classList.add('hidden');
        });

        g.addEventListener('mousedown', (e) => {
          if (e.button !== 0) return;
          e.stopPropagation();
          this.dragNode = node;
          node._dragStart = { x: e.clientX, y: e.clientY };
          node._dragDist = 0;
        });

        this.gNodes.appendChild(g);
      });
    },

    screenToWorld(sx, sy) {
      const container = document.getElementById('graph-container');
      const rect = container.getBoundingClientRect();
      return {
        x: (sx - rect.left - this.vx) / this.vscale,
        y: (sy - rect.top - this.vy) / this.vscale,
      };
    },

    updateViewBox() {
      const container = document.getElementById('graph-container');
      const w = container.clientWidth;
      const h = container.clientHeight;
      const viewX = -this.vx / this.vscale;
      const viewY = -this.vy / this.vscale;
      const viewW = w / this.vscale;
      const viewH = h / this.vscale;
      this.svg.setAttribute('viewBox', `${viewX} ${viewY} ${viewW} ${viewH}`);
    },

    fitToView() {
      if (this.nodes.length === 0) return;
      const container = document.getElementById('graph-container');
      const W = container.clientWidth;
      const H = container.clientHeight;
      if (!W || !H) return;

      let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
      this.nodes.forEach(n => {
        if (!isFinite(n.x) || !isFinite(n.y)) return;
        minX = Math.min(minX, n.x - n.w / 2);
        minY = Math.min(minY, n.y - n.h / 2);
        maxX = Math.max(maxX, n.x + n.w / 2);
        maxY = Math.max(maxY, n.y + n.h / 2);
      });
      if (!isFinite(minX)) return; // all nodes have bad positions

      const pad = 60;
      const gw = maxX - minX + pad * 2;
      const gh = maxY - minY + pad * 2;
      this.vscale = Math.min(W / gw, H / gh, 2);
      this.vx = (W - gw * this.vscale) / 2 - (minX - pad) * this.vscale;
      this.vy = (H - gh * this.vscale) / 2 - (minY - pad) * this.vscale;

      this.updateViewBox();
      document.getElementById('zoom-level').textContent = Math.round(this.vscale * 100) + '%';
    },

    centerOnNode(funcId) {
      const node = this.nodeMap[funcId];
      if (!node) return;
      const container = document.getElementById('graph-container');
      const W = container.clientWidth;
      const H = container.clientHeight;
      this.vx = W / 2 - node.x * this.vscale;
      this.vy = H / 2 - node.y * this.vscale;
      this.updateViewBox();
    },

    renderPositions() {
      // Update node positions
      this.nodes.forEach(node => {
        if (!node.el) return;
        node.rectEl.setAttribute('x', node.x - node.w / 2);
        node.rectEl.setAttribute('y', node.y - node.h / 2);
        node.textEl.setAttribute('x', node.x);
        node.textEl.setAttribute('y', node.y);
      });

      // Update edge paths using dagre edge points
      this.edges.forEach(edge => {
        if (!edge.el) return;
        if (edge.points && edge.points.length >= 2) {
          const pts = edge.points;
          // Shorten the last segment to stop at node border (for arrow marker)
          const last = pts[pts.length - 1];
          const prev = pts[pts.length - 2];
          const b = edge.toNode;
          const dx = last.x - prev.x, dy = last.y - prev.y;
          const dist = Math.sqrt(dx * dx + dy * dy) || 1;
          const endX = last.x - (dx / dist) * (b.h / 2 + 4);
          const endY = last.y - (dy / dist) * (b.h / 2 + 4);
          let d = `M ${pts[0].x} ${pts[0].y}`;
          for (let i = 1; i < pts.length - 1; i++) {
            d += ` L ${pts[i].x} ${pts[i].y}`;
          }
          d += ` L ${endX} ${endY}`;
          edge.el.setAttribute('d', d);
        } else {
          const a = edge.fromNode, b = edge.toNode;
          edge.el.setAttribute('d', `M ${a.x} ${a.y} L ${b.x} ${b.y}`);
        }
      });
    },

    // ---- Node styling ----
    getNodeFill(node, colorMode) {
      if (node.isStdLib) return 'rgba(49,50,68,0.6)';
      if (colorMode === 'complexity') {
        if (node.complexity <= 3) return 'rgba(166,227,161,0.15)';
        if (node.complexity <= 8) return 'rgba(249,226,175,0.15)';
        return 'rgba(243,139,168,0.15)';
      }
      // By package
      const color = this.pkgColors[node.pkg] || '#89b4fa';
      return this.hexToRGBA(color, 0.12);
    },

    getNodeStroke(node) {
      if (node.isStdLib) return '#3b3e52';
      const color = this.pkgColors[node.pkg] || '#89b4fa';
      return color;
    },

    hexToRGBA(hex, alpha) {
      const r = parseInt(hex.slice(1, 3), 16);
      const g = parseInt(hex.slice(3, 5), 16);
      const b = parseInt(hex.slice(5, 7), 16);
      return `rgba(${r},${g},${b},${alpha})`;
    },

    recolor() {
      const colorMode = document.getElementById('color-mode').value;
      this.nodes.forEach(node => {
        if (node.rectEl) {
          node.rectEl.setAttribute('fill', this.getNodeFill(node, colorMode));
        }
      });
    },

    // ---- Highlighting ----
    async highlightNode(funcId) {
      try {
        const data = await App.api('/api/func?id=' + encodeURIComponent(funcId));
        const callers = new Set(data.callers || []);
        const callees = new Set(data.callees || []);

        App.state.highlights = { callers: [...callers], current: funcId, callees: [...callees] };

        // Highlight nodes
        this.nodes.forEach(node => {
          node.el.classList.remove('selected', 'caller', 'callee', 'dimmed');
          if (node.id === funcId) {
            node.el.classList.add('selected');
          } else if (callers.has(node.id)) {
            node.el.classList.add('caller');
          } else if (callees.has(node.id)) {
            node.el.classList.add('callee');
          } else {
            node.el.classList.add('dimmed');
          }
        });

        // Highlight edges
        this.edges.forEach(edge => {
          edge.el.classList.remove('highlighted-caller', 'highlighted-callee', 'dimmed');
          if (edge.to === funcId && callers.has(edge.from)) {
            edge.el.classList.add('highlighted-caller');
            edge.el.setAttribute('marker-end', 'url(#arrow-caller)');
          } else if (edge.from === funcId && callees.has(edge.to)) {
            edge.el.classList.add('highlighted-callee');
            edge.el.setAttribute('marker-end', 'url(#arrow-callee)');
          } else {
            edge.el.classList.add('dimmed');
            edge.el.setAttribute('marker-end', 'url(#arrow-default)');
          }
        });
      } catch {
        // Just select the node visually
        this.nodes.forEach(node => {
          node.el.classList.remove('selected', 'caller', 'callee', 'dimmed');
          if (node.id === funcId) node.el.classList.add('selected');
        });
      }
    },

    clearHighlights() {
      App.state.highlights = null;
      this.nodes.forEach(node => {
        node.el.classList.remove('selected', 'caller', 'callee', 'dimmed');
      });
      this.edges.forEach(edge => {
        edge.el.classList.remove('highlighted-caller', 'highlighted-callee', 'dimmed');
        edge.el.setAttribute('marker-end', 'url(#arrow-default)');
      });
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

        const callersList = document.getElementById('callers-list');
        callersList.innerHTML = '';
        (data.callers || []).forEach(id => {
          const li = document.createElement('li');
          const a = document.createElement('a');
          a.textContent = id.split('.').pop();
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
          a.textContent = id.split('.').pop();
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
      // Chain mode uses only func bookmarks
      const funcIds = Object.values(App.state.bookmarks).filter(b => b.type === 'func').map(b => b.funcId);
      if (funcIds.length < 2) { alert('Need at least 2 function bookmarks for chain mode'); return; }
      try {
        const muted = App.mute.getMutedIds().join(',');
        const url = '/api/chain?nodes=' + encodeURIComponent(funcIds.join(',')) + (muted ? '&muted=' + encodeURIComponent(muted) : '');
        const data = await App.api(url);
        const chainIds = new Set(data.nodes.map(n => n.id));
        const funcBmIds = new Set(funcIds);
        App.graph.nodes.forEach(node => {
          node.el.classList.remove('selected', 'caller', 'callee', 'dimmed');
          if (chainIds.has(node.id)) {
            node.el.classList.add(funcBmIds.has(node.id) ? 'selected' : 'callee');
          } else {
            node.el.classList.add('dimmed');
          }
        });
        App.graph.edges.forEach(edge => {
          edge.el.classList.remove('highlighted-caller', 'highlighted-callee', 'dimmed');
          if (chainIds.has(edge.from) && chainIds.has(edge.to)) {
            edge.el.classList.add('highlighted-callee');
          } else {
            edge.el.classList.add('dimmed');
          }
        });
      } catch {}
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
        App.graph.reloadCurrent();
      }
    },

    addPackage(funcId) {
      const lastDot = funcId.lastIndexOf('.');
      const pkg = lastDot > 0 ? funcId.substring(0, lastDot) : funcId;
      if (!App.state.muted.some(r => r.type === 'package' && r.pattern === pkg)) {
        App.state.muted.push({ type: 'package', pattern: pkg });
        App.saveLocalState();
        this.renderList();
        App.graph.reloadCurrent();
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
          App.graph.reloadCurrent();
        });
        container.appendChild(item);
      });
    },
  },
};

App.init();
