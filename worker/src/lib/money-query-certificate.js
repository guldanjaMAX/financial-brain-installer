import { moneyConfidenceScope } from './money-confidence.js';
import { MONEY_TABLE_COLUMNS } from './money-query-columns.js';

// This is a certificate grammar, not the read-only SQL validator. Each accepted
// production has explicit units, population and grouping obligations. No generic
// function/aggregate recognition is permitted here: SQLite MIN/MAX arity, bare
// columns and alias precedence made that approach unsafe. A failed proof only
// lowers confidence; it never changes execution, membership or returned amounts.
const columns=new Set(MONEY_TABLE_COLUMNS.txn);
const dimensions=new Set(['payee','payer_group','currency','category','side','tenant_id','entity','account_slug','account_identity','account']);
const moneyColumns=new Set(['amount_minor','income_minor','expense_minor','paid_minor','refund_minor','sales_adjust_minor',
  'interest_stated_minor','interest_expense_minor','interest_overlap_minor','income_adjust_minor',
  'credited_minor','debt_moved_minor','cross_side_minor','duplicate_minor']);
const id=t=>t && ['word','identifier'].includes(t.kind);
const word=(t,v)=>t?.kind==='word' && t.v===v;
const punct=(t,v)=>t?.kind==='punctuation' && t.v===v;
const number=(t,v)=>t?.kind==='number' && t.v===v;
const no=()=>({certified:false,code:'query_shape_not_certified',why:'query shape not certified: the SQL is outside the explicit High-confidence allow-list. The returned figure is retained; its attribution or arithmetic impact is unproved.',
  missing:'Use a literal-date-bounded txn SUM or bank-row COUNT with resolved grouping keys and complete account, category and party history evidence. For top groups, order by the same descending spending SUM. Other query shapes need their own reviewed proof before High confidence.'});

function split(tokens) {
  const items=[];let depth=0,start=0;
  for(let i=0;i<=tokens.length;i++) {
    if(i===tokens.length || punct(tokens[i],',') && depth===0) {
      if(i===start || depth!==0)return null;
      items.push(tokens.slice(start,i));start=i+1;
    } else if(punct(tokens[i],'('))depth++;
    else if(punct(tokens[i],')') && --depth<0)return null;
  }
  return items;
}
function call(tokens,name) {
  if(!word(tokens[0],name) || !punct(tokens[1],'(') || !punct(tokens.at(-1),')'))return null;
  return split(tokens.slice(2,-1));
}

