const dayNumber = day => Math.floor(Date.parse(day + 'T00:00:00Z') / 86400000);
const order = (a,b) => a.posted_on.localeCompare(b.posted_on) || a.id-b.id;

// Amount coincidence is a review signal, never owner-approved identity. Only
// a dense mirrored feed can lose a likely copy; unmatched dollars stay counted.
export function markFeedDuplicates(rows, decisions, provedIds = new Set(), coverage = []) {
  const byId = new Map(decisions.map(d=>[d.id,d])), groups = new Map();
  for (const r of rows) {
    const d=byId.get(r.id);
    if (!d || !['ordinary','payout'].includes(d.money_kind) || provedIds.has(r.id) || !(r.amount_minor>0)) continue;
    const k=JSON.stringify([r.tenant_id,r.account,r.currency]);
    if (!groups.has(k)) groups.set(k,new Map());
    const accounts=groups.get(k);
    if (!accounts.has(r.account_slug)) accounts.set(r.account_slug,[]);
    accounts.get(r.account_slug).push(r);
  }
  const used=new Set();
  const match=(a,b) => {
    const buckets=new Map(), matches=[];
    for (const r of b.sort(order)) {
      const k=JSON.stringify([r.direction,r.amount_minor,dayNumber(r.posted_on)]);
      if (!buckets.has(k)) buckets.set(k,[]);
      buckets.get(k).push(r);
    }
    // Date buckets avoid quadratic pair materialization on repeated amounts.
    for (let gap=0;gap<=3;gap++) for (const r of a.sort(order)) {
      if (used.has(r.id)) continue;
      for (const offset of gap ? [-gap,gap] : [0]) {
        const peers=buckets.get(JSON.stringify([r.direction,r.amount_minor,dayNumber(r.posted_on)+offset]));
        while (peers?.length && used.has(peers[0].id)) peers.shift();
        if (!peers?.length) continue;
        const p=peers.shift(); used.add(r.id); used.add(p.id); matches.push([r,p]); break;
      }
    }
    return matches;
  };
  const flag=(r,reason) => {
    const d=byId.get(r.id);
    if (!d.estimated) { d.estimated=1; d.estimate_reason=reason; }
  };
  for (const accounts of groups.values()) {
    const entries=[...accounts].sort(([a],[b])=>a.localeCompare(b));
    for (let i=0;i<entries.length;i++) for (let j=i+1;j<entries.length;j++) {
      const [as,a]=entries[i], [bs,b]=entries[j];
      if (!/^\d{4}$/.test(a[0].account || '') || a[0].account_identity===b[0].account_identity) continue;
      const matches=match(a,b); if (!matches.length) continue;
      const first=Math.max(dayNumber(a[0].posted_on),dayNumber(b[0].posted_on)),
        last=Math.min(dayNumber(a.at(-1).posted_on),dayNumber(b.at(-1).posted_on));
      const overlap=rs=>rs.filter(r=>dayNumber(r.posted_on)>=first && dayNumber(r.posted_on)<=last).length;
      const uniqueDay=rs=>{const counts=new Map();for(const r of rs){const k=JSON.stringify([r.posted_on,r.direction,r.amount_minor]);counts.set(k,(counts.get(k)||0)+1);}return [...counts.values()].every(n=>n===1);};
      const mirror=uniqueDay(a) && uniqueDay(b) && a[0].entity===b[0].entity && a[0].identity_basis==='separate_account' && b[0].identity_basis==='separate_account' &&
        matches.length>=5 && matches.length*5>=4*Math.min(overlap(a),overlap(b));
      const ca=coverage.find(c=>c.tenant_id===a[0].tenant_id && c.account_slug===as),
        cb=coverage.find(c=>c.tenant_id===b[0].tenant_id && c.account_slug===bs);
      const loser=a[0].feed_kind==='import' && b[0].feed_kind!=='import' ? 0 : b[0].feed_kind==='import' && a[0].feed_kind!=='import' ? 1 :
        (ca?.history_first_row || a[0].posted_on)<(cb?.history_first_row || b[0].posted_on) ? 0 :
        (ca?.history_first_row || a[0].posted_on)>(cb?.history_first_row || b[0].posted_on) ? 1 : 1;
      for (const pair of matches) {
        for (const r of pair) flag(r,'possible_duplicate_feed_counted');
        const d=byId.get(pair[loser].id);d.duplicate_minor=pair[loser].amount_minor;
        if (mirror) Object.assign(d,{classification:'unknown',money_kind:'likely_duplicate',estimated:1,
          estimate_reason:'likely_duplicate_feed_left_out',uncertain_kind:null});
      }
    }
    // Two imports into one account can use different descriptions. Distinct
    // source documents/feeds, rather than words, nominate these possible copies.
    for (const [,own] of entries) {
      const sources=new Map();
      for (const r of own) {
        const source=r.source_doc_uid ? 'doc:'+r.source_doc_uid : r.source_feed ? 'feed:'+r.source_feed : null;
        if (!source) continue;
        if (!sources.has(source)) sources.set(source,[]);
        sources.get(source).push(r);
      }
      const lists=[...sources].sort(([a],[b])=>a.localeCompare(b));
      for (let i=0;i<lists.length;i++) for (let j=i+1;j<lists.length;j++) for (const pair of match(lists[i][1],lists[j][1])) {
        for (const r of pair) flag(r,'possible_duplicate_import_counted');
        byId.get(pair[1].id).duplicate_minor=pair[1].amount_minor;
      }
    }
  }
}
