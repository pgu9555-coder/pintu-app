const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const htmlPath = path.join(__dirname, "..", "index.html");
const source = fs.readFileSync(htmlPath, "utf8");

assert.doesNotMatch(source, /^(<<<<<<<|=======|>>>>>>>)/m, "index.html contains unresolved merge markers");

/* Strip HTML comments first because the setup note intentionally contains a literal
   <script ...> example that is not an executable script element. */
const withoutComments = source.replace(/<!--[\s\S]*?-->/g, "");
const inlineScripts = [...withoutComments.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/gi)]
  .map((match) => match[1])
  .filter((script) => script.trim());

assert.ok(inlineScripts.length >= 1, "index.html has no inline scripts");
inlineScripts.forEach((script, index) => {
  try {
    new Function(script);
  } catch (error) {
    throw new Error(`inline script ${index + 1} failed to parse: ${error.message}`);
  }
});

assert.doesNotMatch(
  source,
  /rmMemberRoomQuery\([^)]*\)\.update\s*\(/,
  "browser code must not update rooms directly; use roomGateway"
);

console.log(`index.html checks passed (${inlineScripts.length} inline scripts).`);
