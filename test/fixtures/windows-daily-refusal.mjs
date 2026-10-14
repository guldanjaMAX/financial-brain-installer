// Drive the real public CLI failure renderer with the bridge's actual refusal.
import { createWindowsUpdateBridgeGuard } from "../../operations/windows-update-bridge.mjs";
const originalLog = console.log.bind(console);
console.log = (...args) => {
  console.log = originalLog;
  const guard = createWindowsUpdateBridgeGuard({
    domain: "fixture.invalid", manifestPath: "C:\\Fixture\\brain.manifest.json",
    adapter: { currentSid: () => "S-1-5-21-101-202-303-1001" },
  });
  guard.capture({ entries: [{ task_name: "\\Financial Brain\\daily-refresh-0123456789abcdef", action: "opaque fixture" }] });
  return originalLog(...args);
};
