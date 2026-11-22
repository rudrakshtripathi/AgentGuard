const MAX_SQL_LENGTH = 10_000;
const MUTATIONS = new Set(['DELETE', 'DROP', 'TRUNCATE', 'UPDATE', 'ALTER', 'GRANT', 'REVOKE', 'INSERT', 'MERGE']);

export interface SqlStatementAnalysis {
  destructive: boolean;
  unboundedMutation: boolean;
  irreversibleDdl: boolean;
}

export interface SqlAnalysis {
  statements: SqlStatementAnalysis[];
}

/** Tokenizes SQL sufficiently for conservative risk classification, without interpreting string contents. */
export function analyzeSql(query: string): SqlAnalysis | null {
  if (query.length > MAX_SQL_LENGTH) return null;
  const statements: string[][] = [];
  let tokens: string[] = [];
  let i = 0;
  let parenthesisDepth = 0;
  while (i < query.length) {
    const ch = query[i]!;
    const next = query[i + 1];
    if (/\s/.test(ch)) { i++; continue; }
    if (ch === '-' && next === '-') {
      i += 2;
      while (i < query.length && query[i] !== '\n' && query[i] !== '\r') i++;
      continue;
    }
    if (ch === '/' && next === '*') {
      i += 2;
      let depth = 1;
      while (i < query.length && depth > 0) {
        if (query[i] === '/' && query[i + 1] === '*') { depth++; i += 2; }
        else if (query[i] === '*' && query[i + 1] === '/') { depth--; i += 2; }
        else i++;
      }
      if (depth !== 0) return null;
      continue;
    }
    if (ch === ';') {
      if (tokens.length) statements.push(tokens);
      tokens = [];
      i++;
      continue;
    }
    if (ch === "'" || ch === '"' || ch === '`' || ch === '[') {
      const close = ch === '[' ? ']' : ch;
      let closed = false;
      i++;
      while (i < query.length) {
        if (query[i] === close) {
          if (query[i + 1] === close && close !== ']') { i += 2; continue; }
          i++;
          closed = true;
          break;
        }
        i++;
      }
      if (!closed) return null;
      tokens.push(ch === "'" ? '<STRING>' : '<IDENTIFIER>');
      continue;
    }
    if (/[A-Za-z_]/.test(ch)) {
      let word = ch;
      i++;
      while (i < query.length && /[A-Za-z0-9_$]/.test(query[i]!)) word += query[i++];
      tokens.push(word.toUpperCase());
      continue;
    }
    if (ch === '(') parenthesisDepth++;
    else if (ch === ')') {
      if (parenthesisDepth === 0) return null;
      parenthesisDepth--;
    }
    tokens.push(ch);
    i++;
  }
  if (parenthesisDepth !== 0) return null;
  if (tokens.length) statements.push(tokens);

  return {
    statements: statements.map((statement) => {
      let depth = 0;
      const depths = statement.map((token) => {
        if (token === ')') depth = Math.max(0, depth - 1);
        const tokenDepth = depth;
        if (token === '(') depth++;
        return tokenDepth;
      });
      const mutationIndexes = statement.flatMap((token, index) => MUTATIONS.has(token) ? [index] : []);
      const destructive = mutationIndexes.length > 0;
      const unboundedMutation = mutationIndexes.some((index) =>
        ['DELETE', 'UPDATE', 'TRUNCATE'].includes(statement[index]!) &&
        !statement.slice(index + 1).some((token, offset) => token === 'WHERE' && depths[index + 1 + offset] === depths[index]),
      );
      const irreversibleDdl = mutationIndexes.some((index) => ['DROP', 'TRUNCATE'].includes(statement[index]!));
      return { destructive, unboundedMutation, irreversibleDdl };
    }),
  };
}
