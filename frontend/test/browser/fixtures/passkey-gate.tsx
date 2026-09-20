import React from "react";
import { createRoot } from "react-dom/client";
import { Gate } from "../../../src/components/Gate";
import "../../../src/styles.css";

const enrollmentKind = new URLSearchParams(location.search).get("kind") === "document"
  ? "document"
  : "owner";

createRoot(document.getElementById("root")!).render(
  <Gate
    owner="Morgan Example"
    inviteCode={enrollmentKind === "document" ? "doc_synthetic-private-invite" : "synthetic-private-invite"}
    enrollmentKind={enrollmentKind}
    onIn={() => undefined}
  />,
);
