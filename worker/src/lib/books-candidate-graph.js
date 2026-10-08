import { financialError } from './financial-money.js';

/** Build the entire graph before allocating anything. IDs only order output. */
export function booksCandidateComponents(left, right, compatible, duplicates = () => false) {
  const nodes = [...left.map(record => ({ side: 'left', record })),
    ...right.map(record => ({ side: 'right', record }))];
  const parent = nodes.map((_, index) => index);
  function root(index) {
    while (parent[index] !== index) { parent[index] = parent[parent[index]]; index = parent[index]; }
    return index;
  }
  const edges = [];
  for (let i = 0; i < nodes.length; i++) {
    for (let j = i + 1; j < nodes.length; j++) {
      const a = nodes[i], b = nodes[j];
      const reason = a.side === b.side ? duplicates(a.record, b.record) : compatible(a.record, b.record);
      if (!reason) continue;
      // Dense ambiguous sets must refuse as a whole, never truncate candidates
      // or serialize a quadratic response beyond the Worker evidence budget.
      if (edges.length === 10000) throw financialError('books_candidate_bound');
      parent[root(j)] = root(i);
      edges.push({ from: i, to: j, reason });
    }
  }
  const groups = new Map();
  for (let i = 0; i < nodes.length; i++) {
    const key = root(i);
    if (!groups.has(key)) groups.set(key, { left: [], right: [], edges: [] });
    groups.get(key)[nodes[i].side].push(nodes[i].record);
  }
  for (const edge of edges) groups.get(root(edge.from)).edges.push({
    left: nodes[edge.from].record, right: nodes[edge.to].record, reason: edge.reason,
  });
  return [...groups.values()];
}
