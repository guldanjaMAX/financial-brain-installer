import React from "react";
import { createRoot } from "react-dom/client";
import { FinanceScopeProvider, FinanceScopeBar } from "../../../src/components/FinanceScope";
import { OwnerUpload } from "../../../src/components/OwnerUpload";
import "../../../src/styles.css";

declare global { interface Window { __uploadCompleted: number } }
window.__uploadCompleted = 0;
createRoot(document.getElementById("root")!).render(
  <FinanceScopeProvider>
    <main style={{ padding: 20, maxWidth: 800 }}>
      <FinanceScopeBar />
      <OwnerUpload onStored={() => { window.__uploadCompleted++; }} />
    </main>
  </FinanceScopeProvider>,
);
