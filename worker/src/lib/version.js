/**
 * The version of THIS worker source, shipped with the code rather than supplied
 * to it.
 *
 * Health used to report `env.BRAIN_VERSION`, a plain-text variable written at
 * deploy time. A variable can outlive the code it described: deploy metadata
 * carries keep_bindings, so bindings survive an upload, and any path that
 * writes vars without uploading the script leaves the two describing different
 * things. On a client brain that drift went unnoticed for months, with health
 * reporting one version while the deployed worker was two releases behind, and
 * nobody could have known because the only number on offer was the wrong one.
 *
 * A constant in the source cannot drift from the source. Health reports this,
 * and says so when the deploy-time variable disagrees.
 */
export const WORKER_VERSION = "0.4.5";
