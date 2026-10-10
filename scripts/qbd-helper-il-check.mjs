import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

const REQUESTS = new Set(['HostQueryRq', 'CompanyQueryRq', 'PreferencesQueryRq', 'CurrencyQueryRq',
  'AccountQueryRq', 'CustomerQueryRq', 'VendorQueryRq', 'InvoiceQueryRq', 'BillQueryRq', 'CreditMemoQueryRq',
  'TransactionQueryRq', 'BillPaymentCheckQueryRq', 'BillPaymentCreditCardQueryRq', 'ReceivePaymentQueryRq',
  'TxnDeletedQueryRq', 'ListDeletedQueryRq']);
const PRIVATE_FIELD = /^(?:VendorTaxIdent|BankNumber|AccountNumber|CreditCardInfo|Notes|Desc|SSN|EIN|CompanyFileName)$/i;
const fail = () => { throw new Error('QB_HELPER_STATIC_REFUSAL'); };
export function checkQbdContract(contract) {
  if (contract?.protocol !== 1 || contract.minimumVersion !== '13.0' || contract.requests?.length !== 17 || contract.returns?.length !== 16 || contract.exits?.length !== 14) fail();
  const identity = contract.probeIdentity;
  if (identity?.request !== 'Account' || identity.maxRows !== 10_000 ||
      JSON.stringify(identity.fields) !== JSON.stringify(['ListID', 'TimeCreated']) || identity.verification !== 'unverified against Intuit') fail();
  const seen = new Set();
  for (const request of contract.requests) {
    if (!REQUESTS.has(request.request) || !request.request.endsWith('QueryRq') || seen.has(request.key) ||
        !['base', 'balance', 'history', 'postdated'].includes(request.mode) || typeof request.iterator !== 'boolean' ||
        request.response !== request.request.replace(/Rq$/, 'Rs')) fail();
    seen.add(request.key);
  }
  if (new Set(contract.requests.map((entry) => entry.request)).size !== REQUESTS.size) fail();
  const returned = new Set();
  for (const ret of contract.returns) {
    if (!/^[A-Za-z]+Ret$/.test(ret.name) || returned.has(ret.name) || !ret.fields?.length ||
        new Set(ret.fields).size !== ret.fields.length || ret.fields.some((field) => !/^[A-Za-z]+(?:\.[A-Za-z]+)*$/.test(field) || field.split('.').some((part) => PRIVATE_FIELD.test(part)))) fail();
    const payment = ['BillPaymentCheckRet', 'BillPaymentCreditCardRet'].includes(ret.name);
    if (payment) {
      // This is the only admitted object array. Keep its shape and budget closed
      // so adding a nested field cannot bypass the scalar privacy gate above.
      const link = ret.repeated?.[0];
      if (ret.repeated?.length !== 1 || link?.field !== 'AppliedToTxnRet' || link.maxItems !== 500 ||
          !ret.fields.includes(link.field) || JSON.stringify(link.fields) !== JSON.stringify(['TxnID', 'TxnType', 'Amount'])) fail();
    } else if (ret.repeated?.length || ret.fields.includes('AppliedToTxnRet')) fail();
    returned.add(ret.name);
  }
  if (contract.requests.some((entry) => !returned.has(entry.ret))) fail();
  const account = contract.requests.find((entry) => entry.key === identity.request);
  if (account?.request !== 'AccountQueryRq' || account.ret !== 'AccountRet' || account.mode !== 'balance' || account.iterator !== true) fail();
  if (new Set(contract.exits.map((entry) => entry.value)).size !== 14 || new Set(contract.exits.map((entry) => entry.code)).size !== 14 ||
      contract.exits.some((entry, i) => entry.value !== 10 + i || !/^QB_[A-Z_]+$/.test(entry.code)) ||
      contract.exits.find((entry) => entry.code === 'QB_PARTIAL_VIEW')?.value !== 21) fail();
  return { requestSets: contract.requests.length, returnTypes: returned.size, exits: contract.exits.length };
}
export function checkQbdSource(source, contract) {
  const counts = checkQbdContract(contract);
  // Do not strip strings: forbidden APIs, URLs, and write request literals in
  // strings must fail too. Comments are retained for conservative inspection.
  if (/\bProcess\b/.test(source) || /System\s*\.\s*Net\b|\bSockets?\b|\bXmlUrlResolver\b|https?:\/\//i.test(source) ||
      /\b(?:Assembly\.(?:Load|LoadFrom|LoadFile)|GetTypeFromCLSID|DllImport\s*\(\s*[^"\s])/.test(source) ||
      /(?:XmlDocument|XDocument)\s*\.\s*Load\s*\(/.test(source)) fail();
  const identities = [...source.matchAll(/GetTypeFromProgID\s*\(([^)]*)\)/g)];
  if (identities.length !== 1 || identities[0][1].trim() !== '"QBXMLRP2.RequestProcessor", false') fail();
  if ([...source.matchAll(/\b[A-Za-z]+(?:Add|Mod|Del|Void|DataExtAdd)Rq\b/g)].length) fail();
  for (const [, element] of source.matchAll(/"([A-Za-z]+Rq)"/g)) if (element !== 'QBXMLMsgsRq' && !REQUESTS.has(element)) fail();
  for (const invariant of ['DtdProcessing.Prohibit', 'settings.XmlResolver = null', 'document.XmlResolver = null',
    'reader.Depth > 24', 'settings.MaxCharactersInDocument', 'DataContractJsonSerializer', 'RegOverridePredefKey',
    'processor.End(ticket)', 'processor.Close()', 'Frame(output, new QbdTerminal',
    'writer.WriteStartElement(request.request)', 'Build(request, version, iterator, plan, index, identityOnly)']) if (!source.includes(invariant)) fail();
  if (!/document\.Load\(reader\)/.test(source) || /\.Load\((?!reader\))/.test(source)) fail();
  if ((source.match(/\.Query\(/g) || []).length !== 1 || !source.includes('processor.Query(ticket, xml)')) fail();
  for (const [, dll] of source.matchAll(/\[DllImport\("([^"]+)"/g)) if (!['advapi32.dll', 'ole32.dll', 'kernel32.dll'].includes(dll)) fail();
  const methodNames = [...source.matchAll(/(?:Call|InvokeMember)\("([^"]+)"/g)].map((match) => match[1]);
  const approvedMethods = new Set(['AuthPreferences', 'PutIsReadOnly', 'PutUnattendedModePref', 'PutPersonalDataPref', 'PutAuthFlags',
    'OpenConnection2', 'BeginSession', 'ProcessRequest', 'EndSession', 'CloseConnection']);
  if (methodNames.length !== 10 || methodNames.some((name) => !approvedMethods.has(name)) ||
      (source.match(/InvokeMember\s*\(/g) || []).length !== 6) fail();
  return counts;
}
// These are metadata type references, not substring matches of disassembly.
// Reflection, XML, and native entry points have an additional member allowlist.
const TYPES = new Set([
  'System.Object', 'System.String', 'System.Boolean', 'System.Byte', 'System.Int32', 'System.UInt32', 'System.Int64',
  'System.IntPtr', 'System.UIntPtr', 'System.Double', 'System.Char', 'System.Array', 'System.Math', 'System.Convert',
  'System.Exception', 'System.Console', 'System.IDisposable', 'System.Type', 'System.Activator', 'System.Version',
  'System.DateTime', 'System.DateTimeStyles', 'System.StringComparison', 'System.StringComparer', 'System.Func',
  'System.IAsyncResult', 'System.AsyncCallback', 'System.MulticastDelegate', 'System.Delegate', 'System.RuntimeTypeHandle',
  'System.Collections.Generic.Dictionary', 'System.Collections.Generic.Dictionary+Enumerator',
  'System.Collections.Generic.List', 'System.Collections.Generic.List+Enumerator', 'System.Collections.Generic.HashSet',
  'System.Collections.Generic.HashSet+Enumerator', 'System.Collections.Generic.IEnumerable',
  'System.Collections.Generic.IEnumerator', 'System.Collections.Generic.ICollection', 'System.Collections.Generic.IEqualityComparer', 'System.Collections.IEnumerator',
  'System.Collections.IEnumerable', 'System.Globalization.CultureInfo', 'System.Globalization.NumberStyles', 'System.Globalization.DateTimeStyles',
  'System.IO.Stream', 'System.IO.MemoryStream', 'System.IO.StringReader', 'System.Text.StringBuilder', 'System.Text.Encoding',
  'System.Text.RegularExpressions.Regex', 'System.Text.RegularExpressions.RegexOptions',
  'System.Reflection.Assembly', 'System.Reflection.BindingFlags', 'System.Reflection.MemberInfo',
  'System.Runtime.InteropServices.Marshal', 'System.Runtime.InteropServices.DllImportAttribute',
  'System.Runtime.InteropServices.CharSet', 'System.Runtime.InteropServices.CallingConvention',
  'System.Runtime.InteropServices.PreserveSigAttribute', 'System.Runtime.InteropServices.ComVisibleAttribute',
  'System.Runtime.InteropServices.UnmanagedType', 'System.Runtime.Serialization.DataContractAttribute',
  'System.Runtime.Serialization.DataMemberAttribute', 'System.Runtime.Serialization.Json.DataContractJsonSerializer',
  'System.Runtime.Serialization.Json.DataContractJsonSerializerSettings', 'System.Runtime.Serialization.XmlObjectSerializer',
  'System.Threading.Timer', 'System.Threading.TimerCallback', 'System.Threading.Timeout', 'System.Threading.Interlocked',
  'System.Xml.XmlReader', 'System.Xml.XmlReaderSettings', 'System.Xml.XmlDocument', 'System.Xml.XmlNode', 'System.Xml.XmlElement',
  'System.Xml.XmlNodeList', 'System.Xml.XmlWriter', 'System.Xml.XmlWriterSettings', 'System.Xml.XmlResolver', 'System.Xml.DtdProcessing',
  'System.STAThreadAttribute', 'System.ParamArrayAttribute', 'System.Diagnostics.DebuggableAttribute',
  'System.Diagnostics.DebuggableAttribute+DebuggingModes', 'System.Runtime.CompilerServices.CompilerGeneratedAttribute',
  'System.Runtime.CompilerServices.RuntimeCompatibilityAttribute', 'System.Runtime.CompilerServices.CompilationRelaxationsAttribute',
  'System.Security.Permissions.SecurityPermissionAttribute', 'System.Security.Permissions.SecurityAction',
]);
const MEMBERS = {
  'System.Type': new Set(['GetTypeFromProgID', 'GetTypeFromHandle', 'InvokeMember']),
  'System.Activator': new Set(['CreateInstance']),
  'System.Reflection.Assembly': new Set(['GetExecutingAssembly', 'GetManifestResourceStream']),
  'System.Runtime.InteropServices.Marshal': new Set(['IsComObject', 'FinalReleaseComObject']),
  'System.Xml.XmlDocument': new Set(['.ctor', 'set_XmlResolver', 'Load', 'get_DocumentElement']),
};
const NATIVE = new Set(['advapi32.dll::RegOpenKeyExW', 'advapi32.dll::RegOverridePredefKey', 'advapi32.dll::RegCloseKey',
  'ole32.dll::CoEnableCallCancellation', 'ole32.dll::CoDisableCallCancellation', 'ole32.dll::CoCancelCall', 'kernel32.dll::GetCurrentThreadId']);
const typeName = (name) => name.replace(/`\d+/g, '');
export function checkQbdIl(metadata) {
  if (metadata?.format !== 'qbd-metadata-v1' || !Array.isArray(metadata.types) || metadata.types.length === 0 ||
      !Array.isArray(metadata.members) || metadata.members.length === 0 || !Array.isArray(metadata.pinvokes) || metadata.pinvokes.length !== 7 ||
      !Array.isArray(metadata.assemblies) || metadata.assemblies.length === 0) fail();
  if (metadata.assemblies.some((name) => !['mscorlib', 'System', 'System.Core', 'System.Xml', 'System.Runtime.Serialization'].includes(name))) fail();
  for (const name of metadata.types) if (!TYPES.has(typeName(name))) fail();
  for (const member of metadata.members) {
    const name = typeName(member.type);
    if (!TYPES.has(name) || (MEMBERS[name] && !MEMBERS[name].has(member.name))) fail();
  }
  if (new Set(metadata.pinvokes).size !== 7 || metadata.pinvokes.some((name) => !NATIVE.has(name))) fail();
  return { types: metadata.types.length, members: metadata.members.length, native: metadata.pinvokes.length };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const args = process.argv.slice(2);
    if (args.length !== 0 && !(args.length === 2 && args[0] === '--il')) fail();
    const contract = JSON.parse(readFileSync(new URL('../operations/quickbooks-desktop-requests.json', import.meta.url), 'utf8'));
    const source = readFileSync(new URL('../operations/quickbooks-desktop-helper.cs', import.meta.url), 'utf8');
    const counts = checkQbdSource(source, contract);
    const il = args.length ? checkQbdIl(JSON.parse(readFileSync(args[1], 'utf8').replace(/^\uFEFF/, ''))) : null;
    console.log(JSON.stringify({ ok: true, ...counts, il }));
  } catch { console.error('QB_HELPER_STATIC_REFUSAL'); process.exitCode = 1; }
}
