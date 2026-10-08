// Compiled only by the Windows workflow, never embedded in the signed helper.
using System;
using System.Collections.Generic;
using System.IO;
using System.Text;
using System.Xml;

internal sealed class QbdStub : IQbdProcessor {
    internal readonly List<string> Calls = new List<string>();
    internal string Failure;
    internal int Queries;
    private int accountPage;
    public void Authorize() { Calls.Add("authorize"); }
    public void Open() { Calls.Add("open"); }
    public string Begin() { Calls.Add("begin"); return "synthetic-session"; }
    public void End(string ticket) { Calls.Add("end"); if (Failure == "end") throw new QbdFailure("QB_BUSY"); }
    public void Close() { Calls.Add("close"); }
    public string Query(string ticket, string xml) {
        Queries++;
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
            rows = "<AccountRet><ListID>AA-12</ListID><Name>Synthetic Bank</Name><Balance>12.34</Balance><BankNumber>SENTINEL_BANK</BankNumber><AccountNumber>SENTINEL_ACCOUNT</AccountNumber><Notes>SENTINEL_NOTES</Notes><Desc>SENTINEL_DESC</Desc><CreditCardInfo>SENTINEL_CARD</CreditCardInfo><SSN>SENTINEL_SSN</SSN><VendorTaxIdent>SENTINEL_EIN</VendorTaxIdent></AccountRet>";
        }
        if (element.HasAttribute("iterator")) attributes = " iteratorRemainingCount=\"" + (key == "Account" && accountPage == 1 ? "1" : "0") + "\" iteratorID=\"{01234567-89AB-CDEF-0123-456789ABCDEF}\"";
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
    public static int Main() {
        try {
            foreach (string operation in new string[] { "probe", "probe2", "snapshot" }) {
                QbdStub stub = new QbdStub();
                using (MemoryStream output = new MemoryStream()) {
                    QbdHelper.ValidatePlan(Plan(operation), operation, new DateTime(2026, 10, 7));
                    QbdHelper.Execute(stub, Plan(operation), operation, output, 100, false);
                    Check(Text(output).Contains("terminal"));
                    Check(!Text(output).Contains("SENTINEL"));
                    Check(stub.Queries == (operation == "probe" ? 3 : operation == "probe2" ? 1 : 18));
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
            Console.WriteLine("QBD_STUB_ASSERTIONS=" + assertions);
            return 0;
        } catch { Console.Error.WriteLine("QBD_STUB_CHECK_FAILED"); return 1; }
    }
}
