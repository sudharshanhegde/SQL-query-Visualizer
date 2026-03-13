class SQLParser {
  constructor() {
    this.TABLE_COLORS = [
      '#4f8ef7','#34d399','#f59e0b','#a78bfa',
      '#f87171','#22d3ee','#fb923c','#e879f9',
      '#86efac','#fde68a','#6ee7b7','#c4b5fd'
    ];
    this._colorMap = {};
    this._colorIdx = 0;
  }

  reset() {
    this._colorMap = {};
    this._colorIdx = 0;
  }

  getColor(name) {
    const key = (name || '').toLowerCase();
    if (!this._colorMap[key]) {
      this._colorMap[key] = this.TABLE_COLORS[this._colorIdx % this.TABLE_COLORS.length];
      this._colorIdx++;
    }
    return this._colorMap[key];
  }

  /*  Public entry point  */
  parse(sql) {
    this.reset();
    if (!sql || !sql.trim()) throw new Error('Empty SQL input');

    const cleaned = this._clean(sql);
    const { ctes, mainSql } = this._extractCTEs(cleaned);
    const cteNames = new Set(ctes.map(c => c.name.toLowerCase()));

    // Detect UNION / INTERSECT / EXCEPT at depth 0 — split into branches
    const { parts, operators } = this._splitSetOps(mainSql);
    if (operators.length > 0) {
      return this._parseSetOperation(parts, operators, ctes, cteNames, sql);
    }

    const result = {
      ctes,
      tables: [],
      joins: [],
      columns: [],
      conditions: { where: null, groupBy: [], having: null, orderBy: [] },
      raw: sql
    };

    const fromResult = this._extractFromAndJoins(mainSql);
    result.tables = fromResult.tables;
    result.joins  = fromResult.joins;

    // Mark known CTEs
    result.tables.forEach(t => {
      if (cteNames.has(t.name.toLowerCase())) t.isCTE = true;
    });

    result.columns         = this._extractColumns(mainSql);
    result.conditions      = this._extractConditions(mainSql);
    result.windowFunctions = this._extractWindowFunctions(result.columns);

    // Assign colors (tables get colors first, aliases map to same color)
    const aliasMap = {};
    result.tables.forEach(t => {
      const col = this.getColor(t.name);
      t.color = col;
      if (t.alias) aliasMap[t.alias.toLowerCase()] = col;
      aliasMap[t.name.toLowerCase()] = col;
    });

    // Resolve column source colors
    result.columns.forEach(col => {
      if (col.sourceTable) {
        const key = col.sourceTable.toLowerCase();
        col.sourceColor = aliasMap[key] || null;
      }
    });

    return result;
  }

  /* Split on UNION / INTERSECT / EXCEPT at depth 0  */
  _splitSetOps(sql) {
    const parts = [], operators = [];
    let cur = '', depth = 0, inStr = false, strCh = '';
    const upper = sql.toUpperCase();
    let i = 0;
    while (i < sql.length) {
      const ch = sql[i];
      if (inStr) { cur += ch; if (ch === strCh) inStr = false; i++; continue; }
      if (ch === "'" || ch === '"') { inStr = true; strCh = ch; cur += ch; i++; continue; }
      if (ch === '(') { depth++; cur += ch; i++; continue; }
      if (ch === ')') { depth--; cur += ch; i++; continue; }
      if (depth === 0 && (i === 0 || !/\w/.test(upper[i - 1]))) {
        const rest = upper.slice(i);
        let op = null, skip = 0;
        if (/^UNION\s+ALL\b/.test(rest)) { const m = rest.match(/^UNION\s+ALL\b/); op = 'UNION ALL'; skip = m[0].length; }
        else if (/^UNION\b/.test(rest))      { op = 'UNION';     skip = 5; }
        else if (/^INTERSECT\b/.test(rest))  { op = 'INTERSECT'; skip = 9; }
        else if (/^EXCEPT\b/.test(rest))     { op = 'EXCEPT';    skip = 6; }
        if (op) { parts.push(cur.trim()); cur = ''; operators.push(op); i += skip; continue; }
      }
      cur += ch; i++;
    }
    if (cur.trim()) parts.push(cur.trim());
    return { parts, operators };
  }

  /*  Parse each UNION / INTERSECT / EXCEPT branch  */
  _parseSetOperation(parts, operators, ctes, cteNames, rawSql) {
    const branches = parts.map(p => {
      const fromResult = this._extractFromAndJoins(p);
      const columns    = this._extractColumns(p);
      const conditions = this._extractConditions(p);
      fromResult.tables.forEach(t => { if (cteNames.has(t.name.toLowerCase())) t.isCTE = true; });
      return { tables: fromResult.tables, joins: fromResult.joins, columns, conditions };
    });

    // Merge tables across branches, de-duping by name+alias
    // Tables that appear in multiple branches keep their first occurrence,
    // with a branchIndex so the diagram can label them if needed.
    const seen = new Set();
    const allTables = [], allJoins = [];
    branches.forEach((branch, bi) => {
      branch.tables.forEach(t => {
        const key = (t.name + '|' + (t.alias || '')).toLowerCase();
        if (!seen.has(key)) { seen.add(key); allTables.push({ ...t, branchIndex: bi }); }
      });
      allJoins.push(...branch.joins);
    });

    // Assign colors
    const aliasMap = {};
    allTables.forEach(t => {
      t.color = this.getColor(t.name);
      if (t.alias) aliasMap[t.alias.toLowerCase()] = t.color;
      aliasMap[t.name.toLowerCase()] = t.color;
    });

    // Use first branch's columns as the diagram's output columns
    const columns = branches[0] ? branches[0].columns : [];
    columns.forEach(col => {
      if (col.sourceTable) col.sourceColor = aliasMap[col.sourceTable.toLowerCase()] || null;
    });

    return {
      ctes,
      tables: allTables,
      joins:  allJoins,
      columns,
      conditions:      branches[0] ? branches[0].conditions : { where: null, groupBy: [], having: null, orderBy: [] },
      windowFunctions: this._extractWindowFunctions(columns),
      setOp: { operators, branches },
      raw:   rawSql
    };
  }

  /*  Clean SQL (remove comments, normalize whitespace) */
  _clean(sql) {
    // Remove block comments
    sql = sql.replace(/\/\*[\s\S]*?\*\//g, ' ');
    // Remove line comments
    sql = sql.replace(/--[^\n]*/g, ' ');
    // Normalize whitespace (but keep newlines for readability in conditions)
    sql = sql.replace(/\t/g, ' ').replace(/ {2,}/g, ' ');
    return sql.trim();
  }

  /*  CTE extraction  */
  _extractCTEs(sql) {
    const ctes = [];
    if (!/^\s*WITH\b/i.test(sql)) return { ctes, mainSql: sql };

    let pos = sql.search(/\bWITH\b/i) + 4;

    while (pos < sql.length) {
      // Skip whitespace
      while (pos < sql.length && /\s/.test(sql[pos])) pos++;

      // CTE name
      const nameMatch = sql.slice(pos).match(/^([\w]+)\s*(?:AS\s*)?\(/i);
      if (!nameMatch) break;

      const cteName = nameMatch[1];
      const parenStart = pos + nameMatch[0].length - 1;
      const parenEnd = this._matchParen(sql, parenStart);
      if (parenEnd === -1) break;

      ctes.push({ name: cteName, sql: sql.slice(parenStart + 1, parenEnd).trim() });
      pos = parenEnd + 1;

      // Skip comma
      while (pos < sql.length && /[\s,]/.test(sql[pos])) pos++;

      // If next token is SELECT, we're at the main query
      if (/^SELECT\b/i.test(sql.slice(pos))) break;
    }

    return { ctes, mainSql: sql.slice(pos) };
  }

  /*  Find FROM clause start */
  _findKeywordAtDepth0(sql, keyword) {
    let depth = 0;
    let inStr = false;
    let strCh = '';
    const upper = sql.toUpperCase();
    const re = new RegExp(`^${keyword}\\b`);

    for (let i = 0; i < sql.length; i++) {
      const ch = sql[i];
      if (inStr) { if (ch === strCh) inStr = false; continue; }
      if (ch === "'" || ch === '"') { inStr = true; strCh = ch; continue; }
      if (ch === '(') { depth++; continue; }
      if (ch === ')') { depth--; continue; }
      if (depth === 0 && re.test(upper.slice(i))) return i;
    }
    return -1;
  }

  /* Extract SELECT columns */
  _extractColumns(sql) {
    const selectStart = this._findKeywordAtDepth0(sql, 'SELECT');
    const fromStart   = this._findKeywordAtDepth0(sql, 'FROM');

    if (selectStart === -1 || fromStart === -1) return [];

    let colStr = sql.slice(selectStart + 6, fromStart).trim();
    // Remove DISTINCT / TOP n
    colStr = colStr.replace(/^DISTINCT\s+/i, '').replace(/^TOP\s+\d+\s*/i, '');

    return this._splitDepth0(colStr).map((raw, i) => {
      raw = raw.trim();
      if (!raw) return null;

      // Parse alias
      let alias = null;
      let expr  = raw;
      const asMatch = raw.match(/\bAS\s+([\["`]?[\w\s]+[\]"`]?)\s*$/i);
      if (asMatch) {
        alias = asMatch[1].replace(/[[\]"`]/g, '').trim();
        expr  = raw.slice(0, raw.length - asMatch[0].length).trim();
      } else {
        // Implicit alias: last word after space if expr contains . or ()
        const parts = raw.split(/\s+/);
        if (parts.length >= 2) {
          const last = parts[parts.length - 1];
          const rest = parts.slice(0, -1).join(' ');
          const noKw = !['ASC','DESC','NULL','TRUE','FALSE','TOP'].includes(last.toUpperCase());
          if (noKw && !last.includes('(') && (rest.includes('.') || rest.includes('(') || rest.includes('*'))) {
            alias = last;
            expr  = rest;
          }
        }
      }

      // Determine source table from table.column pattern
      let sourceTable = null;
      const tableColMatch = expr.match(/^([\w]+)\.([\w]+|\*)$/);
      if (tableColMatch) sourceTable = tableColMatch[1];

      return { expression: expr, alias, sourceTable, sourceColor: null, index: i + 1, raw };
    }).filter(Boolean);
  }

  /* Extract FROM + JOINs */
  _extractFromAndJoins(sql) {
    const fromStart = this._findKeywordAtDepth0(sql, 'FROM');
    if (fromStart === -1) return { tables: [], joins: [] };

    // Find end of FROM block
    const afterFrom = sql.slice(fromStart + 4);
    const terminators = [
      /\bWHERE\b/i, /\bGROUP\s+BY\b/i, /\bORDER\s+BY\b/i,
      /\bHAVING\b/i, /\bUNION\b/i, /\bINTERSECT\b/i, /\bEXCEPT\b/i
    ];

    let endIdx = afterFrom.length;
    for (const re of terminators) {
      const idx = this._findPatternAtDepth0(afterFrom, re);
      if (idx !== -1 && idx < endIdx) endIdx = idx;
    }

    const fromClause = afterFrom.slice(0, endIdx).trim();
    return this._parseFromClause(fromClause);
  }

  _findPatternAtDepth0(str, re) {
    // Anchor the regex so it only matches at position i, not anywhere in the remainder
    const anchored = new RegExp(
      '^(?:' + re.source + ')',
      re.flags.replace('g', '')
    );
    let depth = 0, inStr = false, strCh = '';
    const upper = str.toUpperCase();
    for (let i = 0; i < str.length; i++) {
      const ch = str[i];
      if (inStr) { if (ch === strCh) inStr = false; continue; }
      if (ch === "'" || ch === '"') { inStr = true; strCh = ch; continue; }
      if (ch === '(') { depth++; continue; }
      if (ch === ')') { depth--; continue; }
      if (depth === 0 && anchored.test(upper.slice(i))) return i;
    }
    return -1;
  }

  _parseFromClause(fromClause) {
    const tables = [];
    const joins  = [];

    // Tokenize: split on JOIN keywords at depth 0
    const joinRe = /\b((?:INNER|LEFT|RIGHT|FULL|CROSS)(?:\s+OUTER)?\s+JOIN|JOIN)\b/gi;
    const segments = [];
    let last = 0;
    let m;
    while ((m = joinRe.exec(fromClause)) !== null) {
      // Only capture at depth 0
      const pre = fromClause.slice(0, m.index);
      const depth = (pre.match(/\(/g)||[]).length - (pre.match(/\)/g)||[]).length;
      if (depth !== 0) continue;
      segments.push({ type: null, body: fromClause.slice(last, m.index) });
      segments.push({ type: m[1].replace(/\s+/g, ' ').toUpperCase(), body: null });
      last = m.index + m[0].length;
    }
    segments.push({ type: null, body: fromClause.slice(last) });

    // First non-type segment = main table list
    let expectJoinBody = false;
    let joinType = null;

    for (const seg of segments) {
      if (seg.type) {
        joinType = seg.type;
        expectJoinBody = true;
        continue;
      }

      if (!expectJoinBody) {
        // Main FROM table(s)
        const mainTables = this._splitDepth0(seg.body).map(t => this._parseTableExpr(t.trim())).filter(Boolean);
        tables.push(...mainTables);
      } else {
        // JOIN body: could contain "table [alias] ON condition"
        const body = (seg.body || '').trim();
        const onIdx = this._findPatternAtDepth0(body, /\bON\b/i);
        let tableExpr, condition;

        if (onIdx !== -1) {
          tableExpr = body.slice(0, onIdx).trim();
          condition = body.slice(onIdx + 2).trim();
        } else {
          tableExpr = body;
          condition = null;
        }

        const tbl = this._parseTableExpr(tableExpr);
        if (tbl) {
          tables.push(tbl);
          joins.push({
            type: joinType,
            tableName: tbl.name,
            tableAlias: tbl.alias,
            condition,
            condColumns: condition ? this._parseConditionRefs(condition) : []
          });
        }
        expectJoinBody = false;
        joinType = null;
      }
    }

    return { tables, joins };
  }

  _parseTableExpr(expr) {
    if (!expr) return null;

    // Subquery: starts with (
    if (expr.trimStart().startsWith('(')) {
      const parenStart = expr.indexOf('(');
      const parenEnd = this._matchParen(expr, parenStart);
      const rest = parenEnd !== -1 ? expr.slice(parenEnd + 1).trim() : '';
      const aliasMatch = rest.match(/^(?:AS\s+)?([\w]+)/i);
      const innerSql = parenEnd !== -1 ? expr.slice(parenStart + 1, parenEnd).trim() : expr;
      let innerResult = null;
      try { innerResult = this.parse(innerSql); } catch(e) {}
      return {
        name: 'Subquery',
        alias: aliasMatch ? aliasMatch[1] : null,
        isSubquery: true,
        isCTE: false,
        sql: innerSql,
        innerResult
      };
    }

    // schema.table or table, with optional alias
    const m = expr.match(/^([\w.\[\]]+?)(?:\s+(?:AS\s+)?([\w]+))?\s*(?:WITH\s*\([^)]*\))?\s*$/i);
    if (m) {
      return {
        name: m[1].replace(/[\[\]]/g, ''),
        alias: m[2] || null,
        isSubquery: false,
        isCTE: false
      };
    }

    return null;
  }

  _parseConditionRefs(cond) {
    const refs = [];
    const matches = cond.matchAll(/([\w]+)\.([\w]+)/g);
    for (const m of matches) refs.push({ table: m[1], column: m[2] });
    return refs;
  }

  /*  Extract WHERE / GROUP BY / HAVING / ORDER BY */
  _extractConditions(sql) {
    const cond = { where: null, groupBy: [], having: null, orderBy: [] };

    const find = (kw) => this._findPatternAtDepth0(sql, new RegExp(`\\b${kw}\\b`, 'i'));

    const whereIdx   = find('WHERE');
    const groupByIdx = this._findPatternAtDepth0(sql, /\bGROUP\s+BY\b/i);
    const havingIdx  = find('HAVING');
    const orderByIdx = this._findPatternAtDepth0(sql, /\bORDER\s+BY\b/i);
    const limitIdx   = this._findPatternAtDepth0(sql, /\bLIMIT\b|\bFETCH\b/i);

    const markers = [whereIdx, groupByIdx, havingIdx, orderByIdx, limitIdx, sql.length]
      .filter(x => x >= 0)
      .sort((a, b) => a - b);

    const nextAfter = (idx) => markers.find(m => m > idx) ?? sql.length;

    if (whereIdx !== -1) {
      cond.where = sql.slice(whereIdx + 5, nextAfter(whereIdx)).trim();
    }

    if (groupByIdx !== -1) {
      const kw = sql.slice(groupByIdx).match(/^GROUP\s+BY\s+/i);
      const skip = kw ? kw[0].length : 8;
      const raw = sql.slice(groupByIdx + skip, nextAfter(groupByIdx)).trim();
      cond.groupBy = this._splitDepth0(raw).map(s => s.trim()).filter(Boolean);
    }

    if (havingIdx !== -1) {
      cond.having = sql.slice(havingIdx + 6, nextAfter(havingIdx)).trim();
    }

    if (orderByIdx !== -1) {
      const kw = sql.slice(orderByIdx).match(/^ORDER\s+BY\s+/i);
      const skip = kw ? kw[0].length : 8;
      const raw = sql.slice(orderByIdx + skip, nextAfter(orderByIdx)).trim();
      cond.orderBy = this._splitDepth0(raw)
        .map(item => {
          item = item.trim();
          if (!item) return null;
          const dirM = item.match(/\s+(ASC|DESC)\s*$/i);
          return {
            expression: dirM ? item.slice(0, item.length - dirM[0].length).trim() : item,
            direction: dirM ? dirM[1].toUpperCase() : 'ASC'
          };
        }).filter(Boolean);
    }

    // Detect subqueries inside WHERE / HAVING
    cond.whereSubqueries = this._findWhereSubqueries(cond.where);
    cond.havingSubqueries = this._findWhereSubqueries(cond.having);

    return cond;
  }

  /* Scan a condition string for (SELECT …) subqueries and parse each one */
  _findWhereSubqueries(str) {
    if (!str) return [];
    const results = [];
    const upper = str.toUpperCase();
    let i = 0;
    while (i < str.length) {
      // Find the next opening paren that is followed by SELECT
      const pIdx = upper.indexOf('(', i);
      if (pIdx === -1) break;
      if (!/^\(SELECT\b/.test(upper.slice(pIdx))) { i = pIdx + 1; continue; }

      const parenEnd = this._matchParen(str, pIdx);
      if (parenEnd === -1) { i = pIdx + 1; continue; }

      const innerSql = str.slice(pIdx + 1, parenEnd).trim();
      // What keyword precedes the subquery?
      const before = str.slice(0, pIdx).trimEnd();
      const ctxMatch = before.match(/(NOT\s+IN|NOT\s+EXISTS|IN|EXISTS|=|<>|!=|>=?|<=?|ANY|ALL|SOME)\s*$/i);
      const context = ctxMatch ? ctxMatch[1].replace(/\s+/g, ' ').toUpperCase() : 'SCALAR';

      let innerResult = null;
      try { innerResult = this.parse(innerSql); } catch(e) {}

      results.push({ context, sql: innerSql, innerResult });
      i = parenEnd + 1;
    }
    return results;
  }

  /* Helpers */
  _matchParen(str, start) {
    let depth = 0;
    let inStr = false, strCh = '';
    for (let i = start; i < str.length; i++) {
      const ch = str[i];
      if (inStr) { if (ch === strCh) inStr = false; continue; }
      if (ch === "'" || ch === '"') { inStr = true; strCh = ch; continue; }
      if (ch === '(') depth++;
      else if (ch === ')') { depth--; if (depth === 0) return i; }
    }
    return -1;
  }

  _splitDepth0(str) {
    const parts = [];
    let depth = 0, cur = '', inStr = false, strCh = '';
    for (let i = 0; i < str.length; i++) {
      const ch = str[i];
      if (inStr) { cur += ch; if (ch === strCh) inStr = false; continue; }
      if (ch === "'" || ch === '"') { inStr = true; strCh = ch; cur += ch; continue; }
      if (ch === '(') { depth++; cur += ch; }
      else if (ch === ')') { depth--; cur += ch; }
      else if (ch === ',' && depth === 0) { parts.push(cur); cur = ''; }
      else cur += ch;
    }
    if (cur.trim()) parts.push(cur);
    return parts;
  }

  /*  Multi-statement entry point */
  parseAll(sql) {
    this.reset();
    // Strip T-SQL GO batch separators (replace each GO-only line with a semicolon)
    sql = sql.replace(/^\s*GO\s*$/gim, ';');
    const cleaned = this._clean(sql);
    const stmts   = this._splitStatements(cleaned);
    return stmts.map(s => this._classifyStmt(s)).filter(Boolean);
  }

  _splitStatements(sql) {
    // Split on semicolons at depth 0, respecting strings, parentheses, and BEGIN/END/CASE blocks
    const out = [];
    let cur = '', parenDepth = 0, blockDepth = 0, inStr = false, strCh = '';
    const upper = sql.toUpperCase();

    for (let i = 0; i < sql.length; i++) {
      const ch = sql[i];
      if (inStr) { cur += ch; if (ch === strCh) inStr = false; continue; }
      if (ch === "'" || ch === '"') { inStr = true; strCh = ch; cur += ch; continue; }
      if (ch === '(') { parenDepth++; cur += ch; continue; }
      if (ch === ')') { parenDepth--; cur += ch; continue; }

      // Track BEGIN/END/CASE blocks so semicolons inside them don't cause splits.
      // BEGIN TRANSACTION/TRAN/WORK is NOT a block — it just starts a transaction.
      if (parenDepth === 0 && (i === 0 || !/\w/.test(upper[i - 1]))) {
        const rest = upper.slice(i);
        if (/^BEGIN\b/.test(rest)) {
          const nextWord = rest.slice(5).trim();
          if (!/^(TRANSACTION|TRAN|WORK)\b/.test(nextWord)) blockDepth++;
          cur += sql.slice(i, i + 5); i += 4; continue;
        }
        if (/^CASE\b/.test(rest)) {
          blockDepth++;
          cur += sql.slice(i, i + 4); i += 3; continue;
        }
        if (/^END\b/.test(rest) && blockDepth > 0) {
          blockDepth--;
          cur += sql.slice(i, i + 3); i += 2; continue;
        }
      }

      if (ch === ';' && parenDepth === 0 && blockDepth === 0) {
        const t = cur.trim(); if (t) out.push(t); cur = '';
      } else { cur += ch; }
    }
    const last = cur.trim(); if (last) out.push(last);
    return out.length ? out : [sql.trim()];
  }

  _classifyStmt(sql) {
    const up = sql.replace(/\s+/g, ' ').trim().toUpperCase();

    // WITH ... INSERT: CTE followed by an INSERT (not a SELECT)
    if (/^WITH\b/.test(up)) {
      try {
        const { ctes, mainSql } = this._extractCTEs(this._clean(sql));
        if (/^\s*INSERT\b/i.test(mainSql)) {
          const r = this._parseInsertStmt(mainSql);
          r.ctes = ctes;
          return r;
        }
      } catch(e) {}
      // Otherwise fall through to parse as SELECT (WITH ... SELECT)
      try { return { stmtType: 'SELECT', ...this.parse(sql) }; }
      catch(e) { return { stmtType: 'SELECT', raw: sql, error: e.message, tables:[], joins:[], columns:[], ctes:[], conditions:{} }; }
    }

    if (/^SELECT\b/.test(up)) {
      try { return { stmtType: 'SELECT', ...this.parse(sql) }; }
      catch(e) { return { stmtType: 'SELECT', raw: sql, error: e.message, tables:[], joins:[], columns:[], ctes:[], conditions:{} }; }
    }
    if (/^INSERT\b/.test(up))   return this._parseInsertStmt(sql);
    if (/^UPDATE\b/.test(up))   return this._parseUpdateStmt(sql);
    if (/^DELETE\b/.test(up))   return this._parseDeleteStmt(sql);
    if (/^TRUNCATE\b/.test(up)) return this._parseTruncateStmt(sql);
    if (/^ALTER\b/.test(up))    return this._parseAlterStmt(sql);
    if (/^CREATE\b/.test(up))   return this._parseCreateStmt(sql);
    if (/^DROP\b/.test(up))     return this._parseDropStmt(sql);
    if (/^(EXEC|EXECUTE|CALL)\b/.test(up)) return this._parseExecStmt(sql);
    if (/^DECLARE\b/.test(up))  return this._parseDeclareStmt(sql);
    if (/^SET\b/.test(up))      return this._parseSetStmt(sql);
    if (/^RENAME\b/.test(up))   return this._parseRenameStmt(sql);
    if (/^EXPLAIN\b/.test(up))  return { stmtType: 'EXPLAIN', raw: sql };
    // BEGIN TRY...END TRY BEGIN CATCH...END CATCH — must come before general BEGIN handler
    if (/^BEGIN\s+TRY\b/.test(up)) return this._parseTryCatchBlock(sql);
    if (/^(BEGIN|END|COMMIT|ROLLBACK|SAVEPOINT)\b/.test(up)) {
      if (/^BEGIN\b/.test(up)) {
        const rest = up.slice(5).trim();
        // Pure BEGIN block (not a transaction keyword) — parse its contents
        if (rest && !/^(TRANSACTION|TRAN|WORK|TRY|CATCH)\b/.test(rest))
          return this._parseBeginBlock(sql);
      }
      return { stmtType: 'CONTROL', raw: sql };
    }
    if (/^IF\b/.test(up))    return this._parseIfStmt(sql);
    if (/^WHILE\b/.test(up)) return this._parseWhileStmt(sql);
    if (/^(ELSE|LOOP|PRINT|RAISERROR|THROW|RETURN|BREAK|CONTINUE)\b/.test(up))
      return { stmtType: 'CONTROL', raw: sql };
    return null;  // skip blanks / pure comments
  }

  _parseInsertStmt(sql) {
    const m  = sql.match(/INSERT\s+(?:INTO\s+)?([\w.\[\]`"]+)\s*(?:\(([^)]+)\))?\s*(VALUES?|SELECT|DEFAULT)/i);
    const targetTable = m ? m[1].replace(/[\[\]`"]/g, '') : null;
    const columns     = m && m[2] ? m[2].split(',').map(c => c.trim().replace(/[\[\]`"]/g, '')) : [];
    const sourceType  = m && m[3] ? m[3].toUpperCase().replace(/^VALUE$/, 'VALUES') : null;
    let   selectResult = null;
    const si = sql.search(/\bSELECT\b/i);
    if (si !== -1 && sourceType !== 'VALUES') {
      try { selectResult = this.parse(sql.slice(si)); } catch(e) {}
    }
    return { stmtType: 'INSERT', targetTable, columns, sourceType, selectResult, raw: sql };
  }

  _parseUpdateStmt(sql) {
    const tm  = sql.match(/UPDATE\s+([\w.\[\]`"]+)(?:\s+(?:AS\s+)?(\w+))?/i);
    const sm  = sql.match(/SET\s+([\s\S]+?)(?=\s+(?:WHERE|FROM|INNER|LEFT|RIGHT|FULL|CROSS|JOIN|ORDER|GROUP|HAVING|LIMIT)\b|$)/i);
    const wm  = sql.match(/WHERE\s+([\s\S]+?)(?=\s+(?:ORDER|GROUP|HAVING|LIMIT)\b|$)/i);
    const setCols = sm ? sm[1].split(',').map(s => {
      const p = s.trim().match(/^([\w.]+)\s*=/); return p ? p[1].trim() : s.trim();
    }).filter(Boolean) : [];
    let joins = [], tables = [];
    try { ({ joins, tables } = this._extractFromAndJoins(sql)); } catch(e) {}
    return {
      stmtType: 'UPDATE',
      targetTable: tm ? tm[1].replace(/[\[\]`"]/g, '') : null,
      alias: tm ? (tm[2] || null) : null,
      setCols, whereClause: wm ? wm[1].trim() : null,
      joins, tables, raw: sql
    };
  }

  _parseDeleteStmt(sql) {
    const m  = sql.match(/DELETE\s+(?:FROM\s+)?([\w.\[\]`"]+)/i);
    const wm = sql.match(/WHERE\s+([\s\S]+?)(?=\s+(?:ORDER|LIMIT)\b|$)/i);
    return { stmtType: 'DELETE', targetTable: m ? m[1].replace(/[\[\]`"]/g, '') : null, whereClause: wm ? wm[1].trim() : null, raw: sql };
  }

  _parseTruncateStmt(sql) {
    const m = sql.match(/TRUNCATE\s+(?:TABLE\s+)?([\w.\[\]`"]+)/i);
    return { stmtType: 'TRUNCATE', targetTable: m ? m[1].replace(/[\[\]`"]/g, '') : null, raw: sql };
  }

  _parseAlterStmt(sql) {
    const m = sql.match(/ALTER\s+(TABLE|VIEW|INDEX|PROCEDURE|FUNCTION)\s+([\w.\[\]`"]+)\s+([\s\S]+)$/i);
    const operation = m ? m[3].trim() : null;
    let opType = null;
    if (operation) {
      const ou = operation.toUpperCase().trim().replace(/\s+/g, ' ');
      if (/^ADD\s+COLUMN\b/.test(ou) || /^ADD\s+[\w`"\[]/.test(ou)) opType = 'ADD COLUMN';
      if (/^ADD\s+(CONSTRAINT|PRIMARY KEY|FOREIGN KEY|UNIQUE|CHECK)\b/.test(ou)) opType = 'ADD CONSTRAINT';
      if (/^DROP\s+COLUMN\b/.test(ou))      opType = 'DROP COLUMN';
      if (/^DROP\s+CONSTRAINT\b/.test(ou))  opType = 'DROP CONSTRAINT';
      if (/^DROP\s+PRIMARY\s+KEY\b/.test(ou)) opType = 'DROP CONSTRAINT';
      if (/^RENAME\b/.test(ou))             opType = 'RENAME';
      if (/^RENAME\s+COLUMN\b/.test(ou))    opType = 'RENAME COLUMN';
      if (/^MODIFY\b/.test(ou))             opType = 'MODIFY COLUMN';
      if (/^ALTER\s+COLUMN\b/.test(ou))     opType = 'ALTER COLUMN';
      if (/^CHANGE\b/.test(ou))             opType = 'CHANGE COLUMN';
    }
    return {
      stmtType: 'ALTER',
      objectType: m ? m[1].toUpperCase() : 'TABLE',
      targetTable: m ? m[2].replace(/[\[\]`"]/g, '') : null,
      opType,
      operation: operation ? operation.slice(0, 120) : null,
      raw: sql
    };
  }

  _parseCreateStmt(sql) {
    const m = sql.match(/CREATE\s+(?:OR\s+REPLACE\s+)?(?:UNIQUE\s+)?(?:TEMP(?:ORARY)?\s+)?(TABLE|VIEW|PROCEDURE|FUNCTION|INDEX|TRIGGER)\s+(?:IF\s+NOT\s+EXISTS\s+)?([\w.\[\]`"]+)/i);
    const result = {
      stmtType: 'CREATE',
      objectType: m ? m[1].toUpperCase() : 'OBJECT',
      objectName: m ? m[2].replace(/[\[\]`"]/g, '') : null,
      raw: sql
    };
    if (result.objectType === 'TABLE') {
      const parenStart = this._findKeywordAtDepth0(sql, '\\(') === -1
        ? sql.indexOf('(') : sql.indexOf('(');
      if (parenStart !== -1) {
        const parenEnd = this._matchParen(sql, parenStart);
        if (parenEnd !== -1) {
          try { Object.assign(result, this._parseCreateTableBody(sql.slice(parenStart + 1, parenEnd))); }
          catch(e) {}
        }
      }
    }
    if (result.objectType === 'INDEX') {
      const idxM = sql.match(/CREATE\s+(?:UNIQUE\s+)?INDEX\s+\S+\s+ON\s+([\w.`"\[\]]+)\s*\(([^)]+)\)/i);
      if (idxM) {
        result.onTable = idxM[1].replace(/[\[\]`"]/g, '');
        result.indexedColumns = idxM[2].split(',').map(c => c.trim().replace(/[\[\]`"]/g, ''));
        result.isUnique = /CREATE\s+UNIQUE\s+INDEX/i.test(sql);
      }
    }
    // For PROCEDURE / FUNCTION: extract the body (AS BEGIN...END) and parse it
    if (result.objectType === 'PROCEDURE' || result.objectType === 'FUNCTION') {
      const bodyM = sql.match(/\bAS\b\s+(BEGIN\b[\s\S]*)/i);
      if (bodyM) {
        try {
          const block = this._parseBeginBlock(bodyM[1]);
          result.bodyStmts = block.bodyStmts;
        } catch(e) {}
      }
    }
    return result;
  }

  _parseCreateTableBody(body) {
    const columns = [], constraints = [];
    for (const part of this._splitDepth0(body)) {
      const p = part.trim();
      if (!p) continue;
      const up = p.toUpperCase().replace(/\s+/g, ' ').trim();

      // Table-level constraint
      if (/^(CONSTRAINT\s+\w+\s+)?(PRIMARY KEY|FOREIGN KEY|UNIQUE|CHECK|INDEX|KEY)\b/.test(up)) {
        const nameM = p.match(/^CONSTRAINT\s+(\w+)\s+/i);
        const cName = nameM ? nameM[1] : null;
        const rest  = nameM ? p.slice(nameM[0].length).trim() : p;
        const ru    = rest.toUpperCase();
        if (/^PRIMARY KEY\b/.test(ru)) {
          const cm = rest.match(/PRIMARY\s+KEY\s*\(([^)]+)\)/i);
          constraints.push({ type: 'PRIMARY KEY', name: cName,
            columns: cm ? cm[1].split(',').map(c => c.trim().replace(/[\[\]`"]/g, '')) : [] });
        } else if (/^FOREIGN KEY\b/.test(ru)) {
          const fm = rest.match(/FOREIGN\s+KEY\s*\(([^)]+)\)\s*REFERENCES\s+([\w.`"\[\]]+)\s*(?:\(([^)]+)\))?/i);
          constraints.push({ type: 'FOREIGN KEY', name: cName,
            columns:    fm ? fm[1].split(',').map(c => c.trim().replace(/[\[\]`"]/g, '')) : [],
            refTable:   fm ? fm[2].replace(/[\[\]`"]/g, '') : null,
            refColumns: fm && fm[3] ? fm[3].split(',').map(c => c.trim().replace(/[\[\]`"]/g, '')) : [] });
        } else if (/^UNIQUE\b/.test(ru)) {
          const um = rest.match(/UNIQUE\s*(?:KEY\s*\w*\s*)?\(([^)]+)\)/i);
          constraints.push({ type: 'UNIQUE', name: cName,
            columns: um ? um[1].split(',').map(c => c.trim().replace(/[\[\]`"]/g, '')) : [] });
        } else if (/^CHECK\b/.test(ru)) {
          const chm = rest.match(/CHECK\s*\((.+)\)/i);
          constraints.push({ type: 'CHECK', name: cName, expression: chm ? chm[1] : null });
        }
        continue;
      }

      // Column definition: name type [inline constraints]
      const colM = p.match(/^([\w`"\[\]]+)\s+([\w]+(?:\s*\([^)]*\))?(?:\s*(?:UNSIGNED|ZEROFILL|BINARY|ASCII|UNICODE|CHARACTER\s+SET\s+\w+|COLLATE\s+\w+))*)/i);
      if (!colM) continue;
      const colName = colM[1].replace(/[\[\]`"]/g, '');
      const colType = colM[2].trim();
      const rest    = p.slice(colM[0].length);
      const ru      = rest.toUpperCase();
      const col = {
        name: colName, type: colType,
        notNull:       /\bNOT\s+NULL\b/.test(ru),
        primaryKey:    /\bPRIMARY\s+KEY\b/.test(ru),
        unique:        /\bUNIQUE\b/.test(ru),
        autoIncrement: /\b(AUTO_INCREMENT|AUTOINCREMENT|IDENTITY(?:\s*\([^)]*\))?)\b/.test(ru),
      };
      const defM = rest.match(/\bDEFAULT\s+(\S+)/i);
      if (defM) col.default = defM[1].replace(/['"]/g, '');
      const chkM = rest.match(/\bCHECK\s*\(([^)]+)\)/i);
      if (chkM) col.check = chkM[1];
      columns.push(col);
    }
    return { columns, constraints };
  }

  _parseDropStmt(sql) {
    const tm = sql.match(/DROP\s+(TABLE|VIEW|PROCEDURE|FUNCTION|INDEX|TRIGGER)/i);
    const nm = sql.match(/DROP\s+(?:TABLE|VIEW|PROCEDURE|FUNCTION|INDEX|TRIGGER)\s+(?:IF\s+EXISTS\s+)?([\w.\[\]`"]+)/i);
    return {
      stmtType: 'DROP',
      objectType: tm ? tm[1].toUpperCase() : 'OBJECT',
      objectName: nm ? nm[1].replace(/[\[\]`"]/g, '') : null,
      raw: sql
    };
  }

  _parseExecStmt(sql) {
    const m = sql.match(/(?:EXEC|EXECUTE|CALL)\s+([\w.\[\]`"]+)/i);
    return { stmtType: 'EXEC', procedureName: m ? m[1].replace(/[\[\]`"]/g, '') : null, raw: sql };
  }

  _parseDeclareStmt(sql) {
    const m = sql.match(/DECLARE\s+(@?[\w]+)\s+([\w()]+)/i);
    return { stmtType: 'DECLARE', varName: m ? m[1] : null, varType: m ? m[2] : null, raw: sql };
  }

  /* IF / ELSE parsing */
  _parseIfStmt(sql) {
    // Extract condition (parenthesized or bare)
    let pos = sql.match(/^IF\s*/i)[0].length;
    let condition = '';
    if (sql[pos] === '(') {
      // IF (condition) — whole condition is parenthesized
      const end = this._findMatchingParen(sql, pos);
      condition = end !== -1 ? sql.slice(pos + 1, end).trim() : '';
      pos = end !== -1 ? end + 1 : pos;
    } else {
      // IF EXISTS (...) / IF NOT EXISTS (...) / bare condition
      // Scan ahead char-by-char, tracking paren depth, until we hit BEGIN/SELECT/etc at depth 0
      let depth = 0, i = pos, condEnd = pos;
      while (i < sql.length) {
        const ch = sql[i];
        if (ch === '(') { depth++; i++; continue; }
        if (ch === ')') { depth--; i++; condEnd = i; continue; }
        if (depth === 0) {
          // Check for statement-starting keywords at depth 0
          const rest = sql.slice(i).toUpperCase();
          if (/^(BEGIN|SELECT|INSERT|UPDATE|DELETE|EXEC|EXECUTE)\b/.test(rest)) break;
        }
        i++;
        if (depth === 0) condEnd = i;
      }
      condition = sql.slice(pos, condEnd).trim();
      pos = condEnd;
    }
    while (pos < sql.length && /\s/.test(sql[pos])) pos++;

    // Extract THEN body
    const { content: thenContent, afterPos } = this._extractBlock(sql, pos);
    pos = afterPos;
    while (pos < sql.length && /\s/.test(sql[pos])) pos++;

    // Extract optional ELSE / ELSE IF body
    let elseContent = '', isElseIf = false;
    if (/^ELSE\b/i.test(sql.slice(pos))) {
      pos += 4;
      while (pos < sql.length && /\s/.test(sql[pos])) pos++;
      if (/^IF\b/i.test(sql.slice(pos))) {
        // ELSE IF — treat the rest as a nested IF
        elseContent = sql.slice(pos);
        isElseIf = true;
      } else {
        const { content } = this._extractBlock(sql, pos);
        elseContent = content;
      }
    }

    const parse = s => this._splitStatements(s).map(x => this._classifyStmt(x)).filter(Boolean);
    const thenStmts = thenContent ? parse(thenContent) : [];
    const elseStmts = isElseIf
      ? [this._parseIfStmt(elseContent)]          // nested IF
      : (elseContent ? parse(elseContent) : []);

    return { stmtType: 'IF', condition, thenStmts, elseStmts, raw: sql };
  }

  _parseWhileStmt(sql) {
    let pos = sql.match(/^WHILE\s*/i)[0].length;
    let condition = '';
    if (sql[pos] === '(') {
      const end = this._findMatchingParen(sql, pos);
      condition = end !== -1 ? sql.slice(pos + 1, end).trim() : '';
      pos = end !== -1 ? end + 1 : pos;
    } else {
      const m = sql.slice(pos).match(/^([\s\S]+?)(?=\s+BEGIN\b)/i);
      if (m) { condition = m[1].trim(); pos += m[0].length; }
    }
    while (pos < sql.length && /\s/.test(sql[pos])) pos++;
    const { content } = this._extractBlock(sql, pos);
    const bodyStmts = content
      ? this._splitStatements(content).map(s => this._classifyStmt(s)).filter(Boolean)
      : [];
    return { stmtType: 'WHILE', condition, bodyStmts, raw: sql };
  }

  /* Extracts content of BEGIN…END block or a single bare statement */
  _extractBlock(sql, startPos) {
    const upper = sql.toUpperCase();
    const slice = upper.slice(startPos).trimStart();
    const trimOffset = sql.slice(startPos).length - sql.slice(startPos).trimStart().length;
    const base = startPos + trimOffset;

    if (/^BEGIN\b/.test(slice)) {
      let depth = 0, i = base, contentStart = -1;
      while (i < sql.length) {
        if (/^BEGIN\b/.test(upper.slice(i))) {
          if (depth === 0) contentStart = i + 5;
          depth++; i += 5;
        } else if (/^END\b/.test(upper.slice(i))) {
          depth--;
          if (depth === 0)
            return { content: sql.slice(contentStart, i).trim(), afterPos: i + 3 };
          i += 3;
        } else { i++; }
      }
      return { content: sql.slice(contentStart || base).trim(), afterPos: sql.length };
    }
    // Single statement — ends at semicolon, ELSE, or end of string
    const m = sql.slice(base).match(/^([\s\S]+?)(?=\s*;|\s+ELSE\b|$)/i);
    const content = m ? m[1].trim() : '';
    return { content, afterPos: base + content.length };
  }

  /* Alias _matchParen as _findMatchingParen for use in IF/WHILE parsers */
  _findMatchingParen(sql, startPos) {
    return this._matchParen(sql, startPos);
  }

  /* RENAME TABLE */
  _parseRenameStmt(sql) {
    // MySQL: RENAME TABLE old TO new [, old2 TO new2 ...]
    const pairs = [];
    const re = /([\w.`"\[\]]+)\s+TO\s+([\w.`"\[\]]+)/gi;
    let m;
    while ((m = re.exec(sql)) !== null) {
      pairs.push({ oldName: m[1].replace(/[\[\]`"]/g, ''), newName: m[2].replace(/[\[\]`"]/g, '') });
    }
    return {
      stmtType: 'RENAME',
      oldName: pairs[0] ? pairs[0].oldName : null,
      newName: pairs[0] ? pairs[0].newName : null,
      pairs,   // all rename pairs when renaming multiple tables at once
      raw: sql
    };
  }

  /* SET statement (SET @var = val  or  SET OPTION ON/OFF) */
  _parseSetStmt(sql) {
    const varM = sql.match(/\bSET\s+(@[\w]+)\s*=\s*([\s\S]+?)$/i);
    if (varM) return { stmtType: 'SET', varName: varM[1], value: varM[2].trim().slice(0, 100), raw: sql };
    const optM = sql.match(/\bSET\s+([\w][\w\s]*?)\s+(ON|OFF)\s*$/i);
    if (optM) return { stmtType: 'SET', option: optM[1].trim(), value: optM[2].toUpperCase(), raw: sql };
    return { stmtType: 'SET', raw: sql };
  }

  /* BEGIN TRY...END TRY BEGIN CATCH...END CATCH */
  _parseTryCatchBlock(sql) {
    const upper = sql.toUpperCase();
    const tryOpenM = upper.match(/^BEGIN\s+TRY\b/);
    if (!tryOpenM) return { stmtType: 'TRY_BLOCK', tryStmts: [], catchStmts: [], raw: sql };

    let tryBodyStart = tryOpenM[0].length;
    while (tryBodyStart < sql.length && /\s/.test(sql[tryBodyStart])) tryBodyStart++;

    // Scan for the matching END TRY, respecting nested BEGIN/END (but not BEGIN TRANSACTION)
    let depth = 1, i = tryBodyStart;
    while (i < sql.length && depth > 0) {
      const prevIsWord = i > 0 && /\w/.test(upper[i - 1]);
      if (!prevIsWord) {
        const rest = upper.slice(i);
        if (/^BEGIN\b/.test(rest)) {
          const nextWord = rest.slice(5).trim();
          if (!/^(TRANSACTION|TRAN|WORK)\b/.test(nextWord)) depth++;
          i += 5; continue;
        }
        if (/^CASE\b/.test(rest)) { depth++; i += 4; continue; }
        if (/^END\b/.test(rest))  { depth--; if (depth === 0) break; i += 3; continue; }
      }
      i++;
    }

    const tryContent = sql.slice(tryBodyStart, i).trim();

    // Find BEGIN CATCH...END CATCH after END TRY
    const afterEndTry = sql.slice(i).replace(/^END\s+TRY\b\s*/i, '');
    const catchBodyM  = afterEndTry.match(/^\s*BEGIN\s+CATCH\b([\s\S]*?)\bEND\s+CATCH\b/i);
    const catchContent = catchBodyM ? catchBodyM[1].trim() : '';

    const parse = s => s
      ? this._splitStatements(s).map(x => this._classifyStmt(x)).filter(Boolean)
      : [];

    return {
      stmtType:   'TRY_BLOCK',
      tryStmts:   parse(tryContent),
      catchStmts: parse(catchContent),
      raw: sql
    };
  }

  /* Window function extraction */
  _extractWindowFunctions(columns) {
    const result = [];
    for (const col of columns) {
      if (!/\bOVER\s*\(/i.test(col.expression)) continue;
      // Find OVER ( … ) respecting nested parens
      const overKwM = col.expression.match(/\bOVER\s*\(/i);
      if (!overKwM) continue;
      const overParenStart = col.expression.indexOf('(', overKwM.index + overKwM[0].length - 1);
      const overParenEnd   = this._matchParen(col.expression, overParenStart);
      const over = overParenEnd !== -1 ? col.expression.slice(overParenStart + 1, overParenEnd) : '';

      const partM  = over.match(/\bPARTITION\s+BY\s+(.+?)(?=\s+ORDER\s+BY|\s+ROWS\s+|\s+RANGE\s+|\s+GROUPS\s+|$)/i);
      const ordM   = over.match(/\bORDER\s+BY\s+(.+?)(?=\s+ROWS\s+|\s+RANGE\s+|\s+GROUPS\s+|$)/i);
      const frameM = over.match(/\b(ROWS|RANGE|GROUPS)\b[\s\S]+$/i);
      const fnM    = col.expression.match(/^(\w+)\s*\(/i);

      result.push({
        expression:  col.expression,
        alias:       col.alias,
        functionName: fnM ? fnM[1].toUpperCase() : null,
        partitionBy: partM ? this._splitDepth0(partM[1].trim()).map(s => s.trim()) : [],
        orderBy:     ordM  ? this._splitDepth0(ordM[1].trim()).map(s => s.trim())  : [],
        frame:       frameM ? frameM[0].trim() : null,
      });
    }
    return result;
  }

  /*  BEGIN...END transaction / batch block */
  _parseBeginBlock(sql) {
    // Skip past "BEGIN" and an optional semicolon
    const beginMatch = sql.match(/^BEGIN\b\s*;?\s*/i);
    const startPos = beginMatch ? beginMatch[0].length : 5;

    // Walk forward tracking BEGIN/CASE depth to find the matching END
    let depth = 1, i = startPos;
    const upper = sql.toUpperCase();
    while (i < sql.length && depth > 0) {
      const prevIsWord = i > 0 && /\w/.test(upper[i - 1]);
      if (!prevIsWord) {
        const rest = upper.slice(i);
        if (/^BEGIN\b/.test(rest)) {
          // BEGIN TRANSACTION/TRAN/WORK is NOT a block
          const nextWord = rest.slice(5).trim();
          if (!/^(TRANSACTION|TRAN|WORK)\b/.test(nextWord)) depth++;
          i += 5; continue;
        }
        if (/^CASE\b/.test(rest))  { depth++; i += 4; continue; }
        if (/^END\b/.test(rest))   { depth--; if (depth === 0) break; i += 3; continue; }
      }
      i++;
    }

    const content   = sql.slice(startPos, i).trim();
    const bodyStmts = content
      ? this._splitStatements(content).map(s => this._classifyStmt(s)).filter(Boolean)
      : [];
    return { stmtType: 'BEGIN_BLOCK', bodyStmts, raw: sql };
  }
}
