import React from "react";
import { createRoot } from "react-dom/client";
import { FinancialMap } from "../../../src/components/FinancialMap";
import "../../../src/styles.css";

createRoot(document.getElementById("root")!).render(
  <main className="px-4 py-8 sm:px-6"><FinancialMap /></main>,
);
