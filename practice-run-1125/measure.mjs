import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { context } from './mark.mjs';
import { localRoot } from './local-evidence.mjs';
import { plain, read, replace, fail } from './safe-files.mjs';
import { data, check } from './summary-shape.mjs';

const schema = JSON.parse(fs.readFileSync(new URL('./SUMMARY.schema.json', import.meta.url), 'utf8')).properties.measurements;
export const ROWS = Object.freeze([...Array.from({length:9},(_,i)=>'A'+i),...Array.from({length:33},(_,i)=>String(i+1))]);
export const SUBSTEPS = Object.freeze(Array.from('abcdefg',letter=>'A2'+letter));
export const COUNTS = Object.freeze(['databases','search_indexes','workers','web_addresses','settings_files','tmp_files','connector_entries','lock_folders','answer_journals','tools_folders','test_notes','saved_sign_ins','devices','schedules']);
export const ROUND_METRICS = Object.freeze(['setup_ms','bank_ms','owner_initial_ms','owner_return_ms','longest_screen_silence_ms','sign_ins','approvals']);
export const ROW_METRICS = Object.freeze(['owner_present_ms','longest_screen_silence_ms','sign_ins','approvals','questions','lock_wait_ms','blocked_window_ms']);
export const RESOURCE_POINTS = Object.freeze(['BASELINE',...['BEFORE','AFTER'].flatMap(side=>ROWS.map(row=>side+'_'+row))]);
const GAP_CODES = {gap_code:['NONE','G1','G2','G3','G4','G5','G6','G7'],gap_result:['PASS','FAIL','GAP'],owner_gap_decision:['PENDING','ACCEPTED','REJECTED']};
const SCORE_FIELDS = ['action','jargon','time','clicks','next'];
const RUN_CODES = {
  vectorize_key_asked:['YES','NO'],closing_line_seen:['YES','NO'],restart_steps_seen:['YES','NO'],bank_sync_proven:['YES','NO'],
  first_question:['DOCUMENT','MONEY'],phone_link_route:['CAMERA','MESSAGE','SAME_DEVICE','OTHER'],
  finished_setup:['PASS','FAIL'],finished_note:['PASS','FAIL'],finished_answers:['PASS','FAIL'],finished_device:['PASS','FAIL'],finished_checks:['PASS','FAIL'],finished_question:['PASS','FAIL'],
};
function invalid() { const error = new Error('Use an allowed measurement scope, metric and bounded value.'); error.code = 'MEASUREMENT_INVALID'; throw error; }
const fields = names => Object.fromEntries(names.map(name=>[name,null]));
function empty(machine) {
  return {machine,package_size_bytes:null,rounds:['A','B'].map(round=>({round,...fields(ROUND_METRICS)})),
    rows:ROWS.map(id=>({id,...fields([...ROW_METRICS,...Object.keys(GAP_CODES)])})),substeps:SUBSTEPS.map(id=>({id,duration_ms:null})),
    codes:[1,2,3].map(ordinal=>({ordinal,lifetime_ms:null,approval_delay_ms:null,outcome:null})),
    resources:RESOURCE_POINTS.map(point=>({point,counts:null})),screens:[],lowest_three:[],observations:fields(Object.keys(RUN_CODES))};
}
function bounded(value, maximum) { if (value !== null && (!Number.isSafeInteger(value) || value < 0 || value > maximum)) invalid(); }
function allowed(value, values) { if (value !== null && !values.includes(value)) invalid(); }
function apply(value, entry) {
  if (!entry || Array.isArray(entry) || Object.keys(entry).sort().join(',') !== 'metric,scope,value') invalid();
  const {scope,metric,value:observation}=entry;
  if (typeof scope !== 'string' || typeof metric !== 'string') invalid();
  let target, maximum=604800000, codes;
  if (['ROUND_A','ROUND_B'].includes(scope) && ROUND_METRICS.includes(metric)) target=value.rounds[scope==='ROUND_A'?0:1];
  else if (ROWS.includes(scope) && (ROW_METRICS.includes(metric) || Object.hasOwn(GAP_CODES,metric))) {
    target=value.rows[ROWS.indexOf(scope)]; codes=GAP_CODES[metric];
  }
  else if (SUBSTEPS.includes(scope) && metric==='duration_ms') target=value.substeps[SUBSTEPS.indexOf(scope)];
  else if (/^CODE_[123]$/.test(scope) && ['lifetime_ms','approval_delay_ms','outcome'].includes(metric)) {
    target=value.codes[Number(scope.at(-1))-1]; if(metric==='outcome') codes=['EXPIRED','APPROVED','NOT_APPLICABLE'];
  } else if (scope==='RUN' && (metric==='package_size_bytes' || Object.hasOwn(RUN_CODES,metric))) {
    target=metric==='package_size_bytes'?value:value.observations; maximum=1000000000; codes=RUN_CODES[metric];
  } else if ((scope==='BASELINE' || /^(BEFORE|AFTER)_(?:A[0-8]|[1-9]|[12][0-9]|3[0-3])$/.test(scope)) && COUNTS.includes(metric)) {
    const snapshot=value.resources.find(item=>item.point===scope);
    if(!snapshot.counts) snapshot.counts=fields(COUNTS);
    target=snapshot.counts;
    maximum=10000;
  } else if (/^SCREEN_(?:[1-9]|[1-9][0-9]{1,2}|1000)$/.test(scope)) {
    const ordinal=Number(scope.slice(7));
    const score=/^(model|fresh)_(action|jargon|time|clicks|next|kind_words|diagnostics)$/.exec(metric);
    if(!score && !['row','kind','gap'].includes(metric)) invalid();
    target=value.screens.find(item=>item.ordinal===ordinal);
    if(!target) { target={ordinal,row:null,kind:null,gap:null,model:null,fresh:null}; value.screens.push(target); }
    if(score) {
      const [,scorer,field]=score;
      if(!target[scorer]) target[scorer]={...fields([...SCORE_FIELDS,'kind_words','diagnostics']),total:null};
      if (SCORE_FIELDS.includes(field)) bounded(observation,2); else allowed(observation,['YES','NO','NOT_APPLICABLE']);
      target[scorer][field]=observation; return;
    }
    codes=metric==='row'?[...ROWS,...SUBSTEPS]:metric==='kind'?['STANDARD','ERROR']:['NONE','G6','G7'];
  } else invalid();
  if(codes) allowed(observation,codes);
  else bounded(observation,['sign_ins','approvals','questions'].includes(metric)?10000:maximum);
  target[metric]=observation;
}
function ledger(dir) {
  const file=path.join(localRoot(dir),'MEASUREMENTS.json');
  if(!plain(file,{absent:true})) return {schema_version:1,entries:[]};
  const bytes=read(file); if(Buffer.byteLength(bytes)>2*1024*1024) invalid();
  const value=JSON.parse(bytes); data(value);
  if(!value || Object.keys(value).sort().join(',')!=='entries,schema_version' || value.schema_version!==1 || !Array.isArray(value.entries) || value.entries.length>20000) invalid();
  return value;
}
function derive(dir, local) {
  const value=empty(context(dir).config.machine), seen=new Set();
  for(const entry of local.entries) {
    const key=JSON.stringify([entry.scope,entry.metric]); if(seen.has(key)) invalid(); seen.add(key);
    apply(value,entry);
  }
  value.screens.sort((a,b)=>a.ordinal-b.ordinal);
  for(const screen of value.screens) for(const scorer of ['model','fresh']) {
    const scores=screen[scorer]; if(scores) scores.total=SCORE_FIELDS.every(field=>scores[field]!==null)?SCORE_FIELDS.reduce((sum,field)=>sum+scores[field],0):null;
  }
  value.lowest_three=value.screens.filter(screen=>screen.model?.total!=null && screen.fresh?.total!=null)
    .sort((a,b)=>Math.min(a.model.total,a.fresh.total)-Math.min(b.model.total,b.fresh.total)||a.ordinal-b.ordinal).slice(0,3).map(screen=>screen.ordinal);
  validateMeasurements(value); return value;
}
export function validateMeasurements(value) {
  data(value); check(value,schema);
  if(value.rounds.some((item,i)=>item.round!==['A','B'][i]) || value.rows.some((item,i)=>item.id!==ROWS[i]) || value.substeps.some((item,i)=>item.id!==SUBSTEPS[i]) || value.codes.some((item,i)=>item.ordinal!==i+1) || value.resources.some((item,i)=>item.point!==RESOURCE_POINTS[i])) invalid();
  for(let index=0;index<value.screens.length;index++) {
    const screen=value.screens[index]; if(index && screen.ordinal<=value.screens[index-1].ordinal) invalid();
    for(const scorer of ['model','fresh']) if(screen[scorer]) {
      const scores=screen[scorer], total=SCORE_FIELDS.every(field=>scores[field]!==null)?SCORE_FIELDS.reduce((sum,field)=>sum+scores[field],0):null;
      if(scores.total!==total) invalid();
    }
  }
  const lowest=value.screens.filter(screen=>screen.model?.total!=null && screen.fresh?.total!=null)
    .sort((a,b)=>Math.min(a.model.total,a.fresh.total)-Math.min(b.model.total,b.fresh.total)||a.ordinal-b.ordinal).slice(0,3).map(screen=>screen.ordinal);
  if(JSON.stringify(value.lowest_three)!==JSON.stringify(lowest)) invalid();
  return value;
}
export function readMeasurements(dir) { return derive(dir,ledger(dir)); }
export function recordMeasurement(dir,scope,metric,value) {
  data(value);
  const local=ledger(dir); local.entries.push({scope,metric,value});
  derive(dir,local); // RECORD_VALIDATE before any write
  replace(path.join(localRoot(dir),'MEASUREMENTS.json'),JSON.stringify(local,null,2)+'\n');
}
export function main(args=process.argv.slice(2)) {
  if(args.length!==3) invalid();
  const [scope,metric,text]=args;
  const value=text==='UNOBSERVED'?null:/^(?:0|[1-9][0-9]*)$/.test(text)?Number(text):text;
  recordMeasurement(process.cwd(),scope,metric,value);
  console.log('Local numeric or fixed-code observation recorded. Share only validated SUMMARY.json.');
}
if(process.argv[1] && import.meta.url===pathToFileURL(process.argv[1]).href) {
  try {main();} catch {fail('No measurement was written. Check the allowed scope, metric, value and existing observations.');}
}
