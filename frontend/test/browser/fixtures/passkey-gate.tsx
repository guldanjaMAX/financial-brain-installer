import React from "react";
import { createRoot } from "react-dom/client";
import { Gate } from "../../../src/components/Gate";
import "../../../src/styles.css";

createRoot(document.getElementById("root")!).render(
  <Gate
    owner="Morgan Example"
    inviteCode="synthetic-private-invite"
    onIn={() => undefined}
  />,
);
