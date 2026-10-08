// Build once, then ship identical signed bytes. There is no runtime compiler.
using System;
using System.Collections.Generic;
using System.Globalization;
using System.IO;
using System.Reflection;
using System.Runtime.InteropServices;
using System.Runtime.Serialization;
using System.Runtime.Serialization.Json;
using System.Text;
using System.Text.RegularExpressions;
using System.Threading;
using System.Xml;

[DataContract] internal sealed class QbdRequest {
    [DataMember] public string key;
    [DataMember] public string request;
    [DataMember] public string response;
    [DataMember] public string ret;
    [DataMember] public string mode;
    [DataMember] public bool iterator;
}
[DataContract] internal sealed class QbdReturn {
    [DataMember] public string name;
    [DataMember] public string[] fields;
}
[DataContract] internal sealed class QbdExit {
    [DataMember] public int value;
    [DataMember] public string code;
}
[DataContract] internal sealed class QbdContract {
    [DataMember] public int protocol;
    [DataMember] public string minimumVersion;
    [DataMember] public QbdRequest[] requests;
    [DataMember] public QbdReturn[] returns;
    [DataMember] public QbdExit[] exits;
}
[DataContract] internal sealed class QbdPlan {
    [DataMember(IsRequired = true)] public string historySince;
    [DataMember(IsRequired = true)] public string[] accountListIds;
    [DataMember(IsRequired = true)] public string[] storedTxnIds;
    [DataMember(IsRequired = true)] public string postdatedFrom;
}
[DataContract] internal sealed class QbdBatch {
    [DataMember] public int protocol = 1;
    [DataMember] public string type = "batch";
    [DataMember] public string request;
    [DataMember] public string entity;
    [DataMember] public List<Dictionary<string, object>> rows;
}
[DataContract] internal sealed class QbdReceipt {
    [DataMember] public string id;
    [DataMember] public int iteratorRemainingCount;
    [DataMember] public int statusCode;
    [DataMember] public string statusSeverity = "Info";
    [DataMember] public int rowCount;
    [DataMember] public int requestCount;
    [DataMember] public int matchedCount;
}
[DataContract] internal sealed class QbdTerminal {
    [DataMember] public int protocol = 1;
    [DataMember] public string type = "terminal";
    [DataMember] public List<QbdReceipt> requests;
}
internal sealed class QbdFailure : Exception {
    internal readonly string Code;
    internal QbdFailure(string code) : base(code) { Code = code; }
}
internal interface IQbdProcessor {
    void Authorize();
    void Open();
    string Begin();
    string Query(string ticket, string xml);
    void End(string ticket);
    void Close();
}
internal sealed class QbdCom : IQbdProcessor, IDisposable {
    // FIELD-VERIFY against Intuit SDK and the Windows field gate before pinning.
    // Never infer these enum values from a successful transport-only test.
    private const int umptOptional = 2;
    private const int pdpNotNeeded = 0;
    private const int qbafProPremierEnterprise = 7;
    private const int localQBD = 1;
    private const int qbFileOpenDoNotCare = 2;
    private object processor;
    private UIntPtr classes;
    private bool overridden;
    [DllImport("advapi32.dll", EntryPoint = "RegOpenKeyExW", ExactSpelling = true, CharSet = CharSet.Unicode)]
    private static extern int RegOpenKeyEx(UIntPtr key, string subkey, uint options, int access, out UIntPtr result);
    [DllImport("advapi32.dll")]
    private static extern int RegOverridePredefKey(UIntPtr key, UIntPtr replacement);
    [DllImport("advapi32.dll")]
    private static extern int RegCloseKey(UIntPtr key);

