import React from "react";
import { createRoot } from "react-dom/client";
import { DocumentAccess } from "../../../src/components/DocumentAccess";
import { FinanceScopeProvider } from "../../../src/components/FinanceScope";
import "../../../src/styles.css";

createRoot(document.getElementById("root")!).render(
  <FinanceScopeProvider>
    <main className="max-w-4xl mx-auto px-5 py-8">
      <DocumentAccess />
    </main>
  </FinanceScopeProvider>,
);