// CLOSED-WORLD ALLOW-LIST (the final data checks remain independent ceilings):
// 1. SUM(one minor-unit contribution), optionally COALESCE(...,0), and COUNT(*)
//    / COUNT(DISTINCT party or row key). Each contribution/population is selected
//    by the proved literal-date AND grammar; every party is resolved and fully
//    read; currencies, categories, exclusions and type evidence must be proved.
// 2. Those aggregates grouped by displayed direct dimensions or a posting month.
//    GROUP BY resolves source columns before aliases. Every key is displayed,
//    every displayed dimension is a key, and output names are unique.
// 3. Top-N groups: first ORDER BY is that same expense SUM DESC; N is a positive
//    bounded literal and existing requested-rank/posted-measure proof must agree.
// 4. Ancillary COUNT, SUM(estimated), MIN/MAX(posted_on), GROUP_CONCAT([DISTINCT]
//    txn_uid/account_slug) describe the same bank rows; they cannot name a party.
// 5. Fixed monthly charge: genuine one-argument MIN/MAX(amount_minor), the closed
//    full-month HAVING proof, resolved payee/currency keys, and exactly one charge
//    per party/month (checked against the snapshot by queryMeasureRisks).
// 6. Operating subtotal: exactly SUM(income_minor)-SUM(expense_minor), with the
//    same population, currency, history and cash-boundary checks as both sums.
// Anything else, including scalar MIN/MAX, AVG, CASE arithmetic, windows, joins,
// subqueries, unions, arbitrary functions and unconsumed tokens, defaults to no.
export function certifyMoneyQuery(checked={}) {
  try {
    const tokens=checked?.tokens;
    if(!Array.isArray(tokens))return no();
    if(!word(tokens[0],'select'))return no();
    const clauses=[];let depth=0;
    for(let i=1;i<tokens.length;i++) {
      const t=tokens[i];
      if(punct(t,'('))depth++;
      else if(punct(t,')')){if(--depth<0)return no();}
      else if(!depth && t.kind==='word' && ['from','where','group','having','order','limit'].includes(t.v))clauses.push({name:t.v,index:i});
    }
    if(depth || clauses[0]?.name!=='from' || clauses[1]?.name!=='where')return no();
    const order=['from','where','group','having','order','limit'];
    if(clauses.some((c,i)=>i && order.indexOf(c.name)<=order.indexOf(clauses[i-1].name)))return no();
    const clause=name=>{
      const at=clauses.findIndex(c=>c.name===name);
      return at<0?null:tokens.slice(clauses[at].index+1,clauses[at+1]?.index??tokens.length);
    };
    const source=clause('from');
    if(!id(source[0]) || source[0].v!=='txn')return no();
    const alias=source.length===1?'txn':source.length===2 && id(source[1])?source[1].v:
      source.length===3 && word(source[1],'as') && id(source[2])?source[2].v:null;
    if(!alias)return no();
    const scope=moneyConfidenceScope({tokens});
    if(!scope)return no();
    const column=part=>part.length===1 && id(part[0]) && columns.has(part[0].v)?part[0].v:
      part.length===3 && id(part[0]) && [alias,'txn'].includes(part[0].v) && punct(part[1],'.') && id(part[2]) && columns.has(part[2].v)?part[2].v:null;
    const month=part=>{
      const args=call(part,'substr');
      return args?.length===3 && column(args[0])==='posted_on' && args[1].length===1 && number(args[1][0],'1') && args[2].length===1 && number(args[2][0],'7');
    };
    const dimension=part=>dimensions.has(column(part))?column(part):month(part)?'posting_month':null;
    const sum=part=>{
      const args=call(part,'sum'),c=args?.length===1?column(args[0]):null;
      return moneyColumns.has(c)?{key:`sum:${c}`,kind:'sum',column:c}:c==='estimated'?{key:'sum:estimated',kind:'diagnostic'}:null;
    };
    const expression=part=>{
      const key=dimension(part);if(key)return {key,kind:'dimension'};
      const s=sum(part);if(s)return s;
      const coalesce=call(part,'coalesce');
      if(coalesce?.length===2 && coalesce[1].length===1 && number(coalesce[1][0],'0')) {
        const s=sum(coalesce[0]);if(s?.kind==='sum')return {...s,key:`coalesce:${s.key}`};
      }
      const count=call(part,'count');
      if(count?.length===1) {
        const arg=count[0];
        if(arg.length===1 && punct(arg[0],'*'))return {key:'count:rows',kind:'count'};
        if(word(arg[0],'distinct')) {
          const rest=arg.slice(1),c=column(rest);
          if(['payee','payer_group','txn_uid','account_slug'].includes(c))return {key:`count:${c}`,kind:'count'};
          if(scope.recurring && month(rest))return {key:'count:months',kind:'recurring_months'};
        }
      }
      for(const fn of ['min','max']) {
        const args=call(part,fn),c=args?.length===1?column(args[0]):null;
        if(c==='posted_on')return {key:`${fn}:posted_on`,kind:'diagnostic'};
        if(scope.recurring && c==='amount_minor')return {key:`${fn}:amount_minor`,kind:'recurring_charge'};
      }
      const concat=call(part,'group_concat');
      if(concat?.length===1) {
        const arg=concat[0],distinct=word(arg[0],'distinct'),c=column(distinct?arg.slice(1):arg);
        if(['txn_uid','account_slug'].includes(c))return {key:`ids:${distinct}:${c}`,kind:'diagnostic'};
      }
      // Deliberately one reviewed arithmetic production, not arbitrary math
      // composed from otherwise approved functions or bare row references.
      for(let i=1;i<part.length;i++)if(punct(part[i],'-')) {
        const left=sum(part.slice(0,i)),right=sum(part.slice(i+1));
        if(left?.column==='income_minor' && right?.column==='expense_minor')return {key:'operating_net',kind:'operating_net'};
      }
      return null;
    };
    const parts=split(tokens.slice(1,clauses[0].index));if(!parts)return no();
    const fields=parts.map(part=>{
      const named=part.length>=3 && word(part.at(-2),'as') && id(part.at(-1));
      const value=named?part.slice(0,-2):part,expr=expression(value);
      return {expr,alias:named?part.at(-1).v:null,value};
    });
    if(fields.some(f=>!f.expr))return no();
    const names=new Set();
    for(const f of fields) {
      const name=f.alias??(column(f.value)||f.expr.key);
      if(names.has(name))return no();names.add(name);
      // Source names carry meaning as well as units. Keep the same contribution
      // name; the one cash-paid form is gross amount_minor over literal outflows.
      // Party proof below uses parsed source fields, never output aliases.
      if(f.alias && columns.has(f.alias) && f.expr.key!==f.alias &&
        f.expr.column!==f.alias && !(f.alias==='paid_minor' && f.expr.kind==='sum' &&
          f.expr.column==='amount_minor' && scope.filters.direction==='outflow'))return no();
      const labelled={income:'income_minor',receipts:'income_minor',expense:'expense_minor',expenses:'expense_minor',spending:'expense_minor'};
      if(labelled[f.alias] && f.expr.column!==labelled[f.alias])return no();
      if(['vendor','payer','party','customer'].includes(f.alias) &&
        (f.expr.kind!=='dimension' || !['payee','payer_group'].includes(f.expr.key)))return no();
      if(f.alias==='month' && f.expr.key!=='posting_month')return no();
      if(['cents','monthly_minor','charge_minor'].includes(f.alias) &&
        !['sum','operating_net','recurring_charge'].includes(f.expr.kind))return no();
    }
    if(!fields.some(f=>['sum','count','recurring_charge','operating_net'].includes(f.expr.kind)))return no();
    const resolve=(part,ordering=false)=>{
      if(part.length===1 && id(part[0]) && (ordering || !columns.has(part[0].v))) {
        const field=fields.find(f=>f.alias===part[0].v);if(field)return field.expr;
      }
      return expression(part);
    };
    const group=clause('group');let keys=[];
    if(group) {
      if(!word(group[0],'by'))return no();
      const parts=split(group.slice(1));if(!parts)return no();
      keys=parts.map(part=>resolve(part));
      if(keys.some(key=>key?.kind!=='dimension') || new Set(keys.map(k=>k.key)).size!==keys.length)return no();
    }
    const displayed=fields.filter(f=>f.expr.kind==='dimension').map(f=>f.expr.key);
    if(displayed.some(key=>!keys.some(k=>k.key===key)) || keys.some(key=>!displayed.includes(key.key)))return no();
    if(scope.recurring) {
      if(!clause('having') || !['payee','currency'].every(k=>keys.some(key=>key.key===k)) || keys.length!==2 ||
        fields.some(f=>!['dimension','recurring_charge','recurring_months'].includes(f.expr.kind)) ||
        !fields.some(f=>f.expr.kind==='recurring_charge'))return no();
    } else if(clause('having'))return no();
    const sorting=clause('order');let sorted=[];
    if(sorting) {
      if(!word(sorting[0],'by'))return no();
      const parts=split(sorting.slice(1));if(!parts)return no();
      sorted=parts.map(part=>{
        const directed=word(part.at(-1),'asc') || word(part.at(-1),'desc');
        return {expr:resolve(directed?part.slice(0,-1):part,true),direction:directed?part.at(-1).v:'asc'};
      });
      if(sorted.some(s=>!s.expr || !fields.some(f=>f.expr.key===s.expr.key)))return no();
    }
    const limit=clause('limit');
    if(limit && (scope.recurring || limit.length!==1 || limit[0].kind!=='number' || !/^\d+$/.test(limit[0].v) ||
      Number(limit[0].v)<1 || Number(limit[0].v)>1000 || !keys.length ||
      sorted[0]?.expr?.key!=='sum:expense_minor' || sorted[0].direction!=='desc'))return no();
    const contributions=[...new Set(fields.flatMap(f=>f.expr.kind==='recurring_charge'?['expense_minor']:
      f.expr.kind==='operating_net'?['income_minor','expense_minor']:f.expr.kind==='sum'?[f.expr.column]:[]))];
    const whereEnd=clauses[2]?.index??tokens.length;
    return {certified:true,shape:scope.recurring?'fixed_monthly_charge':limit?'top_spending_groups':keys.length?'grouped_aggregate':'aggregate',
      fields:contributions.length?contributions:['amount_minor'],
      // Private proof consumers execute this against the same frozen txn CTE,
      // never against a newly classified or caller-supplied row population.
      populationSql:'SELECT * FROM '+checked.sql.slice(source[0].start-tokens[0].start,tokens[whereEnd-1].end-tokens[0].start),
      populationWhere:clause('where'),sourceAlias:alias,
      groups:keys.map(k=>{
        const f=fields.find(f=>f.expr.key===k.key),last=f.alias?parts[fields.indexOf(f)].at(-1):null;
        const label=last?.kind==='identifier'?last.raw.slice(1,-1).replaceAll(last.raw[0]+last.raw[0],last.raw[0]):last?.raw;
        return {key:k.key,output:label??column(f.value)??checked.sql.slice(f.value[0].start-tokens[0].start,f.value.at(-1).end-tokens[0].start)};
      })};
  } catch { return no(); }
}
