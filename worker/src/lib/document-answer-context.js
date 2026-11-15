import { isPrimaryRecordKind } from './evidence-authority.js';

const text = value => String(value || '').replace(/\s+/g, ' ').trim();
const escape = value => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
// SI symbols are case-sensitive identity, not status or version qualifiers.
const unitPrefix = /^([yzafpnumcdhkMGTPEZY]?(?:m|g|s|A|K|mol|cd|W|V|Hz|J|Pa|N|C|F|Ω|S|T|H|L)) (.+)$/u;

function titleContext(doc, fields) {
  const title = text(doc.title);
  const bound = title && fields.subject &&
    new RegExp(`(?:^|\\s)${escape(title)}(?:$|\\s)`,'u').test(fields.subject.value);
  // Consume a positive title grammar independently of Subject and question.
  // Repeating arbitrary title text proves identity overlap, not its governing
  // status. Unconsumed modifiers, including unknown versions, stay unresolved.
  let identity = title;
  const status = /^(signed|executed|final)(?: and current)? (.+)$/i.exec(identity);
  if (status) {
    if (fields.status?.value !== `${status[1].toLowerCase()} and current`)
      return { checked:true, resolved:false };
    identity = status[2];
  }
  const unit = unitPrefix.exec(identity);
  if (unit) identity = unit[2];
  return { checked:true, resolved:Boolean(bound && isPrimaryRecordKind(identity)) };
}

function storageContext(doc) {
  // A locator is not a status assertion. Check semantic storage labels
  // separately from known opaque locator formats; unknown context stays open.
  const neutralContainer = value => /^(?:records?|documents?)$/i.test(value) ||
    isPrimaryRecordKind(value) || (value.endsWith('s') && isPrimaryRecordKind(value.slice(0,-1)));
  const folder = text(doc.top_folder);
  const folderResolved = !folder || neutralContainer(folder);
  if (!doc.uri) return { checked:true, resolved:folderResolved };
  try {
    const uri = new URL(doc.uri);
    const path = decodeURIComponent(uri.pathname);
    const params = [...uri.searchParams];
    const transportOnly = params.length<=1 && params.every(([key,value])=>
      key==='usp' && /^(?:sharing|drive_link)$/.test(value));
    // Drive webViewLink and document-editor URLs carry an opaque record ID.
    // Its characters are never interpreted as title or status evidence.
    const opaqueLocator = /^\/(?:file|document|spreadsheets|presentation)\/d\/[A-Za-z0-9_-]+\/(?:view|edit|preview)\/?$/.test(path);
    const segments = path.split('/').filter(Boolean);
    const neutralPath = segments.length>0 && segments.every(neutralContainer);
    return { checked:true, resolved:Boolean(folderResolved && uri.protocol==='https:' &&
      !uri.username && !uri.password && !uri.hash && transportOnly && (opaqueLocator || neutralPath)) };
  } catch { return { checked:true, resolved:false }; }
}

// A local, evidence-derived receipt. No caller/model boolean can certify it.
export function documentRecordContext(doc, fields) {
  return { title:titleContext(doc,fields), storage:storageContext(doc) };
}