    internal QbdCom() {
        // HKLM inspection alone is insufficient: ordinary COM activation also
        // consults HKCU. Restrict HKCR in this short-lived process before COM is
        // initialized. FIELD-VERIFY this redirect with a hostile HKCU fixture.
        try {
            if (RegOpenKeyEx(new UIntPtr(0x80000002u), "SOFTWARE\\Classes", 0,
                    0x20019 | (IntPtr.Size == 4 ? 0x200 : 0x100), out classes) != 0 ||
                RegOverridePredefKey(new UIntPtr(0x80000000u), classes) != 0)
                throw new QbdFailure("QB_PROCESSOR_UNTRUSTED");
            overridden = true;
            Type type = Type.GetTypeFromProgID("QBXMLRP2.RequestProcessor", false);
            if (type == null) throw new QbdFailure("QB_NOT_INSTALLED");
            processor = Activator.CreateInstance(type);
        } catch { Dispose(); throw; }
    }
    private object Call(string member, params object[] args) {
        return processor.GetType().InvokeMember(member, BindingFlags.InvokeMethod, null, processor, args, CultureInfo.InvariantCulture);
    }
    public void Authorize() {
        object preferences = processor.GetType().InvokeMember("AuthPreferences", BindingFlags.GetProperty, null, processor, null, CultureInfo.InvariantCulture);
        try {
            Type type = preferences.GetType();
            type.InvokeMember("PutIsReadOnly", BindingFlags.InvokeMethod, null, preferences, new object[] { true });
            type.InvokeMember("PutUnattendedModePref", BindingFlags.InvokeMethod, null, preferences, new object[] { umptOptional });
            type.InvokeMember("PutPersonalDataPref", BindingFlags.InvokeMethod, null, preferences, new object[] { pdpNotNeeded });
            type.InvokeMember("PutAuthFlags", BindingFlags.InvokeMethod, null, preferences, new object[] { qbafProPremierEnterprise });
        } finally { if (preferences != null && Marshal.IsComObject(preferences)) Marshal.FinalReleaseComObject(preferences); }
    }
    public void Open() { Call("OpenConnection2", "", "Financial Brain", localQBD); }
    public string Begin() { return (string)Call("BeginSession", "", qbFileOpenDoNotCare); }
    public string Query(string ticket, string xml) { return (string)Call("ProcessRequest", ticket, xml); }
    public void End(string ticket) { Call("EndSession", ticket); }
    public void Close() { Call("CloseConnection"); }
    public void Dispose() {
        try { if (processor != null && Marshal.IsComObject(processor)) Marshal.FinalReleaseComObject(processor); }
        finally {
            processor = null;
            if (overridden) RegOverridePredefKey(new UIntPtr(0x80000000u), UIntPtr.Zero);
            if (classes != UIntPtr.Zero) RegCloseKey(classes);
            classes = UIntPtr.Zero;
            overridden = false;
        }
    }
}
internal static class QbdHelper {
    internal static readonly QbdContract Contract = ReadContract();
    private const int MaxXmlCharacters = 8 * 1024 * 1024;
    private const int MaxFrameBytes = 2 * 1024 * 1024;
    private const int MaxPlanBytes = 1024 * 1024;
    private const int MaxTotalBytes = 64 * 1024 * 1024;
    private static readonly Regex Id = new Regex("\\A[0-9A-F]{1,16}-[0-9]{1,12}\\z", RegexOptions.CultureInvariant);
    private static int outputBytes;
    [DllImport("ole32.dll")] private static extern int CoEnableCallCancellation(IntPtr reserved);
    [DllImport("ole32.dll")] private static extern int CoDisableCallCancellation(IntPtr reserved);
    [DllImport("ole32.dll")] private static extern int CoCancelCall(uint thread, uint timeout);
    [DllImport("kernel32.dll")] private static extern uint GetCurrentThreadId();

