import {
  askForTesting,
  closePromptsForTesting,
  openPromptsForTesting,
  readHiddenCloudflareToken,
} from "../../brain.mjs";

const SYNTHETIC_KEY = "K7" + "q".repeat(36) + "Z9";
openPromptsForTesting();
const first = await askForTesting("Use recovery access? (y/n)", "n");
const hidden = await readHiddenCloudflareToken();
const hiddenMatched = hidden.toString("ascii") === SYNTHETIC_KEY;
hidden.fill(0);
const second = await askForTesting("Continue? (y/n)", "y");
closePromptsForTesting();
process.stdout.write(`PTY_RESULT ${JSON.stringify({ first, hiddenMatched, second })}\n`);
