import { assertFinancialContract, canonicalFinancialJson, resolveFinancialCell, verifyFinancialSnapshot } from './financial-snapshot-contract.js';
import { assertMoney, financialError, moneyFromMinor, sumMoney } from './financial-money.js';

// resolveSnapshot is a trusted, access-checked current-generation reader. It
// must check source custody and the active map on every call, including cache
// hits. A raw client snapshot or an LLM-provided resolver is never authority.
export async function verifyFinancialAnswerPlan(plan, { resolveSnapshot } = {}) {
  const trace = ['contract'];
  try {
    assertFinancialContract('answer', plan);
    if (typeof resolveSnapshot !== 'function') throw financialError('access_unavailable');
    const text = [], roots = new Set();
    for (const claim of plan.claims) {
      const cells = [], snapshots = [];
      const coordinates = new Set();
      for (const citation of claim.operands) {
        trace.push('access');
        const snapshot = await resolveSnapshot(citation);
        if (!snapshot) throw financialError('source_unavailable');
        await verifyFinancialSnapshot(snapshot);
        trace.push('scope');
        if (canonicalFinancialJson(snapshot.scope) !== canonicalFinancialJson(plan.scope) || Date.parse(snapshot.observed_at) > Date.parse(plan.observed_at)) throw financialError('scope_mismatch');
        trace.push('citation');
        const resolved = resolveFinancialCell(snapshot, citation);
        const coordinate = canonicalFinancialJson([citation.snapshot_id, citation.row_path, citation.column_key]);
        if (coordinates.has(coordinate)) throw financialError('duplicate_operand');
        coordinates.add(coordinate);
        snapshot.lineage.root_ids.forEach(root => roots.add(root));
        if (roots.size > 16) throw financialError('lineage_limit');
        trace.push('coverage');
        if (claim.qualification === 'complete_report_scope' && snapshot.coverage.state !== 'complete_for_report_scope') throw financialError('coverage_incomplete');
        if (claim.qualification === 'partial_individual_fact' && resolved.row.kind !== 'detail') throw financialError('partial_aggregate');
        if (resolved.cell.role !== claim.role || resolved.cell.role === 'unknown') throw financialError('role_mismatch');
        assertMoney(resolved.cell.money, { exact: true });
        cells.push(resolved); snapshots.push(snapshot);
      }
      trace.push('arithmetic');
      let computed;
      if (claim.operation === 'source_cell') computed = cells[0].cell.money;
      else {
        // Cross-report arithmetic needs a stronger fence than matching dates.
        if (snapshots.some(snapshot => snapshot.generation !== snapshots[0].generation ||
          snapshot.observed_at !== snapshots[0].observed_at || snapshot.coverage.mutation_check.state !== 'stable' ||
          snapshot.coverage.mutation_check.before !== snapshots[0].coverage.mutation_check.before)) throw financialError('not_comparable');
        const values = cells.map(({ cell }) => cell.money);
        if (claim.operation === 'difference') {
          if (values[0].currency !== values[1].currency) throw financialError('mixed_currency');
          computed = moneyFromMinor(BigInt(values[0].amount_minor) - BigInt(values[1].amount_minor), values[0].currency);
        } else {
          // V1 supports only a complete, flat, documented subtotal. General
          // partition/FX/percentage arithmetic belongs in a versioned adapter.
          const totalSnapshot = await resolveSnapshot(claim.additive_set_ref);
          await verifyFinancialSnapshot(totalSnapshot);
          if (snapshots.some(snapshot => snapshot.content_hash !== totalSnapshot.content_hash)) throw financialError('additivity_unproved');
          const total = resolveFinancialCell(totalSnapshot, claim.additive_set_ref);
          const children = totalSnapshot.rows.filter(row => row.parent_path === total.row.row_path);
          if (!['subtotal', 'total'].includes(total.row.kind) || children.length !== cells.length ||
            children.some(row => row.kind !== 'detail' || !cells.some(cell => cell.row.row_path === row.row_path)) ||
            claim.operands.some(citation => citation.column_key !== claim.additive_set_ref.column_key)) throw financialError('additivity_unproved');
          computed = sumMoney(values);
          assertMoney(total.cell.money, { exact: true });
          if (computed.amount_minor !== total.cell.money.amount_minor || computed.currency !== total.cell.money.currency) throw financialError('report_total_mismatch');
        }
      }
      assertMoney(claim.value, { exact: true });
      if (computed.amount_minor !== claim.value.amount_minor || computed.currency !== claim.value.currency) throw financialError('claim_mismatch');
      // No free prose or model-supplied labels can introduce unbound monetary
      // spans. Future renderers must preserve this closed numeric surface.
      const rendered = moneyFromMinor(computed.amount_minor, computed.currency);
      text.push(`${claim.qualification === 'partial_individual_fact' ? 'Partial individual source value' : 'Source-scoped value'}: ${rendered.currency} ${rendered.decimal}. Period ${plan.scope.period_start} to ${plan.scope.period_end}; ${plan.scope.basis} basis; observed ${plan.observed_at}.`);
    }
    return { ok: true, trace, text: text.join('\n'), claims: structuredClone(plan.claims) };
  } catch (error) {
    return { ok: false, trace, reason: error?.code || 'evidence_unavailable' };
  }
}