    private static QbdContract ReadContract() {
        using (Stream stream = Assembly.GetExecutingAssembly().GetManifestResourceStream("QbdContract")) {
            if (stream == null) throw new QbdFailure("QB_HELPER_UNAVAILABLE");
            return (QbdContract)new DataContractJsonSerializer(typeof(QbdContract)).ReadObject(stream);
        }
    }
    private static T Timed<T>(Func<T> action, int timeout, string timeoutCode) {
        // Cooperative COM cancellation preserves finally when the server honors
        // it. A wedged server may ignore it; the bridge has a longer hard bound.
        // FIELD-VERIFY cancellation with the supported request processor.
        uint thread = GetCurrentThreadId();
        if (CoEnableCallCancellation(IntPtr.Zero) < 0) throw new QbdFailure("QB_BUSY");
        int expired = 0;
        try {
            using (Timer timer = new Timer(delegate(object ignored) {
                Interlocked.Exchange(ref expired, 1);
                CoCancelCall(thread, 0);
            }, null, timeout, Timeout.Infinite)) {
                T result = action();
                if (Interlocked.CompareExchange(ref expired, 0, 0) != 0) throw new QbdFailure(timeoutCode);
                return result;
            }
        } catch {
            if (Interlocked.CompareExchange(ref expired, 0, 0) != 0) throw new QbdFailure(timeoutCode);
            throw;
        } finally { CoDisableCallCancellation(IntPtr.Zero); }
    }
    internal static void ValidatePlan(QbdPlan plan, string operation, DateTime today) {
        if (plan == null || plan.accountListIds == null || plan.storedTxnIds == null ||
            plan.accountListIds.Length > 10000 || plan.storedTxnIds.Length > 10000) throw new QbdFailure("QB_PARTIAL_VIEW");
        foreach (string[] ids in new string[][] { plan.accountListIds, plan.storedTxnIds }) {
            HashSet<string> seen = new HashSet<string>(StringComparer.Ordinal);
            foreach (string id in ids) if (id == null || !Id.IsMatch(id) || !seen.Add(id)) throw new QbdFailure("QB_PARTIAL_VIEW");
        }
        if (operation != "snapshot") {
            if (plan.historySince != "" || plan.postdatedFrom != "" || plan.accountListIds.Length != 0 || plan.storedTxnIds.Length != 0)
                throw new QbdFailure("QB_PARTIAL_VIEW");
            return;
        }
        DateTime bound;
        if (!DateTime.TryParseExact(plan.historySince, "yyyy-MM-dd'T'HH:mm:ss'Z'", CultureInfo.InvariantCulture,
                DateTimeStyles.AssumeUniversal | DateTimeStyles.AdjustToUniversal, out bound) ||
            plan.postdatedFrom != today.AddDays(1).ToString("yyyy-MM-dd", CultureInfo.InvariantCulture))
            throw new QbdFailure("QB_PARTIAL_VIEW");
    }
    private static byte[] ReadExact(Stream stream, int count) {
        byte[] bytes = new byte[count];
        int offset = 0;
        while (offset < count) {
            int got = stream.Read(bytes, offset, count - offset);
            if (got <= 0) throw new QbdFailure("QB_PARTIAL_VIEW");
            offset += got;
        }
        return bytes;
    }
    private static QbdPlan ReadPlan(Stream stream) {
        byte[] header = ReadExact(stream, 4);
        uint count = ((uint)header[0] << 24) | ((uint)header[1] << 16) | ((uint)header[2] << 8) | header[3];
        if (count < 2 || count > MaxPlanBytes) throw new QbdFailure("QB_PARTIAL_VIEW");
        byte[] bytes = ReadExact(stream, (int)count);
        try {
            if (stream.ReadByte() != -1) throw new QbdFailure("QB_PARTIAL_VIEW");
            using (MemoryStream input = new MemoryStream(bytes)) {
                return (QbdPlan)new DataContractJsonSerializer(typeof(QbdPlan)).ReadObject(input);
            }
        } finally { Array.Clear(bytes, 0, bytes.Length); }
    }
    private static void Frame<T>(Stream output, T value) {
        using (MemoryStream stream = new MemoryStream()) {
            DataContractJsonSerializerSettings settings = new DataContractJsonSerializerSettings();
            settings.UseSimpleDictionaryFormat = true;
            settings.KnownTypes = new Type[] { typeof(List<string>) };
            new DataContractJsonSerializer(typeof(T), settings).WriteObject(stream, value);
            if (stream.Length > MaxFrameBytes || outputBytes + stream.Length + 4 > MaxTotalBytes) throw new QbdFailure("QB_PARTIAL_VIEW");
            int length = (int)stream.Length;
            byte[] header = new byte[] { (byte)(length >> 24), (byte)(length >> 16), (byte)(length >> 8), (byte)length };
            output.Write(header, 0, 4);
            stream.Position = 0;
            stream.CopyTo(output);
            output.Flush(); // Broken pipes throw through Execute's finally.
            outputBytes += length + 4;
        }
    }
    internal static XmlDocument Parse(string xml) {
        if (xml == null || xml.Length == 0 || xml.Length > MaxXmlCharacters) throw new QbdFailure("QB_PARTIAL_VIEW");
        XmlReaderSettings settings = new XmlReaderSettings();
        settings.DtdProcessing = DtdProcessing.Prohibit;
        settings.XmlResolver = null;
        settings.MaxCharactersInDocument = MaxXmlCharacters;
        settings.MaxCharactersFromEntities = 0;
        using (StringReader text = new StringReader(xml))
        using (XmlReader reader = XmlReader.Create(text, settings)) {
            while (reader.Read()) {
                if (reader.Depth > 24 || reader.NamespaceURI.Length != 0) throw new QbdFailure("QB_PARTIAL_VIEW");
            }
        }
        XmlDocument document = new XmlDocument();
        document.XmlResolver = null;
        using (StringReader text = new StringReader(xml))
        using (XmlReader reader = XmlReader.Create(text, settings)) { document.Load(reader); }
        return document;
    }
    private static string[] Fields(string name) {
        foreach (QbdReturn ret in Contract.returns) if (ret.name == name) return ret.fields;
        throw new QbdFailure("QB_PARTIAL_VIEW");
    }
    private static void Leaf(XmlWriter writer, string name, string value) { writer.WriteElementString(name, value); }
    internal static string Build(QbdRequest request, string version, string iterator, QbdPlan plan, int accountIndex) {
        StringBuilder text = new StringBuilder();
        XmlWriterSettings settings = new XmlWriterSettings();
        settings.OmitXmlDeclaration = true;
        using (XmlWriter writer = XmlWriter.Create(text, settings)) {
            writer.WriteProcessingInstruction("qbxml", "version=\"" + version + "\"");
            writer.WriteStartElement("QBXML");
            writer.WriteStartElement("QBXMLMsgsRq");
            writer.WriteAttributeString("onError", "stopOnError");
            writer.WriteStartElement(request.request);
            writer.WriteAttributeString("requestID", request.key);
            if (request.iterator) {
                writer.WriteAttributeString("iterator", iterator == null ? "Start" : "Continue");
                if (iterator != null) writer.WriteAttributeString("iteratorID", iterator);
            }
            if (request.mode == "postdated") writer.WriteAttributeString("metaData", "MetaDataOnly");
            if (request.iterator) Leaf(writer, "MaxReturned", "500");
            // Continuation requests retain the same projection. Filters belong
            // only to Start; the server owns the iterator's original selection.
            if (iterator == null) {
                if (request.key == "Account" || request.key == "Customer" || request.key == "Vendor") Leaf(writer, "ActiveStatus", "All");
                if (request.key == "Transaction") {
                    writer.WriteStartElement("TransactionTypeFilter");
                    Leaf(writer, "TxnTypeFilter", "Invoice");
                    writer.WriteEndElement();
                }
                if (request.mode == "postdated") {
                    writer.WriteStartElement("AccountFilter");
                    Leaf(writer, "ListID", plan.accountListIds[accountIndex]);
                    writer.WriteEndElement();
                    writer.WriteStartElement("TransactionDateRangeFilter");
                    Leaf(writer, "FromTxnDate", plan.postdatedFrom);
                    writer.WriteEndElement();
                }
                if (request.mode == "history") {
                    if (request.key == "TxnDeleted" || request.key == "ListDeleted") {
                        string[] types = request.key == "TxnDeleted" ?
                            new string[] { "Invoice", "Bill", "CreditMemo", "BillPaymentCheck", "BillPaymentCreditCard", "ReceivePayment" } :
                            new string[] { "Account", "Customer", "Vendor" };
                        foreach (string type in types) Leaf(writer, request.key == "TxnDeleted" ? "TxnDelType" : "ListDelType", type);
                        writer.WriteStartElement("DeletedDateRangeFilter");
                        Leaf(writer, "FromDeletedDate", plan.historySince);
                    } else {
                        writer.WriteStartElement("ModifiedDateRangeFilter");
                        Leaf(writer, "FromModifiedDate", plan.historySince);
                    }
                    writer.WriteEndElement();
                }
            }
            if (request.key == "Invoice" || request.key == "Bill" || request.key == "CreditMemo") Leaf(writer, "IncludeLineItems", "false");
            if (request.mode != "base" && request.mode != "postdated" && request.key != "TxnDeleted" && request.key != "ListDeleted") {
                HashSet<string> included = new HashSet<string>(StringComparer.Ordinal);
                foreach (string field in Fields(request.ret)) {
                    string top = field.Split('.')[0];
                    if (included.Add(top)) Leaf(writer, "IncludeRetElement", top);
                }
            }
            writer.WriteEndElement(); writer.WriteEndElement(); writer.WriteEndElement();
        }
        return text.ToString();
    }
    private static void Project(XmlElement element, string prefix, HashSet<string> allowed, Dictionary<string, object> result) {
        foreach (XmlNode node in element.ChildNodes) {
            XmlElement child = node as XmlElement;
            if (child == null) continue;
            string path = prefix + child.Name;
            bool nested = false;
            foreach (string field in allowed) if (field.StartsWith(path + ".", StringComparison.Ordinal)) { nested = true; break; }
            if (nested) Project(child, path + ".", allowed, result);
            if (!allowed.Contains(path)) continue;
            foreach (XmlNode descendant in child.ChildNodes) if (descendant is XmlElement) throw new QbdFailure("QB_PARTIAL_VIEW");
            string value = child.InnerText;
            if (value.Length > 4096) throw new QbdFailure("QB_PARTIAL_VIEW");
            if (path == "SupportedQBXMLVersion") {
                if (!result.ContainsKey(path)) result[path] = new List<string>();
                List<string> versions = (List<string>)result[path];
                if (versions.Count >= 64) throw new QbdFailure("QB_PARTIAL_VIEW");
                versions.Add(value);
            } else {
                if (result.ContainsKey(path)) throw new QbdFailure("QB_PARTIAL_VIEW");
                result[path] = value;
            }
        }
    }
    private static XmlElement Response(XmlDocument document, QbdRequest request) {
        XmlElement root = document.DocumentElement;
        if (root == null || root.Name != "QBXML") throw new QbdFailure("QB_PARTIAL_VIEW");
        XmlElement messages = null;
        foreach (XmlNode child in root.ChildNodes) if (child is XmlElement) {
            if (messages != null || child.Name != "QBXMLMsgsRs") throw new QbdFailure("QB_PARTIAL_VIEW");
            messages = (XmlElement)child;
        }
        XmlElement response = null;
        if (messages != null) foreach (XmlNode child in messages.ChildNodes) if (child is XmlElement) {
            if (response != null || child.Name != request.response) throw new QbdFailure("QB_PARTIAL_VIEW");
            response = (XmlElement)child;
        }
        if (response == null || response.GetAttribute("requestID") != request.key ||
            response.GetAttribute("statusCode") != "0" || response.GetAttribute("statusSeverity") != "Info")
            throw new QbdFailure("QB_PARTIAL_VIEW");
        // statusMessage can contain private paths and names. Never read it.
        return response;
    }
    private static string Value(Dictionary<string, object> row, string field) {
        object value;
        return row.TryGetValue(field, out value) ? value as string : null;
    }
    private static void CheckGrant(Dictionary<string, object> row) {
        string automatic = Value(row, "CurrentAppAccessRights.IsAutomaticLoginAllowed");
        string readOnly = Value(row, "CurrentAppAccessRights.IsReadOnly");
        string personal = Value(row, "CurrentAppAccessRights.IsPersonalDataAccessAllowed");
        // FIELD-VERIFY the presence and interpretation of these access rights.
        if (automatic == "true" || readOnly == "false" || personal == "true") throw new QbdFailure("QB_GRANT_TOO_BROAD");
        if (automatic != "false" || readOnly != "true" || personal != "false") throw new QbdFailure("QB_PARTIAL_VIEW");
    }
    private static string HostVersion(Dictionary<string, object> row) {
        object raw;
        if (!row.TryGetValue("SupportedQBXMLVersion", out raw)) throw new QbdFailure("QB_FILE_VERSION");
        List<string> versions = raw as List<string>;
        Version highest = null;
        if (versions != null) foreach (string value in versions) {
            Version version;
            if (!Regex.IsMatch(value, "\\A[0-9]{1,2}\\.[0-9]{1,2}\\z") || !Version.TryParse(value, out version)) throw new QbdFailure("QB_FILE_VERSION");
            if (highest == null || version.CompareTo(highest) > 0) highest = version;
        }
        // FIELD-VERIFY: 13.0 minimum on all supported US 2024 editions.
        if (highest == null || highest.CompareTo(new Version(Contract.minimumVersion)) < 0) throw new QbdFailure("QB_FILE_VERSION");
        return highest.ToString();
    }
    internal static void Execute(IQbdProcessor processor, QbdPlan plan, string operation, Stream output,
        int timeout, bool nativeTimeouts, Func<Func<string>, string> callOverride = null) {
        bool opened = false;
        string ticket = null;
        string version = "1.0";
        List<QbdReceipt> receipts = new List<QbdReceipt>();
        outputBytes = 0;
        Func<Func<string>, string> call = callOverride ?? delegate(Func<string> action) {
            return nativeTimeouts ? Timed(action, timeout, operation == "probe2" ? "QB_GRANT_PROMPTS" : "QB_BUSY") : action();
        };
        try {
            call(delegate { processor.Authorize(); return ""; });
            call(delegate { processor.Open(); opened = true; return ""; });
            // Capture before the timeout wrapper can reject a late return.
            ticket = call(delegate { ticket = processor.Begin(); return ticket; });
            if (String.IsNullOrEmpty(ticket)) throw new QbdFailure("QB_NOT_OPEN");
            foreach (QbdRequest request in Contract.requests) {
                if (operation == "probe2" && request.key != "Host") continue;
                if (operation == "probe" && request.mode != "base") continue;
                int repetitions = request.mode == "postdated" ? plan.accountListIds.Length : 1;
                for (int index = 0; index < repetitions; index++) {
                    QbdReceipt receipt = new QbdReceipt();
                    receipt.id = request.mode == "postdated" ? "Postdated:" + index.ToString(CultureInfo.InvariantCulture) : request.key;
                    string iterator = null;
                    int priorRemaining = Int32.MaxValue;
                    do {
                        if (++receipt.requestCount > 10000) throw new QbdFailure("QB_PARTIAL_VIEW");
                        string xml = Build(request, version, iterator, plan, index);
                        XmlElement response = Response(Parse(call(delegate { return processor.Query(ticket, xml); })), request);
                        int remaining = 0;
                        if (request.iterator && (!Int32.TryParse(response.GetAttribute("iteratorRemainingCount"), NumberStyles.None, CultureInfo.InvariantCulture, out remaining) || remaining < 0 || remaining >= priorRemaining)) throw new QbdFailure("QB_PARTIAL_VIEW");
                        if (!request.iterator && response.HasAttribute("iteratorRemainingCount") && response.GetAttribute("iteratorRemainingCount") != "0") throw new QbdFailure("QB_PARTIAL_VIEW");
                        string next = response.GetAttribute("iteratorID");
                        if (remaining > 0 && (!Regex.IsMatch(next, "\\A\\{[0-9A-Fa-f]{8}-(?:[0-9A-Fa-f]{4}-){3}[0-9A-Fa-f]{12}\\}\\z") || (iterator != null && iterator != next))) throw new QbdFailure("QB_PARTIAL_VIEW");
                        List<Dictionary<string, object>> rows = new List<Dictionary<string, object>>();
                        HashSet<string> allowed = new HashSet<string>(Fields(request.ret), StringComparer.Ordinal);
                        foreach (XmlNode child in response.ChildNodes) {
                            XmlElement ret = child as XmlElement;
                            if (ret == null) continue;
                            if (ret.Name != request.ret || request.mode == "postdated") throw new QbdFailure("QB_PARTIAL_VIEW");
                            Dictionary<string, object> row = new Dictionary<string, object>(StringComparer.Ordinal);
                            Project(ret, "", allowed, row);
                            rows.Add(row);
                        }
                        if (request.iterator && rows.Count > 500) throw new QbdFailure("QB_PARTIAL_VIEW");
                        if (remaining > 0 && rows.Count == 0) throw new QbdFailure("QB_PARTIAL_VIEW");
                        if (request.mode == "base" && rows.Count != 1) throw new QbdFailure("QB_PARTIAL_VIEW");
                        if (request.key == "Host") version = HostVersion(rows[0]);
                        if (request.key == "Preferences") CheckGrant(rows[0]);
                        if (request.key == "Company") {
                            string sample = Value(rows[0], "IsSampleCompanyFile");
                            if (sample == "true") throw new QbdFailure("QB_SAMPLE_COMPANY");
                            if (sample != "false") throw new QbdFailure("QB_PARTIAL_VIEW");
                        }
                        if (request.mode == "postdated") {
                            if (!Int32.TryParse(response.GetAttribute("retCount"), NumberStyles.None, CultureInfo.InvariantCulture, out receipt.matchedCount) || receipt.matchedCount < 0) throw new QbdFailure("QB_PARTIAL_VIEW");
                        } else {
                            // Non-iterator deletion replies are still emitted as
                            // bounded batches. Never truncate a large reply.
                            for (int start = 0; start < Math.Max(1, rows.Count); start += 500) {
                                int count = Math.Min(500, rows.Count - start);
                                Frame(output, new QbdBatch { request = receipt.id, entity = request.ret, rows = rows.GetRange(start, count) });
                            }
                        }
                        receipt.rowCount += rows.Count;
                        receipt.iteratorRemainingCount = remaining;
                        iterator = remaining > 0 ? next : null;
                        priorRemaining = remaining;
                    } while (receipt.iteratorRemainingCount > 0);
                    receipts.Add(receipt);
                }
            }
        } finally {
            // Each cleanup is independent: failed EndSession must still close
            // the connection. No terminal frame is emitted if cleanup fails.
            try { if (ticket != null) call(delegate { processor.End(ticket); return ""; }); }
            finally { if (opened) call(delegate { processor.Close(); return ""; }); }
        }
        Frame(output, new QbdTerminal { requests = receipts });
    }
    private static int Exit(string code) {
        foreach (QbdExit exit in Contract.exits) if (exit.code == code) return exit.value;
        return 21; // QB_PARTIAL_VIEW; shared table is checked before signing.
    }
    [STAThread] private static int Main(string[] args) {
        try {
            int timeout;
            if (args.Length != 2 || (args[0] != "probe" && args[0] != "probe2" && args[0] != "snapshot") ||
                !Int32.TryParse(args[1], NumberStyles.None, CultureInfo.InvariantCulture, out timeout) || timeout < 100 || timeout > 60000)
                return Exit("QB_PARTIAL_VIEW");
            QbdPlan plan = ReadPlan(Console.OpenStandardInput());
            ValidatePlan(plan, args[0], DateTime.Today);
            using (QbdCom processor = new QbdCom()) {
                Execute(processor, plan, args[0], Console.OpenStandardOutput(), timeout, true);
            }
            return 0;
        } catch (QbdFailure error) { return Exit(error.Code); }
        catch { return Exit("QB_PARTIAL_VIEW"); }
    }
}
