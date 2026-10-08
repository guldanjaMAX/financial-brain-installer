let claims = 0, pulls = 0;
let redirectPulls = false;
export default {
  async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname === "/control") return Response.json({ fixture: true });
    if (url.pathname === "/counts") return Response.json({ claims, pulls });
    if (url.pathname === "/redirect-pulls") { redirectPulls = true; return new Response(null); }
    if (url.username || url.password || request.headers.get("Authorization") !==
        `Basic ${btoa("fixture-user:fixture-password")}`) throw new Error("native provider auth refused");
    if (request.method === "POST" && url.pathname === "/redirect") {
      return new Response(null, { status: 302, headers: { Location: "https://redirect.invalid/never" } });
    }
    if (request.method === "POST" && url.pathname === "/claim") {
      claims++;
      const access = new URL("https://provider.invalid/feed");
      access.username = "fixture-user"; access.password = "fixture-password";
      return new Response(access.href);
    }
    if (request.method === "GET" && url.pathname === "/feed/accounts") {
      pulls++;
      if (redirectPulls) return new Response(null, { status: 307, headers: { Location: "https://redirect.invalid/never" } });
      return Response.json({ errlist: [], accounts: [{ id: "fixture-account", name: "Fixture account",
        currency: "USD", balance: "20.00", "balance-date": 1791374400,
        transactions: [{ id: "fixture-transaction", posted: 1728561600, amount: "-1.00" }] }] });
    }
    throw new Error("native provider unexpected request");
  },
};
