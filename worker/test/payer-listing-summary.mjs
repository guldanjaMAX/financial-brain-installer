import {readFileSync,writeFileSync} from 'node:fs';
import {score,overRefusal} from './payer-listing-score.mjs';
const path=new URL('../../payer-listing.results.json',import.meta.url);
const input=JSON.parse(readFileSync(path));
const rows=input.results.map(c=>({...c,status:score(c),over_refusal:overRefusal(c)}));
const counts=mode=>rows.filter(c=>c.mode===mode).reduce((a,c)=>(a[c.status]=(a[c.status]||0)+1,a.over_refusals=(a.over_refusals||0)+Number(c.over_refusal),a),{});
const seen=new Set();
const results=rows.map(c=>{
 const key=c.mode+':'+c.kind+':'+c.status;
 const keep=c.status==='WRONG FIGURE'&&!seen.has(key);seen.add(key);
 const {body,...rest}=c;
 return {...rest,...(keep?{body}:{}),reason:body.gaps?.[0]?.reason,ledger_kind:body.ledger?.kind};
});
writeFileSync(new URL('../../payer-listing-summary.json',import.meta.url),JSON.stringify({cases:rows.length/2,model:input.model,network:input.network,base:counts('base'),rule:counts('rule'),results})+'\n');
console.log(JSON.stringify({base:counts('base'),rule:counts('rule')}));
