// Compiled only by the Windows workflow, never embedded in the signed helper.
using System;
using System.Collections.Generic;
using System.IO;
using System.Runtime.Serialization.Json;
using System.Text;
using System.Xml;

internal sealed class QbdStub : IQbdProcessor {
    internal readonly List<string> Calls = new List<string>();
    internal readonly List<string> Requests = new List<string>();
    internal readonly Dictionary<string, string> Rows = new Dictionary<string, string>();
    internal string Failure;
    internal int Queries;
    internal int AccountPages = 2;
    internal int AccountsPerPage = 1;
    private int accountPage;
    public void Authorize() { Calls.Add("authorize"); }
    public void Open() { Calls.Add("open"); }
    public string Begin() { Calls.Add("begin"); return "synthetic-session"; }
    public void End(string ticket) { Calls.Add("end"); if (Failure == "end") throw new QbdFailure("QB_BUSY"); }
    public void Close() { Calls.Add("close"); }
    public string Query(string ticket, string xml) {
        Queries++;
        Requests.Add(xml);
        XmlDocument request = QbdHelper.Parse(xml);
        XmlElement element = (XmlElement)request.DocumentElement.FirstChild.FirstChild;
        string key = element.GetAttribute("requestID");
        Calls.Add(key);
        if (!element.Name.EndsWith("QueryRq", StringComparison.Ordinal)) throw new Exception("write request");
        if (Failure == "query") throw new QbdFailure("QB_BUSY");
        string rows = "";
        string attributes = "";
        if (key == "Host") rows = "<HostRet><ProductName>QuickBooks Pro</ProductName><Country>US</Country><SupportedQBXMLVersion>" + (Failure == "version" ? "12.0" : "16.0") + "</SupportedQBXMLVersion></HostRet>";
        if (key == "Company") rows = "<CompanyRet><CompanyName>Synthetic Store</CompanyName><IsSampleCompanyFile>false</IsSampleCompanyFile></CompanyRet>";
        if (key == "Preferences") rows = "<PreferencesRet><CurrentAppAccessRights><IsReadOnly>true</IsReadOnly><IsAutomaticLoginAllowed>" + (Failure == "grant" ? "true" : "false") + "</IsAutomaticLoginAllowed><IsPersonalDataAccessAllowed>false</IsPersonalDataAccessAllowed></CurrentAppAccessRights></PreferencesRet>";
        if (key == "Account") {
            accountPage++;
            StringBuilder accounts = new StringBuilder();
            for (int i = 0; i < AccountsPerPage; i++) {
                int id = Failure == "identity-duplicate" ? 12 : 12 + (accountPage - 1) * AccountsPerPage + i;
                accounts.Append("<AccountRet><ListID>AA-" + id + "</ListID>");
                if (Failure != "identity-missing") accounts.Append("<TimeCreated>2020-01-01T00:00:00-07:00</TimeCreated>");
                accounts.Append("<Name>Synthetic Bank</Name><Balance>12.34</Balance><BankNumber>SENTINEL_BANK</BankNumber><AccountNumber>SENTINEL_ACCOUNT</AccountNumber><Notes>SENTINEL_NOTES</Notes><Desc>SENTINEL_DESC</Desc><CreditCardInfo>SENTINEL_CARD</CreditCardInfo><SSN>SENTINEL_SSN</SSN><VendorTaxIdent>SENTINEL_EIN</VendorTaxIdent></AccountRet>");
            }
            rows = accounts.ToString();
        }
        if (Rows.ContainsKey(key)) rows = Rows[key];
        if (element.HasAttribute("iterator")) attributes = " iteratorRemainingCount=\"" + (key == "Account" ? Math.Max(0, AccountPages - accountPage) * AccountsPerPage : 0) + "\" iteratorID=\"{01234567-89AB-CDEF-0123-456789ABCDEF}\"";
        if (key == "Postdated") attributes = " retCount=\"3\"";
        string severity = Failure == "warn" ? "Warn" : "Info";
        return "<QBXML><QBXMLMsgsRs><" + element.Name.Replace("Rq", "Rs") + " requestID=\"" + key + "\" statusCode=\"0\" statusSeverity=\"" + severity + "\" statusMessage=\"SENTINEL_RECORD C:\\SENTINEL_COMPANY\\data.qbw\"" + attributes + ">" + rows + "</" + element.Name.Replace("Rq", "Rs") + "></QBXMLMsgsRs></QBXML>";
    }
}
internal sealed class QbdBrokenPipe : MemoryStream {
    public override void Write(byte[] bytes, int offset, int count) { throw new IOException("synthetic closed pipe"); }
}
internal static class QbdHelperTests {
    private static int assertions;
    private static void Check(bool value) { assertions++; if (!value) throw new Exception("QBD_STUB_CHECK_FAILED"); }
    private static QbdPlan Plan(string operation) {
        return new QbdPlan { historySince = operation == "snapshot" ? "2024-10-07T00:00:00Z" : "",
            postdatedFrom = operation == "snapshot" ? "2026-10-08" : "",
            accountListIds = operation == "snapshot" ? new string[] { "AA-12" } : new string[0], storedTxnIds = new string[0] };
    }
    private static string Text(MemoryStream stream) { return Encoding.UTF8.GetString(stream.ToArray()); }
    private static List<XmlDocument> Frames(MemoryStream stream) {
        byte[] bytes = stream.ToArray();
        List<XmlDocument> frames = new List<XmlDocument>();
        for (int offset = 0; offset < bytes.Length;) {
            Check(offset + 4 <= bytes.Length);
            int length = (bytes[offset] << 24) | (bytes[offset + 1] << 16) | (bytes[offset + 2] << 8) | bytes[offset + 3];
            offset += 4;
            Check(length >= 2 && length <= 2 * 1024 * 1024 && offset + length <= bytes.Length);
            byte[] frame = new byte[length];
            Array.Copy(bytes, offset, frame, 0, length);
            offset += length;
            // Read the actual wire JSON independently of its DataContract types.
            using (XmlDictionaryReader reader = JsonReaderWriterFactory.CreateJsonReader(frame, XmlDictionaryReaderQuotas.Max)) {
                XmlDocument document = new XmlDocument();
                document.XmlResolver = null;
                document.Load(reader);
                frames.Add(document);
            }
        }
        Check(frames.Count > 0);
        return frames;
    }
    private static List<XmlElement> Returned(MemoryStream stream, string entity) {
        List<XmlElement> rows = new List<XmlElement>();
        foreach (XmlDocument frame in Frames(stream)) {
            XmlElement root = frame.DocumentElement;
            if (root["entity"] == null || root["entity"].InnerText != entity) continue;
            foreach (XmlNode row in root["rows"].ChildNodes) if (row is XmlElement) rows.Add((XmlElement)row);
        }
        return rows;
    }
    private static void IdentityContract() {
        foreach (int pages in new int[] { 2, 20 }) {
            QbdStub control = new QbdStub { AccountPages = pages, AccountsPerPage = pages == 20 ? 500 : 1 };
            using (MemoryStream output = new MemoryStream()) {
                QbdHelper.Execute(control, Plan("probe"), "probe", output, 100, false);
                Check(Text(output).Contains("terminal"));
                List<XmlElement> rows = Returned(output, "AccountRet");
                Check(rows.Count == pages * control.AccountsPerPage);
                foreach (XmlElement row in rows) {
                    Check(row.ChildNodes.Count == 2);
                    Check(row["ListID"] != null && row["TimeCreated"] != null);
                }
                int accountReads = 0;
                foreach (string xml in control.Requests) {
                    XmlElement request = (XmlElement)QbdHelper.Parse(xml).DocumentElement.FirstChild.FirstChild;
                    if (request.GetAttribute("requestID") != "Account") continue;
                    accountReads++;
                    Check(request["MaxReturned"].InnerText == "500");
                    XmlNodeList fields = request.SelectNodes("IncludeRetElement");
                    Check(fields.Count == 2 && fields[0].InnerText == "ListID" && fields[1].InnerText == "TimeCreated");
                }
                Check(accountReads == pages);
            }
        }
        foreach (string failure in new string[] { "identity-empty", "identity-missing", "identity-duplicate", "identity-overflow" }) {
            QbdStub stub = new QbdStub { Failure = failure };
            if (failure == "identity-empty") { stub.AccountPages = 1; stub.AccountsPerPage = 0; }
            if (failure == "identity-overflow") { stub.AccountPages = 21; stub.AccountsPerPage = 500; }
            using (MemoryStream output = new MemoryStream()) {
                bool refused = false;
                try { QbdHelper.Execute(stub, Plan("probe"), "probe", output, 100, false); }
                catch (QbdFailure error) { refused = error.Code == "QB_PARTIAL_VIEW"; }
                Check(refused && stub.Calls.Contains("Account"));
                Check(!Text(output).Contains("terminal"));
                Check(stub.Calls[stub.Calls.Count - 2] == "end" && stub.Calls[stub.Calls.Count - 1] == "close");
            }
        }
    }
    private static void AccountingContract() {
        string[] keys = new string[] { "Customer", "Invoice", "Bill", "CreditMemo", "Transaction" };
        string[] xmlFields = new string[] {
            "<Sublevel>0</Sublevel>",
            "<IsPending>false</IsPending><CustomerRef><FullName>Customer One</FullName></CustomerRef><TermsRef><FullName>Net 30</FullName></TermsRef>",
            "<OpenAmount>25.00</OpenAmount><IsPending>false</IsPending><VendorRef><FullName>Vendor One</FullName></VendorRef>",
            "<TotalAmount>75.00</TotalAmount><IsPending>false</IsPending><CustomerRef><FullName>Customer One</FullName></CustomerRef>",
            "<CurrencyRef><ListID>FF-17</ListID></CurrencyRef>"
        };
        string[][] fields = new string[][] {
            new string[] { "Sublevel" }, new string[] { "IsPending", "CustomerRef.FullName", "TermsRef.FullName" },
            new string[] { "OpenAmount", "IsPending", "VendorRef.FullName" },
            new string[] { "TotalAmount", "IsPending", "CustomerRef.FullName" }, new string[] { "CurrencyRef.ListID" }
        };
        string[][] values = new string[][] {
            new string[] { "0" }, new string[] { "false", "Customer One", "Net 30" }, new string[] { "25.00", "false", "Vendor One" },
            new string[] { "75.00", "false", "Customer One" }, new string[] { "FF-17" }
        };
        QbdStub stub = new QbdStub();
        for (int i = 0; i < keys.Length; i++) stub.Rows[keys[i]] = "<" + keys[i] + "Ret>" + xmlFields[i] + "</" + keys[i] + "Ret>";
        using (MemoryStream output = new MemoryStream()) {
            QbdHelper.Execute(stub, Plan("snapshot"), "snapshot", output, 100, false);
            Check(Text(output).Contains("terminal"));
            for (int i = 0; i < keys.Length; i++) {
                List<XmlElement> rows = Returned(output, keys[i] + "Ret");
                Check(rows.Count == 1);
                for (int field = 0; field < fields[i].Length; field++) Check(rows[0][fields[i][field]].InnerText == values[i][field]);
                bool reached = false;
                foreach (string xml in stub.Requests) {
                    XmlElement request = (XmlElement)QbdHelper.Parse(xml).DocumentElement.FirstChild.FirstChild;
                    if (request.GetAttribute("requestID") != keys[i]) continue;
                    reached = true;
                    foreach (string field in fields[i]) Check(request.SelectSingleNode("IncludeRetElement[text()='" + field.Split('.')[0] + "']") != null);
                }
                Check(reached);
            }
        }
    }
    private static void LinkContract() {
        string valid = "<TxnID>DD-15</TxnID><TxnType>Bill</TxnType><Amount>75.00</Amount>";
        string privateFields = "<SSN>SENTINEL_SSN</SSN><VendorTaxIdent>SENTINEL_EIN</VendorTaxIdent><BankNumber>SENTINEL_BANK</BankNumber><AccountNumber>SENTINEL_ACCOUNT</AccountNumber><CreditCardInfo><Number>SENTINEL_CARD</Number></CreditCardInfo><Notes>SENTINEL_NOTES</Notes><Desc>SENTINEL_DESC</Desc><Unknown><TxnID>SENTINEL_NESTED</TxnID></Unknown>";
        foreach (string key in new string[] { "BillPaymentCheck", "BillPaymentCreditCard" }) {
            string account = key == "BillPaymentCheck" ? "BankAccountRef" : "CreditCardAccountRef";
            string labels = "<PayeeEntityRef><FullName>Vendor One</FullName></PayeeEntityRef><" + account + "><FullName>Payment Account</FullName></" + account + ">";
            foreach (int count in new int[] { 2, 500 }) {
                StringBuilder links = new StringBuilder();
                for (int i = 0; i < count; i++) links.Append("<AppliedToTxnRet>" + valid.Replace("DD-15", "DD-" + i) + privateFields + "</AppliedToTxnRet>");
                QbdStub stub = new QbdStub();
                stub.Rows[key] = "<" + key + "Ret>" + labels + links + "</" + key + "Ret>";
                using (MemoryStream output = new MemoryStream()) {
                    QbdHelper.Execute(stub, Plan("snapshot"), "snapshot", output, 100, false);
                    Check(Text(output).Contains("terminal") && !Text(output).Contains("SENTINEL"));
                    List<XmlElement> rows = Returned(output, key + "Ret");
                    Check(rows.Count == 1);
                    Check(rows[0]["PayeeEntityRef.FullName"].InnerText == "Vendor One");
                    Check(rows[0][account + ".FullName"].InnerText == "Payment Account");
                    XmlElement projected = rows[0]["AppliedToTxnRet"];
                    Check(projected.GetAttribute("type") == "array" && projected.ChildNodes.Count == count);
                    for (int i = 0; i < count; i++) {
                        XmlElement item = (XmlElement)projected.ChildNodes[i];
                        Check(item.GetAttribute("type") == "object" && item.ChildNodes.Count == 3);
                        Check(item["TxnID"].InnerText == "DD-" + i && item["TxnType"].InnerText == "Bill" && item["Amount"].InnerText == "75.00");
                    }
                    bool reached = false;
                    foreach (string xml in stub.Requests) {
                        XmlElement request = (XmlElement)QbdHelper.Parse(xml).DocumentElement.FirstChild.FirstChild;
                        if (request.GetAttribute("requestID") != key) continue;
                        reached = true;
                        foreach (string field in new string[] { "AppliedToTxnRet", "PayeeEntityRef", account }) Check(request.SelectSingleNode("IncludeRetElement[text()='" + field + "']") != null);
                    }
                    Check(reached);
                }
            }
            foreach (string invalid in new string[] { "", valid.Replace("<Amount>75.00</Amount>", ""),
                valid + "<TxnID>DD-16</TxnID>", valid.Replace("DD-15", "dd-15"),
                valid.Replace("75.00", new string('x', 4097)), valid.Replace("75.00", "<Notes>SENTINEL_NESTED</Notes>"), "overflow" }) {
                StringBuilder links = new StringBuilder();
                int count = invalid == "overflow" ? 501 : 1;
                for (int i = 0; i < count; i++) links.Append("<AppliedToTxnRet>" + (invalid == "overflow" ? valid : invalid) + "</AppliedToTxnRet>");
                QbdStub stub = new QbdStub();
                stub.Rows[key] = "<" + key + "Ret>" + links + "</" + key + "Ret>";
                using (MemoryStream output = new MemoryStream()) {
                    bool refused = false;
                    try { QbdHelper.Execute(stub, Plan("snapshot"), "snapshot", output, 100, false); }
                    catch (QbdFailure error) { refused = error.Code == "QB_PARTIAL_VIEW"; }
                    Check(refused && stub.Calls.Contains(key));
                    Check(!Text(output).Contains("terminal") && !Text(output).Contains("SENTINEL"));
                    Check(stub.Calls[stub.Calls.Count - 2] == "end" && stub.Calls[stub.Calls.Count - 1] == "close");
                }
            }
        }
    }
    public static int Main() {
        try {
            foreach (string operation in new string[] { "probe", "probe2", "snapshot" }) {
                QbdStub stub = new QbdStub();
                using (MemoryStream output = new MemoryStream()) {
                    QbdHelper.ValidatePlan(Plan(operation), operation, new DateTime(2026, 10, 7));
                    QbdHelper.Execute(stub, Plan(operation), operation, output, 100, false);
                    Check(Text(output).Contains("terminal"));
                    Check(!Text(output).Contains("SENTINEL"));
                    // Probe drains both identity pages in the same session.
                    Check(stub.Queries == (operation == "probe" ? 5 : operation == "probe2" ? 1 : 18));
                    Check(stub.Calls[0] == "authorize" && stub.Calls[1] == "open" && stub.Calls[2] == "begin");
                    Check(stub.Calls[stub.Calls.Count - 2] == "end" && stub.Calls[stub.Calls.Count - 1] == "close");
                }
            }
            foreach (string failure in new string[] { "query", "warn", "version", "grant", "end" }) {
                QbdStub stub = new QbdStub { Failure = failure };
                bool refused = false;
                using (MemoryStream output = new MemoryStream()) {
                    try { QbdHelper.Execute(stub, Plan("snapshot"), "snapshot", output, 100, false); }
                    catch (QbdFailure) { refused = true; }
                    Check(refused && stub.Queries > 0);
                    Check(!Text(output).Contains("terminal"));
                    Check(!Text(output).Contains("SENTINEL"));
                    Check(stub.Calls[stub.Calls.Count - 2] == "end" && stub.Calls[stub.Calls.Count - 1] == "close");
                }
            }
            QbdStub broken = new QbdStub();
            QbdStub late = new QbdStub();
            bool lateRefused = false;
            int calls = 0;
            using (MemoryStream output = new MemoryStream()) {
                try {
                    QbdHelper.Execute(late, Plan("probe"), "probe", output, 100, false, delegate(Func<string> action) {
                        string result = action();
                        if (++calls == 3) throw new QbdFailure("QB_BUSY");
                        return result;
                    });
                } catch (QbdFailure) { lateRefused = true; }
                Check(lateRefused && calls == 5 && late.Queries == 0);
                Check(late.Calls[late.Calls.Count - 2] == "end" && late.Calls[late.Calls.Count - 1] == "close");
                Check(!Text(output).Contains("terminal"));
            }
            bool brokenRefused = false;
            using (QbdBrokenPipe output = new QbdBrokenPipe()) {
                try { QbdHelper.Execute(broken, Plan("probe"), "probe", output, 100, false); }
                catch (IOException) { brokenRefused = true; }
                Check(brokenRefused && broken.Queries == 1);
                Check(broken.Calls[broken.Calls.Count - 2] == "end" && broken.Calls[broken.Calls.Count - 1] == "close");
            }
            string[] badXml = new string[] { "<!DOCTYPE x [<!ENTITY x 'unsafe'>]><x>&x;</x>", new string(' ', 8 * 1024 * 1024 + 1), "<x xmlns='unexpected'/>" };
            foreach (string invalidId in new string[] { "AA-12\n", " AA-12", "AA-12 ", "aa-12" }) {
                QbdPlan invalid = Plan("snapshot");
                invalid.accountListIds = new string[] { invalidId };
                bool refused = false;
                try { QbdHelper.ValidatePlan(invalid, "snapshot", new DateTime(2026, 10, 7)); }
                catch (QbdFailure) { refused = true; }
                Check(refused);
            }
            Check(QbdHelper.Parse("<QBXML/>").DocumentElement.Name == "QBXML");
            foreach (string xml in badXml) {
                bool refused = false;
                try { QbdHelper.Parse(xml); } catch { refused = true; }
                Check(refused);
            }
            foreach (QbdRequest request in QbdHelper.Contract.requests) {
                string xml = QbdHelper.Build(request, "16.0", null, Plan("snapshot"), 0);
                XmlElement element = (XmlElement)QbdHelper.Parse(xml).DocumentElement.FirstChild.FirstChild;
                Check(element.Name == request.request && element.Name.EndsWith("QueryRq", StringComparison.Ordinal));
                if (request.iterator) Check(element["MaxReturned"].InnerText == "500");
                if (request.key == "Account" || request.key == "Customer") Check(element["ActiveStatus"].InnerText == "All");
                if (request.key == "Invoice" || request.key == "Bill" || request.key == "CreditMemo") Check(element["IncludeLineItems"].InnerText == "false");
            }
            IdentityContract();
            AccountingContract();
            LinkContract();
            Console.WriteLine("QBD_STUB_ASSERTIONS=" + assertions);
            return 0;
        } catch { Console.Error.WriteLine("QBD_STUB_CHECK_FAILED"); return 1; }
    }
}
