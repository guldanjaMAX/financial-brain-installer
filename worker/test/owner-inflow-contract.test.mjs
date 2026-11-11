// Keep the original 1,200-case finder available; this gate runs all 120
// money-in cases without importing its unrelated historical repair trial.
process.env.OWNER_INFLOW_CONTRACT = '1';
await import('./owner-ten-shapes-generated.test.mjs');
