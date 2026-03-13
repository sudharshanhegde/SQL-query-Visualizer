
(function () {
  'use strict';

  const parser = new SQLParser();

  // Multi-query navigation state
  let allSelectResults = [], currentSelectIdx = 0, lastStatements = [];

  /* DOM References like for real refferal */
  const $ = (sel) => document.querySelector(sel);
  const sqlInput    = $('#sqlInput');
  const parseBtn    = $('#parseBtn');
  const clearBtn    = $('#clearBtn');
  const loadSample  = $('#loadSample');
  const parseError  = $('#parseError');
  const emptyState  = $('#emptyState');
  const vizContent  = $('#vizContent');
  const summaryBar  = $('#summaryBar');
  const tablesGrid  = $('#tablesGrid');
  const columnsList = $('#columnsList');
  const condView    = $('#conditionsView');
  const ctesView    = $('#ctesView');
  const themeToggle    = $('#themeToggle');
  const statementsView = $('#statementsView');

  /* Theme is good cause its sunny or night here */
  themeToggle.addEventListener('click', () => {
    const current = document.documentElement.getAttribute('data-theme');
    document.documentElement.setAttribute('data-theme', current === 'light' ? '' : 'light');
    themeToggle.textContent = current === 'light' ? '☾' : '☀';
  });

  /* Ofcourse you can switch between tabs please we are not that old */
  document.querySelectorAll('.tab').forEach(tab => {
    tab.addEventListener('click', () => {
      document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
      document.querySelectorAll('.tab-content').forEach(t => t.classList.remove('active'));
      tab.classList.add('active');
      $(`#tab-${tab.dataset.tab}`).classList.add('active');
    });
  });

  /* Parsing the button because who else will do this for you */
  parseBtn.addEventListener('click', visualize);
  sqlInput.addEventListener('keydown', e => {
    if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') visualize();
  });
  clearBtn.addEventListener('click', () => {
    sqlInput.value = '';
    showEmpty();
    hideError();
  });

  /* Sample sql just in case you forgot what is sql */
  loadSample.addEventListener('click', () => {
    sqlInput.value = SAMPLE_SQL;
    visualize();
  });

  /* This function is god,it helps visualise everything  */
  function visualize() {
    hideError();
    const sql = sqlInput.value.trim();
    if (!sql) { showError('Please enter a SQL query.'); return; }

    let statements;
    try {
      statements = parser.parseAll(sql);
    } catch (err) {
      showError('Parse error: ' + err.message);
      return;
    }

    if (!statements.length) {
      showError('No recognizable SQL statements found.');
      return;
    }

    // Collect ALL SELECT results (including those nested inside IF/WHILE/TRY blocks and procedures)
    function collectSelects(stmts) {
      const selects = [];
      for (const s of stmts) {
        if (s.stmtType === 'SELECT') {
          const firstName = s.tables.filter(t => !t.isSubquery)[0]?.name;
          const label = s.tables && s.tables.length && firstName
            ? 'SELECT · ' + firstName
            : 'SELECT';
          selects.push({ ...s, _label: label });
        }
        if (s.stmtType === 'INSERT' && s.selectResult) {
          const tbl  = s.targetTable ? s.targetTable.split('.').pop() : '';
          const from = s.selectResult.tables && s.selectResult.tables.filter(t => !t.isSubquery)[0];
          const label = 'INSERT→' + tbl + (from ? ' · ' + from.name : '');
          selects.push({ ...s.selectResult, _label: label });
        }
        if (s.stmtType === 'IF') {
          selects.push(...collectSelects(s.thenStmts || []));
          selects.push(...collectSelects(s.elseStmts || []));
        }
        if (s.stmtType === 'WHILE')       selects.push(...collectSelects(s.bodyStmts  || []));
        if (s.stmtType === 'BEGIN_BLOCK')  selects.push(...collectSelects(s.bodyStmts  || []));
        if (s.stmtType === 'TRY_BLOCK') {
          selects.push(...collectSelects(s.tryStmts   || []));
          selects.push(...collectSelects(s.catchStmts || []));
        }
        if (s.stmtType === 'CREATE' && s.bodyStmts)
          selects.push(...collectSelects(s.bodyStmts));
      }
      return selects;
    }

    allSelectResults = collectSelects(statements);
    lastStatements   = statements;
    currentSelectIdx = 0;

    const emptyResult = {
      stmtType: 'SELECT', tables: [], joins: [], columns: [], ctes: [],
      conditions: { where: null, groupBy: [], having: null, orderBy: [] }
    };
    const mainResult = allSelectResults[0] || emptyResult;

    emptyState.classList.add('hidden');
    vizContent.classList.remove('hidden');

    renderVisualization(mainResult, statements);
  }

  function renderVisualization(result, statements) {
    renderQueryNav();
    renderSummary(result, statements);
    renderDiagram(result);
    renderTables(result);
    renderColumns(result);
    renderConditions(result);
    renderCTEs(result);
    renderStatements(statements);
  }

  /* Query navigation bar — shows "← Q 2 / 9 — INSERT→WorkflowFormMapping → " */
  function renderQueryNav() {
    const nav = $('#queryNav');
    if (!nav) return;

    if (allSelectResults.length <= 1) {
      nav.classList.add('hidden');
      return;
    }
    nav.classList.remove('hidden');

    const q     = allSelectResults[currentSelectIdx];
    const label = q._label || ('Query ' + (currentSelectIdx + 1));
    nav.innerHTML = `
      <button class="qnav-btn" id="queryPrev" title="Previous query" ${currentSelectIdx === 0 ? 'disabled' : ''}>&#8592;</button>
      <span class="qnav-center">
        <span class="qnav-label">
          <span class="qnav-pos">${currentSelectIdx + 1} / ${allSelectResults.length}</span>
          <span class="qnav-lbl">${esc(label)}</span>
        </span>
        <span class="qnav-hint">Use arrows to browse all queries &amp; see their tables in the diagram</span>
      </span>
      <button class="qnav-btn" id="queryNext" title="Next query" ${currentSelectIdx === allSelectResults.length - 1 ? 'disabled' : ''}>&#8594;</button>
    `;

    $('#queryPrev').addEventListener('click', () => goToQuery(currentSelectIdx - 1));
    $('#queryNext').addEventListener('click', () => goToQuery(currentSelectIdx + 1));
  }

  function goToQuery(idx) {
    currentSelectIdx = Math.max(0, Math.min(idx, allSelectResults.length - 1));
    const res = allSelectResults[currentSelectIdx];
    renderQueryNav();
    renderSummary(res, lastStatements);
    renderDiagram(res);
    renderTables(res);
    renderColumns(res);
    renderConditions(res);
    renderCTEs(res);
    // Statements tab always shows all statements — no re-render needed
  }

  /* Ofcourse we need a summary bar or how else will you know? */
  function renderSummary(result, statements = []) {
    const items = [
      { label: 'Tables',  count: result.tables.filter(t => !t.isSubquery).length },
      { label: 'Joins',   count: result.joins.length },
      { label: 'Columns', count: result.columns.length },
      { label: 'CTEs',    count: result.ctes.length },
    ];

    // Join types
    const types = {};
    result.joins.forEach(j => {
      const t = normalizeJoinType(j.type);
      types[t] = (types[t] || 0) + 1;
    });
    Object.entries(types).forEach(([t, n]) => {
      items.push({ label: t, count: n });
    });

    // Set operation chip (UNION / INTERSECT / EXCEPT)
    if (result.setOp && result.setOp.operators.length) {
      const ops = [...new Set(result.setOp.operators)].join('/');
      items.push({ label: ops, count: result.setOp.branches.length, color: '#e879f9' });
    }

    // Non-SELECT statement type counts there might be insert update alter right who will handle it us.
    const nonSelect = statements.filter(s => s.stmtType !== 'SELECT');
    const typeCounts = {};
    nonSelect.forEach(s => { typeCounts[s.stmtType] = (typeCounts[s.stmtType] || 0) + 1; });
    Object.entries(typeCounts).forEach(([type, count]) => {
      items.push({ label: type, count, color: stmtColor(type) });
    });

    summaryBar.innerHTML = items.map(c => `
      <div class="summary-chip">
        <span>${c.label}</span>
        <span class="summary-chip-count" ${c.color ? `style="background:${c.color}"` : ''}>${c.count}</span>
      </div>`).join('');
  }

  /* Joins are tough I know but this will make that easy for you */
  function renderDiagram(result) {
    const svg = document.getElementById('joinDiagram');
    svg.innerHTML = '';

    const tables = result.tables;
    const joins  = result.joins;

    if (tables.length === 0) {
      const t = document.createElementNS('http://www.w3.org/2000/svg', 'text');
      t.setAttribute('x', '50%'); t.setAttribute('y', '50%');
      t.setAttribute('text-anchor', 'middle');
      t.setAttribute('fill', '#5a647a');
      t.setAttribute('font-size', '14');
      t.textContent = 'No tables found';
      svg.appendChild(t);
      return;
    }

    // Read actual color values from computed style so they work inside SVG
    const isDark = document.documentElement.getAttribute('data-theme') !== 'light';
    const C = {
      text:      isDark ? '#e2e8f0' : '#1a202c',
      textMuted: isDark ? '#8892a4' : '#4a5568',
      textDim:   isDark ? '#5a647a' : '#a0aec0',
      bg:        isDark ? '#1a1d27' : '#ffffff',
      bgRow:     isDark ? '#21253a' : '#f8fafc',
    };

    const NS = 'http://www.w3.org/2000/svg';
    const mk = (tag, attrs = {}) => {
      const e = document.createElementNS(NS, tag);
      Object.entries(attrs).forEach(([k, v]) => e.setAttribute(k, v));
      return e;
    };
    const mkt = (x, y, content, attrs = {}) => {
      const e = mk('text', { x, y, ...attrs });
      e.textContent = content;
      return e;
    };

    /* Layout constants so they dont overflow */
    const NODE_W  = 220;  // fixed node width
    const HDR_H   = 42;   // header height
    const ROW_H   = 24;   // per-column row height
    const PAD     = 10;   // inner padding
    const MARGIN  = 40;   // outer margin

    /* Column data */
    const colsForTable = {};
    result.columns.forEach(col => {
      if (!col.sourceTable) return;
      const k = col.sourceTable.toLowerCase();
      if (!colsForTable[k]) colsForTable[k] = [];
      if (!colsForTable[k].some(c => c.expression === col.expression))
        colsForTable[k].push(col);
    });

    const joinKeysForTable = {};
    result.joins.forEach(join => {
      (join.condColumns || []).forEach(ref => {
        const k = ref.table.toLowerCase();
        if (!joinKeysForTable[k]) joinKeysForTable[k] = new Set();
        joinKeysForTable[k].add(ref.column);
      });
    });

    /*Compute node heights so that spacing between nodes can be made properly for visualization*/
    const nodeData = tables.map((tbl, i) => {
      const keys = [tbl.name.toLowerCase()];
      if (tbl.alias) keys.push(tbl.alias.toLowerCase());

      const selCols = [];
      const seen = new Set();
      keys.forEach(k => (colsForTable[k] || []).forEach(c => {
        if (!seen.has(c.expression)) { seen.add(c.expression); selCols.push(c); }
      }));

      const selExprs = new Set(selCols.map(c => c.expression.toLowerCase()));
      const joinKeys = [];
      const seenK = new Set();
      keys.forEach(k => (joinKeysForTable[k] || new Set()).forEach(col => {
        if (!seenK.has(col.toLowerCase()) && !selExprs.has(col.toLowerCase())) {
          seenK.add(col.toLowerCase()); joinKeys.push(col);
        }
      }));

      // rowOf[colName] = y-center of that row, relative to node top.
      // Used so edges connect at the exact column row rather than the header center.
      const rowOf = {};
      let rY = HDR_H + PAD;
      if (selCols.length === 0) {
        rY += ROW_H;  // "no columns referenced" placeholder
      } else {
        selCols.forEach(col => {
          const yc    = rY + ROW_H / 2;
          const raw   = col.expression.toLowerCase();
          const short = raw.includes('.') ? raw.split('.').pop() : raw;
          rowOf[raw] = yc;  rowOf[short] = yc;
          if (col.alias) rowOf[col.alias.toLowerCase()] = yc;
          rY += ROW_H;
        });
      }
      if (joinKeys.length > 0) {
        rY += 8;  // dashed separator
        joinKeys.forEach(col => { rowOf[col.toLowerCase()] = rY + ROW_H / 2; rY += ROW_H; });
      }

      // For subquery nodes: show the inner FROM tables as extra rows
      const innerTables = (tbl.isSubquery && tbl.innerResult && tbl.innerResult.tables.length)
        ? tbl.innerResult.tables.filter(t => !t.isSubquery).map(t => t.alias ? `${t.name} (${t.alias})` : t.name)
        : [];

      const rowCount = Math.max(selCols.length, 1)
        + (joinKeys.length   > 0 ? joinKeys.length   + 1 : 0)
        + (innerTables.length > 0 ? innerTables.length + 1 : 0);
      const nodeH    = HDR_H + PAD + rowCount * ROW_H + PAD;
      return { tbl, selCols, joinKeys, innerTables, nodeH, rowOf, idx: i };
    });

    /* Build join graph */
    // Map every table name / alias → its index in tables[]
    const idxOf = {};
    tables.forEach((t, i) => {
      idxOf[t.name.toLowerCase()] = i;
      if (t.alias) idxOf[t.alias.toLowerCase()] = i;
    });

    // One edge per JOIN, with resolved from/to indices
    const edges = [];
    joins.forEach(join => {
      const toKey = (join.tableAlias || join.tableName || '').toLowerCase();
      const toIdx = idxOf[toKey];
      if (toIdx === undefined) return;

      let fromIdx = 0;   // default: the main FROM table
      for (const ref of (join.condColumns || [])) {
        const k = ref.table.toLowerCase();
        if (k !== toKey && idxOf[k] !== undefined) { fromIdx = idxOf[k]; break; }
      }
      edges.push({ from: fromIdx, to: toIdx, join });
    });

    /*  Assign tree depth via BFS (yes we do level order traversal voho dsa.) */
    // Each table gets a "level" (column in the diagram).
    // Main FROM table = level 0; tables it joins = level 1; their joins = level 2 and so on
    const levels = new Array(tables.length).fill(-1);
    levels[0] = 0;
    const bfsQ = [0];
    while (bfsQ.length) {
      const curr = bfsQ.shift();
      for (const e of edges) {
        if (e.from === curr && levels[e.to] < 0) {
          levels[e.to] = levels[curr] + 1;
          bfsQ.push(e.to);
        }
      }
    }
    tables.forEach((_, i) => { if (levels[i] < 0) levels[i] = 1; });

    /* Calculate (x, y) for every node  */
    const LEVEL_GAP = 240;   // horizontal gap between depth columns
    const ROW_GAP   = 64;    // vertical gap between nodes within a column
    const numLevels = Math.max(...levels) + 1;

    const byLevel = Array.from({ length: numLevels }, () => []);
    levels.forEach((lv, i) => byLevel[lv].push(i));

    // posArr[i] = { x, y } for table index i
    const posArr = new Array(tables.length);
    byLevel.forEach((idxs, lv) => {
      const x = MARGIN + lv * (NODE_W + LEVEL_GAP);
      let y = MARGIN;
      idxs.forEach(i => {
        posArr[i] = { x, y };
        y += nodeData[i].nodeH + ROW_GAP;
      });
    });

    // Keep name/alias → pos lookup for the existing node-drawing loop
    const positions = {};
    tables.forEach((t, i) => {
      const p = { ...posArr[i], idx: i };
      positions[t.name.toLowerCase()] = p;
      if (t.alias) positions[t.alias.toLowerCase()] = p;
    });

    /* SVG canvas size so that joins can be displayed properly  */
    const colH = lv =>
      byLevel[lv].reduce((s, i) => s + nodeData[i].nodeH + ROW_GAP, -ROW_GAP);
    const SVG_W = MARGIN + numLevels * (NODE_W + LEVEL_GAP) - LEVEL_GAP + MARGIN;
    const SVG_H = MARGIN + Math.max(...byLevel.map((_, lv) => colH(lv))) + MARGIN;

    svg.setAttribute('viewBox', `0 0 ${SVG_W} ${SVG_H}`);
    svg.style.width  = SVG_W + 'px';
    svg.style.height = SVG_H + 'px';

    const edgeGroup = mk('g', {});
    svg.appendChild(edgeGroup);
    const nodeGroup = mk('g', {});
    svg.appendChild(nodeGroup);

    // Distinct colours assigned per edge so every line from the same table
    // is visually unique and easy to trace.
    const EDGE_PALETTE = [
      '#4f8ef7', '#34d399', '#f59e0b', '#a78bfa', '#f87171',
      '#22d3ee', '#fb923c', '#e879f9', '#86efac', '#fde68a',
      '#60a5fa', '#c084fc', '#4ade80', '#f472b6', '#38bdf8',
    ];

    /*  Draw JOIN edges column-level L-shaped connectors  */
    // Each edge connects at the SPECIFIC ROW of the join column
    // (not just the header centre) so 4 edges from the same table
    // spread across different rows instead of all stacking at y=header.
    // Path shape: right → vertical bend at gap midpoint → right.
    // Label (pill + ON) lives on the vertical segment, in the gap, never over a node.
    edges.forEach(({ from, to, join }, edgeIdx) => {
      const fp     = posArr[from];
      const tp     = posArr[to];
      const fromNd = nodeData[from];
      const toNd   = nodeData[to];
      if (!fp || !tp) return;

      const toKey   = (join.tableAlias || join.tableName || '').toLowerCase();
      const cCols   = join.condColumns || [];
      const fromRef = cCols.find(r => r.table.toLowerCase() !== toKey);
      const toRef   = cCols.find(r => r.table.toLowerCase() === toKey);

      // Pick y inside the node at the JOIN column row; fallback to header centre
      const y1Off = (fromRef && fromNd.rowOf[fromRef.column.toLowerCase()] != null)
        ? fromNd.rowOf[fromRef.column.toLowerCase()]
        : HDR_H / 2;
      const y2Off = (toRef && toNd.rowOf[toRef.column.toLowerCase()] != null)
        ? toNd.rowOf[toRef.column.toLowerCase()]
        : HDR_H / 2;

      const x1    = fp.x + NODE_W;
      const y1    = fp.y + y1Off;
      const x2    = tp.x;
      const y2    = tp.y + y2Off;
      const vertX = x1 + LEVEL_GAP / 2;   // vertical bend lives in the gap

      const color    = EDGE_PALETTE[edgeIdx % EDGE_PALETTE.length];
      const label    = normalizeJoinType(join.type);
      const isDashed = /LEFT|RIGHT|FULL/i.test(join.type || '');

      const isStraight = Math.abs(y1 - y2) < 2;
      const d = isStraight
        ? `M ${x1} ${y1} L ${x2} ${y2}`
        : `M ${x1} ${y1} L ${vertX} ${y1} L ${vertX} ${y2} L ${x2} ${y2}`;

      edgeGroup.appendChild(mk('path', {
        d, fill: 'none', stroke: color, 'stroke-width': '2',
        'stroke-dasharray': isDashed ? '7 4' : 'none', opacity: '0.85'
      }));

      // Dots at both ends
      edgeGroup.appendChild(mk('circle', { cx: x1, cy: y1, r: 4, fill: color }));
      edgeGroup.appendChild(mk('circle', { cx: x2, cy: y2, r: 4, fill: color }));

      // Label anchor: midpoint of vertical segment (or center of horizontal if straight)
      const lx = isStraight ? (x1 + x2) / 2 : vertX;
      const ly = isStraight ? y1 : (y1 + y2) / 2;

      // ON condition pill — rendered FIRST (behind the JOIN pill) so it sits below it
      if (join.condition) {
        const raw   = join.condition.replace(/\s+/g, ' ').trim();
        const short = raw.length > 32 ? raw.slice(0, 30) + '…' : raw;
        const onTxt = 'ON ' + short;
        const onW   = onTxt.length * 6.2 + 16;
        const onY   = ly + 18;  // below the JOIN pill

        // Dark background pill with colored border (improving readability)
        edgeGroup.appendChild(mk('rect', {
          x: lx - onW / 2, y: onY - 9, width: onW, height: 18, rx: 4,
          fill: isDark ? '#0d1117' : '#1e293b',
          stroke: color, 'stroke-width': '1.5', opacity: '0.96'
        }));
        edgeGroup.appendChild(mkt(lx, onY + 4, onTxt, {
          'text-anchor': 'middle', 'font-size': '10', 'font-weight': '500',
          'font-family': 'monospace', fill: '#fde68a'
        }));
      }

      // JOIN type pill — on top
      const lw = label.length * 6.5 + 20;
      edgeGroup.appendChild(mk('rect', {
        x: lx - lw / 2, y: ly - 11, width: lw, height: 22, rx: 11, fill: color
      }));
      edgeGroup.appendChild(mkt(lx, ly + 5, label, {
        'text-anchor': 'middle', 'font-size': '10', 'font-weight': '700',
        'font-family': 'sans-serif', fill: '#ffffff'
      }));
    });

    /* Draw ER nodes  */
    // Use posArr[idx] (index-based), NOT positions[name], because the same
    // table name can appear multiple times (e.g. employees e / employees m / employees dm).
    // The name-keyed map gets overwritten and puts every duplicate at the wrong spot.
    nodeData.forEach(({ tbl, selCols, joinKeys, innerTables, nodeH, idx }) => {
      const pos = posArr[idx];
      if (!pos) return;

      const color   = tbl.color || '#4f8ef7';
      const display = tbl.name.includes('.') ? tbl.name.split('.').pop() : tbl.name;
      const g = mk('g', {});

      /* Body background */
      g.appendChild(mk('rect', {
        x: pos.x, y: pos.y, width: NODE_W, height: nodeH, rx: 8,
        fill: C.bg, stroke: color, 'stroke-width': '1.5'
      }));

      /* Colored header */
      g.appendChild(mk('rect', {
        x: pos.x, y: pos.y, width: NODE_W, height: HDR_H, rx: 8, fill: color
      }));
      g.appendChild(mk('rect', {  // square off the bottom corners of header
        x: pos.x, y: pos.y + HDR_H - 8, width: NODE_W, height: 8, fill: color
      }));

      /* Table name */
      const shortName = display.length > 17 ? display.slice(0, 15) + '…' : display;
      g.appendChild(mkt(pos.x + 12, pos.y + 18, shortName, {
        'font-size': '13', 'font-weight': '700', 'font-family': 'monospace', fill: '#ffffff'
      }));

      /* Alias */
      if (tbl.alias) {
        g.appendChild(mkt(pos.x + 12, pos.y + HDR_H - 8, 'alias: ' + tbl.alias, {
          'font-size': '10', 'font-family': 'monospace', fill: 'rgba(255,255,255,0.72)'
        }));
      }

      /* CTE / Subquery badge */
      if (tbl.isCTE || tbl.isSubquery) {
        g.appendChild(mkt(pos.x + NODE_W - 10, pos.y + 18,
          tbl.isCTE ? 'CTE' : 'SUB', {
            'text-anchor': 'end', 'font-size': '9', 'font-weight': '700',
            'font-family': 'sans-serif', fill: tbl.isCTE ? '#c4b5fd' : '#fbbf24'
          }));
      }

      /* Divider line */
      g.appendChild(mk('line', {
        x1: pos.x + 1, y1: pos.y + HDR_H,
        x2: pos.x + NODE_W - 1, y2: pos.y + HDR_H,
        stroke: color, 'stroke-width': '1', opacity: '0.4'
      }));

      /* Selected columns */
      let rowY = pos.y + HDR_H + PAD;

      if (selCols.length === 0) {
        g.appendChild(mkt(pos.x + 14, rowY + 15, 'no columns referenced', {
          'font-size': '11', 'font-family': 'sans-serif',
          fill: C.textDim, 'font-style': 'italic'
        }));
        rowY += ROW_H;
      } else {
        selCols.forEach(col => {
          const rowCy = rowY + ROW_H / 2;

          // Alternating row bg
          g.appendChild(mk('rect', {
            x: pos.x + 1, y: rowY + 1,
            width: NODE_W - 2, height: ROW_H - 2,
            rx: 3, fill: C.bgRow, opacity: '0.5'
          }));

          // Dot
          g.appendChild(mk('circle', {
            cx: pos.x + 14, cy: rowCy, r: 3.5, fill: color, opacity: '0.85'
          }));

          // Column name
          const expr    = col.expression;
          const colName = expr.includes('.') ? expr.split('.').pop() : expr;
          g.appendChild(mkt(pos.x + 25, rowCy + 4, colName.length > 21 ? colName.slice(0, 19) + '…' : colName, {
            'font-size': '12', 'font-family': 'monospace', fill: C.text
          }));

          // Alias
          if (col.alias) {
            g.appendChild(mkt(pos.x + NODE_W - 8, rowCy + 4, '→ ' + col.alias, {
              'text-anchor': 'end', 'font-size': '10',
              'font-family': 'monospace', fill: C.textMuted
            }));
          }
          rowY += ROW_H;
        });
      }

      /* JOIN key columns */
      if (joinKeys.length > 0) {
        // Dashed separator
        g.appendChild(mk('line', {
          x1: pos.x + 8, y1: rowY + 2,
          x2: pos.x + NODE_W - 8, y2: rowY + 2,
          stroke: color, 'stroke-width': '1', 'stroke-dasharray': '4 3', opacity: '0.4'
        }));
        rowY += 8;

        joinKeys.forEach(col => {
          const rowCy = rowY + ROW_H / 2;
          g.appendChild(mkt(pos.x + 12, rowCy + 4, '⚿', {
            'font-size': '12', fill: '#f59e0b'
          }));
          g.appendChild(mkt(pos.x + 26, rowCy + 4,
            (col.length > 18 ? col.slice(0, 16) + '…' : col) + ' (key)', {
              'font-size': '11', 'font-family': 'monospace',
              fill: C.textMuted, 'font-style': 'italic'
            }));
          rowY += ROW_H;
        });
      }

      /* Inner tables (for subquery nodes) */
      if (innerTables.length > 0) {
        g.appendChild(mk('line', {
          x1: pos.x + 8, y1: rowY + 2,
          x2: pos.x + NODE_W - 8, y2: rowY + 2,
          stroke: color, 'stroke-width': '1', 'stroke-dasharray': '4 3', opacity: '0.4'
        }));
        rowY += 8;
        innerTables.forEach(tblName => {
          const rowCy = rowY + ROW_H / 2;
          g.appendChild(mkt(pos.x + 12, rowCy + 4, '⊂', {
            'font-size': '12', fill: '#22d3ee'
          }));
          g.appendChild(mkt(pos.x + 26, rowCy + 4,
            (tblName.length > 20 ? tblName.slice(0, 18) + '…' : tblName), {
              'font-size': '11', 'font-family': 'monospace',
              fill: C.textMuted, 'font-style': 'italic'
            }));
          rowY += ROW_H;
        });
      }

      nodeGroup.appendChild(g);
    });
  }

  /* Tables Tab  */
  function renderTables(result) {
    if (result.tables.length === 0) {
      tablesGrid.innerHTML = '<div class="no-content">No tables found</div>';
      return;
    }

    // Build alias→color map
    const aliasMap = buildAliasMap(result.tables);

    // Group columns by source table/alias
    const colsByTable = {};
    result.columns.forEach(col => {
      if (col.sourceTable) {
        const key = col.sourceTable.toLowerCase();
        if (!colsByTable[key]) colsByTable[key] = [];
        colsByTable[key].push(col);
      }
    });

    tablesGrid.innerHTML = result.tables.map(tbl => {
      const color = tbl.color || '#4f8ef7';
      const displayName = tbl.name;
      const key = (tbl.alias || tbl.name).toLowerCase();
      const cols = colsByTable[key] || colsByTable[tbl.name.toLowerCase()] || [];

      const tagHtml = [
        tbl.isCTE ? '<span class="table-card-tag tag-cte">CTE</span>' : '',
        tbl.isSubquery ? '<span class="table-card-tag tag-subquery">SUBQUERY</span>' : ''
      ].join('');

      const colsHtml = cols.length > 0
        ? cols.map(c => `
          <div class="col-chip">
            <span class="col-chip-dot" style="background:${color}"></span>
            <span>${esc(c.expression)}</span>
            ${c.alias ? `<span class="col-alias">${esc(c.alias)}</span>` : ''}
          </div>`).join('')
        : '<div style="color:var(--text-dim);font-size:12px;padding:2px 0">No columns explicitly referenced</div>';

      // For subquery nodes: show the inner tables it queries
      const innerTablesHtml = (tbl.isSubquery && tbl.innerResult && tbl.innerResult.tables.length)
        ? `<div style="margin-top:8px;padding-top:8px;border-top:1px dashed var(--border)">
            <div style="font-size:11px;color:var(--text-dim);margin-bottom:4px">Inner tables</div>
            ${tbl.innerResult.tables.filter(t => !t.isSubquery).map(t => `
              <div class="col-chip">
                <span style="font-size:11px;margin-right:4px;color:#22d3ee">⊂</span>
                <span>${esc(t.alias ? t.name + ' (' + t.alias + ')' : t.name)}</span>
                ${tbl.innerResult.joins.find(j => j.tableName === t.name)
                  ? `<span class="col-alias">${esc(tbl.innerResult.joins.find(j=>j.tableName===t.name).type || 'JOIN')}</span>` : ''}
              </div>`).join('')}
            ${tbl.innerResult.conditions.where
              ? `<div style="font-size:11px;color:var(--text-dim);margin-top:4px">WHERE ${esc(tbl.innerResult.conditions.where.slice(0,80))}${tbl.innerResult.conditions.where.length>80?'…':''}</div>`
              : ''}
           </div>`
        : '';

      return `
        <div class="table-card" style="border-top-color:${color}">
          <div class="table-card-header">
            <div class="table-badge" style="background:${color}">${displayName[0].toUpperCase()}</div>
            <div>
              <div class="table-card-name">${esc(displayName)}${tagHtml}</div>
              ${tbl.alias ? `<div class="table-card-alias">alias: ${esc(tbl.alias)}</div>` : ''}
            </div>
          </div>
          <div class="table-card-columns">${colsHtml}${innerTablesHtml}</div>
        </div>`;
    }).join('');
  }

  /* Columns Tab  */
  function renderColumns(result) {
    if (result.columns.length === 0) {
      columnsList.innerHTML = '<div class="no-content">No columns found</div>';
      return;
    }

    // Build a quick lookup: expression → window function info
    const wfMap = {};
    (result.windowFunctions || []).forEach(wf => { wfMap[wf.expression] = wf; });

    columnsList.innerHTML = result.columns.map((col, i) => {
      const isWildcard = col.expression.trim() === '*' || col.expression.endsWith('.*');
      const sourceColor = col.sourceColor;
      const sourceLabel = col.sourceTable || null;
      const hasCase = col.expression.toUpperCase().includes('CASE');
      const wf = wfMap[col.expression];

      // Window function detail tooltip-style row
      const wfDetail = wf ? `
        <div style="margin-top:3px;padding:4px 8px;background:var(--surface);border-radius:4px;font-size:11px;color:var(--text-dim)">
          ${wf.functionName ? `<strong style="color:#22d3ee">${esc(wf.functionName)}()</strong> ` : ''}OVER
          ${wf.partitionBy.length ? ` · PARTITION BY <span style="color:var(--text)">${wf.partitionBy.map(esc).join(', ')}</span>` : ''}
          ${wf.orderBy.length    ? ` · ORDER BY <span style="color:var(--text)">${wf.orderBy.map(esc).join(', ')}</span>` : ''}
          ${wf.frame             ? ` · <span style="color:var(--text)">${esc(wf.frame)}</span>` : ''}
        </div>` : '';

      return `
        <div class="col-row" style="${wf ? 'flex-wrap:wrap' : ''}">
          <span class="col-row-num">${i + 1}</span>
          <span class="col-row-expr ${isWildcard ? 'col-star' : ''}">${esc(col.expression)}</span>
          ${col.alias ? `<span class="col-row-alias">${esc(col.alias)}</span>` : ''}
          ${sourceLabel ? `<span class="source-badge" style="background:${sourceColor || '#4f8ef7'}">${esc(sourceLabel)}</span>` : ''}
          ${hasCase ? `<span class="stmt-chip" style="color:#f59e0b;border-color:#f59e0b;font-size:10px">CASE</span>` : ''}
          ${wf      ? `<span class="stmt-chip" style="color:#22d3ee;border-color:#22d3ee;font-size:10px">WINDOW</span>` : ''}
          ${wfDetail ? `<div style="width:100%;padding-left:32px">${wfDetail}</div>` : ''}
        </div>`;
    }).join('');
  }

  /*  Conditions Tab  */
  function renderConditions(result) {
    const { where, groupBy, having, orderBy, whereSubqueries = [], havingSubqueries = [] } = result.conditions;
    const blocks = [];

    // Helper to render a subquery detail block
    const subqueryDetail = (sq) => {
      const tables = sq.innerResult ? sq.innerResult.tables.filter(t => !t.isSubquery).map(t => t.alias ? `${t.name} (${t.alias})` : t.name) : [];
      return `<div style="margin-top:6px;padding:6px 10px;border-left:2px solid var(--primary);background:var(--surface);border-radius:4px;font-size:12px">
        <span class="stmt-chip" style="border-color:#4f8ef7;color:#4f8ef7;margin-bottom:4px">${esc(sq.context)} subquery</span>
        ${tables.length ? `<div style="color:var(--text-dim);margin-top:4px">Tables: ${tables.map(t => `<strong>${esc(t)}</strong>`).join(', ')}</div>` : ''}
        ${sq.innerResult && sq.innerResult.conditions.where ? `<div style="color:var(--text-dim);margin-top:2px">WHERE ${esc(sq.innerResult.conditions.where.slice(0,80))}${sq.innerResult.conditions.where.length>80?'…':''}</div>` : ''}
        <details style="margin-top:4px"><summary style="cursor:pointer;color:var(--text-dim);font-size:11px">Show SQL</summary><pre style="margin:4px 0 0;font-size:11px;white-space:pre-wrap;color:var(--text)">${esc(sq.sql)}</pre></details>
      </div>`;
    };

    if (where) {
      const subHtml = whereSubqueries.length
        ? `<div style="margin-top:6px;font-size:11px;color:var(--text-dim)">Subqueries (${whereSubqueries.length}):</div>${whereSubqueries.map(subqueryDetail).join('')}`
        : '';
      blocks.push({
        icon: '&#128269;',
        label: 'WHERE',
        color: 'var(--warning)',
        html: `<div class="condition-block-body">${esc(where)}${subHtml}</div>`
      });
    }

    if (groupBy.length > 0) {
      blocks.push({
        icon: '&#128202;',
        label: 'GROUP BY',
        color: 'var(--success)',
        html: `<div class="condition-block-body">${groupBy.map(g => esc(g)).join('\n')}</div>`
      });
    }

    if (having) {
      const subHtml = havingSubqueries.length
        ? `<div style="margin-top:6px;font-size:11px;color:var(--text-dim)">Subqueries (${havingSubqueries.length}):</div>${havingSubqueries.map(subqueryDetail).join('')}`
        : '';
      blocks.push({
        icon: '&#127775;',
        label: 'HAVING',
        color: 'var(--accent)',
        html: `<div class="condition-block-body">${esc(having)}${subHtml}</div>`
      });
    }

    if (orderBy.length > 0) {
      const rows = orderBy.map(o => `
        <div class="orderby-row">
          <span>${esc(o.expression)}</span>
          <span class="orderby-dir dir-${o.direction.toLowerCase()}">${o.direction}</span>
        </div>`).join('');
      blocks.push({ icon: '&#9650;', label: 'ORDER BY', color: 'var(--primary)', html: `<div class="condition-block-body">${rows}</div>` });
    }

    if (blocks.length === 0) {
      condView.innerHTML = '<div class="no-content">No WHERE, GROUP BY, HAVING, or ORDER BY clauses found</div>';
      return;
    }

    condView.innerHTML = blocks.map(b => `
      <div class="condition-block">
        <div class="condition-block-header" style="color:${b.color}">
          <span class="condition-block-icon">${b.icon}</span>
          <span>${b.label}</span>
        </div>
        ${b.html}
      </div>`).join('');
  }

  /* CTEs Tab  */
  function renderCTEs(result) {
    if (result.ctes.length === 0) {
      ctesView.innerHTML = '<div class="no-content">No CTEs (WITH clauses) found</div>';
      return;
    }
    ctesView.innerHTML = result.ctes.map(cte => `
      <div class="cte-card">
        <div class="cte-card-header">
          <span class="cte-label">CTE</span>
          <span>${esc(cte.name)}</span>
        </div>
        <div class="cte-card-body">${esc(cte.sql)}</div>
      </div>`).join('');
  }

  /* Helpers  */
  function showEmpty() { emptyState.classList.remove('hidden'); vizContent.classList.add('hidden'); }
  function showError(msg) { parseError.textContent = msg; parseError.classList.remove('hidden'); }
  function hideError() { parseError.classList.add('hidden'); }
  function esc(s) {
    return String(s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function buildAliasMap(tables) {
    const map = {};
    tables.forEach(t => {
      map[t.name.toLowerCase()] = t.color;
      if (t.alias) map[t.alias.toLowerCase()] = t.color;
    });
    return map;
  }


  function normalizeJoinType(type) {
    if (!type) return 'JOIN';
    const t = type.toUpperCase().replace(/\s+OUTER/, '');
    if (t.includes('LEFT'))  return 'LEFT JOIN';
    if (t.includes('RIGHT')) return 'RIGHT JOIN';
    if (t.includes('FULL'))  return 'FULL JOIN';
    if (t.includes('CROSS')) return 'CROSS JOIN';
    if (t.includes('INNER')) return 'INNER JOIN';
    return 'JOIN';
  }

  function stmtColor(type) {
    const map = {
      SELECT:   '#34d399', INSERT:   '#4f8ef7', UPDATE:  '#f59e0b',
      DELETE:   '#f87171', TRUNCATE: '#ef4444', ALTER:   '#a78bfa',
      CREATE:   '#22d3ee', DROP:     '#f87171', EXEC:    '#8892a4',
      DECLARE:  '#8892a4', CONTROL:  '#5a647a', SET:     '#64748b',
      IF:       '#22d3ee', WHILE:    '#86efac', BEGIN_BLOCK: '#64748b',
      TRY_BLOCK:'#34d399', RENAME:   '#fb923c', EXPLAIN: '#8892a4',
    };
    return map[type] || '#5a647a';
  }

  /* Statements Tab */
  function renderStatements(statements) {
    const el = $('#statementsView');
    if (!el) return;
    el.innerHTML = '';

    if (!statements || !statements.length) {
      el.innerHTML = '<p style="padding:20px;color:var(--text-dim)">No statements found.</p>';
      return;
    }

    statements.forEach((stmt, i) => {
      const card = document.createElement('div');
      card.className = 'stmt-card';

      const color = stmtColor(stmt.stmtType);
      const num   = i + 1;

      //Header
      let title = '';
      switch (stmt.stmtType) {
        case 'SELECT':
          title = stmt.setOp
            ? `Query #${num} — ${[...new Set(stmt.setOp.operators)].join('/')} (${stmt.setOp.branches.length} branches)`
            : `Query #${num} — SELECT`;
          break;
        case 'INSERT':   title = stmt.targetTable ? `INSERT INTO ${stmt.targetTable}` : 'INSERT'; break;
        case 'UPDATE':   title = stmt.targetTable ? `UPDATE ${stmt.targetTable}` : 'UPDATE'; break;
        case 'DELETE':   title = stmt.targetTable ? `DELETE FROM ${stmt.targetTable}` : 'DELETE'; break;
        case 'TRUNCATE': title = stmt.targetTable ? `TRUNCATE ${stmt.targetTable}` : 'TRUNCATE'; break;
        case 'ALTER':    title = stmt.targetTable ? `ALTER ${stmt.objectType} ${stmt.targetTable}${stmt.opType ? ' — ' + stmt.opType : ''}` : 'ALTER'; break;
        case 'CREATE':   title = stmt.objectName  ? `CREATE ${stmt.objectType} ${stmt.objectName}` : 'CREATE'; break;
        case 'DROP':     title = stmt.objectName  ? `DROP ${stmt.objectType} ${stmt.objectName}` : 'DROP'; break;
        case 'EXEC':     title = stmt.procedureName ? `EXEC ${stmt.procedureName}` : 'EXEC'; break;
        case 'DECLARE':  title = stmt.varName ? `DECLARE ${stmt.varName} ${stmt.varType || ''}` : 'DECLARE'; break;
        case 'CONTROL':  title = (stmt.raw || '').split(/\s+/).slice(0, 4).join(' '); break;
        case 'IF':    title = stmt.condition ? `IF ${stmt.condition.slice(0,50)}` : 'IF block'; break;
        case 'WHILE':       title = stmt.condition ? `WHILE ${stmt.condition.slice(0,50)}` : 'WHILE loop'; break;
        case 'BEGIN_BLOCK': title = `Transaction Block (${(stmt.bodyStmts || []).length} statement${(stmt.bodyStmts||[]).length!==1?'s':''})`; break;
        case 'RENAME':    title = stmt.oldName && stmt.newName ? `RENAME ${stmt.oldName} → ${stmt.newName}` : 'RENAME'; break;
        case 'EXPLAIN':   title = (stmt.raw || '').replace(/^EXPLAIN\s+/i, '').slice(0, 60); break;
        case 'SET':       title = stmt.option ? `SET ${stmt.option} ${stmt.value}` : stmt.varName ? `SET ${stmt.varName}` : 'SET'; break;
        case 'TRY_BLOCK': title = `TRY (${(stmt.tryStmts||[]).length} stmt) / CATCH (${(stmt.catchStmts||[]).length} stmt)`; break;
        default:          title = stmt.stmtType;
      }

      card.innerHTML = `
        <div class="stmt-card-header">
          <span class="stmt-badge" style="background:${color}">${stmt.stmtType}</span>
          <span class="stmt-card-title">${esc(title)}</span>
        </div>
        <div class="stmt-card-body" id="stmt-body-${i}"></div>
        <div class="stmt-raw" id="stmt-raw-${i}" title="Click to expand">${esc((stmt.raw || '').slice(0, 200))}${(stmt.raw || '').length > 200 ? '…' : ''}</div>
      `;
      el.appendChild(card);

      const body = card.querySelector(`#stmt-body-${i}`);

      const detail = (label, value) => {
        if (!value && value !== 0) return '';
        return `<div class="stmt-detail">
          <span class="stmt-detail-label">${label}</span>
          <span class="stmt-detail-value">${esc(String(value))}</span>
        </div>`;
      };

      const chips = (label, arr) => {
        if (!arr || !arr.length) return '';
        return `<div class="stmt-detail">
          <span class="stmt-detail-label">${label}</span>
          <div class="stmt-chip-list">${arr.map(v => `<span class="stmt-chip">${esc(String(v))}</span>`).join('')}</div>
        </div>`;
      };

      //  Body content per statement type 
      let bodyHTML = '';
      switch (stmt.stmtType) {
        case 'SELECT':
          bodyHTML += detail('Tables',  stmt.tables  ? stmt.tables.length  : 0);
          bodyHTML += detail('Joins',   stmt.joins   ? stmt.joins.length   : 0);
          bodyHTML += detail('Columns', stmt.columns ? stmt.columns.length : 0);
          if (stmt.tables && stmt.tables.length)
            bodyHTML += chips('Table names', stmt.tables.map(t => t.alias ? `${t.name} (${t.alias})` : t.name));
          if (stmt.setOp) {
            bodyHTML += `<div class="stmt-detail" style="width:100%">
              <span class="stmt-detail-label">${stmt.setOp.operators.join(' → ')} · ${stmt.setOp.branches.length} branches</span>
              <div class="stmt-chip-list">${stmt.setOp.branches.map((b, bi) => {
                const tbls = b.tables.map(t => esc(t.alias || t.name)).join(', ') || '(empty)';
                return `<span class="stmt-chip" style="border-color:#e879f9;color:#e879f9">Branch ${bi + 1}: ${tbls}</span>`;
              }).join('')}</div>
            </div>`;
          }
          break;
        case 'INSERT':
          bodyHTML += detail('Target table', stmt.targetTable);
          bodyHTML += detail('Source', stmt.sourceType);
          if (stmt.columns && stmt.columns.length)
            bodyHTML += chips('Columns', stmt.columns);
          if (stmt.selectResult && stmt.selectResult.tables && stmt.selectResult.tables.length)
            bodyHTML += chips('Source tables', stmt.selectResult.tables.map(t => t.alias ? `${t.name} (${t.alias})` : t.name));
          break;
        case 'UPDATE':
          bodyHTML += detail('Target table', stmt.targetTable + (stmt.alias ? ` (${stmt.alias})` : ''));
          if (stmt.setCols && stmt.setCols.length)
            bodyHTML += chips('Updating columns', stmt.setCols);
          if (stmt.whereClause)
            bodyHTML += detail('WHERE', stmt.whereClause.slice(0, 100));
          if (stmt.joins && stmt.joins.length)
            bodyHTML += chips('Joined tables', stmt.joins.map(j => j.tableName));
          break;
        case 'DELETE':
          bodyHTML += detail('Target table', stmt.targetTable);
          if (stmt.whereClause)
            bodyHTML += detail('WHERE', stmt.whereClause.slice(0, 100));
          break;
        case 'TRUNCATE':
          bodyHTML += detail('Target table', stmt.targetTable);
          break;
        case 'ALTER':
          bodyHTML += detail('Object type', stmt.objectType);
          bodyHTML += detail('Table', stmt.targetTable);
          if (stmt.opType) bodyHTML += detail('Operation', stmt.opType);
          if (stmt.operation) bodyHTML += detail('Detail', stmt.operation.slice(0, 100));
          break;
        case 'CREATE': {
          bodyHTML += detail('Object type', stmt.objectType);
          bodyHTML += detail('Name', stmt.objectName);
          if (stmt.objectType === 'TABLE' && stmt.columns && stmt.columns.length) {
            const constraintColor = t => ({ 'PRIMARY KEY':'#f59e0b','FOREIGN KEY':'#4f8ef7','UNIQUE':'#a78bfa','CHECK':'#22d3ee' }[t] || '#8892a4');
            bodyHTML += `<div class="stmt-detail" style="width:100%">
              <span class="stmt-detail-label">Columns (${stmt.columns.length})</span>
              <div>${stmt.columns.map(c => `
                <div style="display:flex;align-items:center;gap:6px;padding:3px 0;font-size:12px">
                  <span style="font-family:monospace">${esc(c.name)}</span>
                  <span style="color:var(--text-dim);font-size:11px">${esc(c.type)}</span>
                  ${c.primaryKey ? `<span class="stmt-chip" style="color:#f59e0b;border-color:#f59e0b;padding:1px 5px;font-size:10px">PK</span>` : ''}
                  ${c.notNull    ? `<span class="stmt-chip" style="color:#8892a4;border-color:#8892a4;padding:1px 5px;font-size:10px">NOT NULL</span>` : ''}
                  ${c.unique     ? `<span class="stmt-chip" style="color:#a78bfa;border-color:#a78bfa;padding:1px 5px;font-size:10px">UNIQUE</span>` : ''}
                  ${c.autoIncrement ? `<span class="stmt-chip" style="color:#34d399;border-color:#34d399;padding:1px 5px;font-size:10px">AUTO</span>` : ''}
                  ${c.default != null ? `<span class="stmt-chip" style="color:#8892a4;border-color:#8892a4;padding:1px 5px;font-size:10px">DEFAULT ${esc(c.default)}</span>` : ''}
                </div>`).join('')}
              </div>
            </div>`;
            if (stmt.constraints && stmt.constraints.length) {
              bodyHTML += `<div class="stmt-detail" style="width:100%">
                <span class="stmt-detail-label">Constraints (${stmt.constraints.length})</span>
                <div class="stmt-chip-list">${stmt.constraints.map(con => {
                  const cc = constraintColor(con.type);
                  let lbl = con.type;
                  if (con.name) lbl += ' ' + con.name;
                  if (con.columns && con.columns.length) lbl += ': ' + con.columns.join(', ');
                  if (con.refTable) lbl += ' → ' + con.refTable + (con.refColumns && con.refColumns.length ? '(' + con.refColumns.join(',') + ')' : '');
                  if (con.expression) lbl += ': ' + con.expression.slice(0, 40);
                  return `<span class="stmt-chip" style="border-color:${cc};color:${cc}">${esc(lbl.slice(0, 70))}</span>`;
                }).join('')}</div>
              </div>`;
            }
          }
          if (stmt.objectType === 'INDEX') {
            if (stmt.onTable) bodyHTML += detail('On table', stmt.onTable);
            if (stmt.indexedColumns && stmt.indexedColumns.length) bodyHTML += chips('Indexed columns', stmt.indexedColumns);
            if (stmt.isUnique) bodyHTML += detail('Unique', 'Yes');
          }
          if ((stmt.objectType === 'PROCEDURE' || stmt.objectType === 'FUNCTION') && stmt.bodyStmts && stmt.bodyStmts.length) {
            bodyHTML += `<div class="stmt-detail" style="width:100%">
              <span class="stmt-detail-label">Body (${stmt.bodyStmts.length} top-level statement${stmt.bodyStmts.length>1?'s':''})</span>
              <div class="stmt-chip-list">${stmt.bodyStmts.map(s =>
                `<span class="stmt-chip" style="border-color:${stmtColor(s.stmtType)};color:${stmtColor(s.stmtType)}">${esc(s.stmtType)}${s.targetTable?' → '+esc(s.targetTable):''}</span>`
              ).join('')}</div>
            </div>`;
          }
          break;
        }
        case 'RENAME':
          if (stmt.pairs && stmt.pairs.length > 1) {
            bodyHTML += chips('Renames', stmt.pairs.map(p => `${p.oldName} → ${p.newName}`));
          } else {
            bodyHTML += detail('Old name', stmt.oldName);
            bodyHTML += detail('New name', stmt.newName);
          }
          break;
        case 'EXPLAIN':
          bodyHTML += `<span style="color:var(--text-dim);font-size:12px">Query plan for: ${esc((stmt.raw || '').replace(/^EXPLAIN\s+/i, '').slice(0, 120))}</span>`;
          break;
        case 'DROP':
          bodyHTML += detail('Object type', stmt.objectType);
          bodyHTML += detail('Name', stmt.objectName);
          break;
        case 'EXEC':
          bodyHTML += detail('Procedure', stmt.procedureName);
          break;
        case 'DECLARE':
          bodyHTML += detail('Variable', stmt.varName);
          bodyHTML += detail('Type', stmt.varType);
          break;
        case 'IF': {
          const condTxt = stmt.condition ? stmt.condition.slice(0, 80) : '(condition)';
          bodyHTML += detail('Condition', condTxt);
          if (stmt.thenStmts && stmt.thenStmts.length) {
            bodyHTML += `<div class="stmt-detail" style="width:100%">
              <span class="stmt-detail-label">THEN block (${stmt.thenStmts.length} statement${stmt.thenStmts.length>1?'s':''})</span>
              <div class="stmt-chip-list">${stmt.thenStmts.map(s =>
                `<span class="stmt-chip" style="border-color:${stmtColor(s.stmtType)};color:${stmtColor(s.stmtType)}">${esc(s.stmtType)}${s.targetTable?' → '+esc(s.targetTable):s.objectName?' '+esc(s.objectName):''}</span>`
              ).join('')}</div>
            </div>`;
          }
          if (stmt.elseStmts && stmt.elseStmts.length) {
            bodyHTML += `<div class="stmt-detail" style="width:100%">
              <span class="stmt-detail-label">ELSE block (${stmt.elseStmts.length} statement${stmt.elseStmts.length>1?'s':''})</span>
              <div class="stmt-chip-list">${stmt.elseStmts.map(s =>
                `<span class="stmt-chip" style="border-color:${stmtColor(s.stmtType)};color:${stmtColor(s.stmtType)}">${esc(s.stmtType)}${s.targetTable?' → '+esc(s.targetTable):s.objectName?' '+esc(s.objectName):''}</span>`
              ).join('')}</div>
            </div>`;
          }
          break;
        }
        case 'WHILE': {
          const condTxt = stmt.condition ? stmt.condition.slice(0, 80) : '(condition)';
          bodyHTML += detail('Loop condition', condTxt);
          if (stmt.bodyStmts && stmt.bodyStmts.length) {
            bodyHTML += `<div class="stmt-detail" style="width:100%">
              <span class="stmt-detail-label">Loop body (${stmt.bodyStmts.length} statement${stmt.bodyStmts.length>1?'s':''})</span>
              <div class="stmt-chip-list">${stmt.bodyStmts.map(s =>
                `<span class="stmt-chip" style="border-color:${stmtColor(s.stmtType)};color:${stmtColor(s.stmtType)}">${esc(s.stmtType)}${s.targetTable?' → '+esc(s.targetTable):''}</span>`
              ).join('')}</div>
            </div>`;
          }
          break;
        }
        case 'BEGIN_BLOCK': {
          if (stmt.bodyStmts && stmt.bodyStmts.length) {
            bodyHTML += `<div class="stmt-detail" style="width:100%">
              <span class="stmt-detail-label">Contains (${stmt.bodyStmts.length} statement${stmt.bodyStmts.length>1?'s':''})</span>
              <div class="stmt-chip-list">${stmt.bodyStmts.map(s =>
                `<span class="stmt-chip" style="border-color:${stmtColor(s.stmtType)};color:${stmtColor(s.stmtType)}">${esc(s.stmtType)}${s.targetTable?' → '+esc(s.targetTable):s.objectName?' '+esc(s.objectName):''}</span>`
              ).join('')}</div>
            </div>`;
          }
          break;
        }
        case 'TRY_BLOCK': {
          const renderBlock = (label, stmts) => {
            if (!stmts || !stmts.length) return '';
            return `<div class="stmt-detail" style="width:100%">
              <span class="stmt-detail-label">${label} (${stmts.length} statement${stmts.length>1?'s':''})</span>
              <div class="stmt-chip-list">${stmts.map(s =>
                `<span class="stmt-chip" style="border-color:${stmtColor(s.stmtType)};color:${stmtColor(s.stmtType)}">${esc(s.stmtType)}${s.targetTable?' → '+esc(s.targetTable):s.objectName?' '+esc(s.objectName):''}</span>`
              ).join('')}</div>
            </div>`;
          };
          bodyHTML += renderBlock('TRY block', stmt.tryStmts);
          bodyHTML += renderBlock('CATCH block', stmt.catchStmts);
          break;
        }
        case 'SET':
          if (stmt.option) bodyHTML += detail('Option', `${stmt.option} = ${stmt.value}`);
          if (stmt.varName) { bodyHTML += detail('Variable', stmt.varName); bodyHTML += detail('Value', stmt.value); }
          break;
      }
      if (!bodyHTML) bodyHTML = `<span style="color:var(--text-dim);font-size:12px">${esc(stmt.stmtType)} statement</span>`;
      body.innerHTML = bodyHTML;

      // Expand/collapse raw SQL on click
      const rawEl = card.querySelector(`#stmt-raw-${i}`);
      rawEl.addEventListener('click', () => {
        const expanded = rawEl.classList.toggle('expanded');
        rawEl.textContent = expanded
          ? (stmt.raw || '')
          : ((stmt.raw || '').slice(0, 200) + ((stmt.raw || '').length > 200 ? '…' : ''));
        rawEl.title = expanded ? 'Click to collapse' : 'Click to expand';
      });
    });
  }


  /* Sample SQL */
  const SAMPLE_SQL = `-- Customer order analysis with product and supplier info
WITH CustomerStats AS (
    SELECT
        c.customer_id,
        c.first_name,
        c.last_name,
        c.email,
        COUNT(o.order_id)       AS total_orders,
        SUM(o.total_amount)     AS lifetime_value,
        MAX(o.order_date)       AS last_order_date
    FROM customers c
    INNER JOIN orders o ON c.customer_id = o.customer_id
    WHERE o.status NOT IN ('cancelled', 'returned')
    GROUP BY c.customer_id, c.first_name, c.last_name, c.email
    HAVING SUM(o.total_amount) > 500
),
TopProducts AS (
    SELECT
        p.product_id,
        p.product_name,
        p.category,
        SUM(oi.quantity) AS units_sold
    FROM products p
    INNER JOIN order_items oi ON p.product_id = oi.product_id
    GROUP BY p.product_id, p.product_name, p.category
)
SELECT
    cs.customer_id,
    cs.first_name + ' ' + cs.last_name  AS full_name,
    cs.email,
    cs.total_orders,
    cs.lifetime_value,
    cs.last_order_date,
    o.order_id,
    o.order_date,
    o.shipping_address,
    o.status                             AS order_status,
    tp.product_name,
    tp.category                          AS product_category,
    tp.units_sold,
    oi.quantity,
    oi.unit_price,
    oi.quantity * oi.unit_price          AS line_total,
    s.supplier_name,
    s.country                            AS supplier_country,
    r.region_name
FROM CustomerStats cs
INNER JOIN orders o          ON cs.customer_id  = o.customer_id
LEFT  JOIN order_items oi    ON o.order_id      = oi.order_id
LEFT  JOIN TopProducts tp    ON oi.product_id   = tp.product_id
LEFT  JOIN suppliers s       ON tp.product_id   = s.supplier_id
LEFT  JOIN regions r         ON s.region_id     = r.region_id
WHERE cs.lifetime_value > 1000
  AND o.order_date >= '2024-01-01'
  AND o.status     = 'completed'
ORDER BY cs.lifetime_value DESC, o.order_date DESC`;

  /*  Full Screen toggle */
  const fsBtn  = $('#fsBtn');
  const diagramWrap = $('#diagramWrap');

  function exitFs() {
    diagramWrap.classList.remove('is-fullscreen');
    fsBtn.innerHTML = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M8 3H5a2 2 0 0 0-2 2v3m18 0V5a2 2 0 0 0-2-2h-3m0 18h3a2 2 0 0 0 2-2v-3M3 16v3a2 2 0 0 0 2 2h3"/></svg> Full Screen`;
    fsBtn.title = 'Enter full screen';
    document.removeEventListener('keydown', onEsc);
  }
  function onEsc(e) { if (e.key === 'Escape') exitFs(); }

  fsBtn.addEventListener('click', () => {
    const isFs = diagramWrap.classList.toggle('is-fullscreen');
    if (isFs) {
      fsBtn.innerHTML = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M8 3H5a2 2 0 0 0-2 2v3M21 8V5a2 2 0 0 0-2-2h-3M8 21H5a2 2 0 0 0-2-2v-3m16 0v3a2 2 0 0 0-2 2h-3"/></svg> Exit`;
      fsBtn.title = 'Exit full screen (Esc)';
      document.addEventListener('keydown', onEsc);
    } else {
      exitFs();
    }
  });

})();
