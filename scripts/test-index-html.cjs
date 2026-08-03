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
  /rmDb\.collection\s*\(\s*['"]rooms['"]\s*\)/,
  "browser code must not access rooms directly; use roomGateway"
);

assert.match(source, /rmRoomGateway\(\s*['"]getRoom['"]/, "room reads must use roomGateway");
assert.match(
  source,
  /function\s+rmRenderHomeRoomList\s*\(\)\s*\{\s*var\s+refreshToken\s*=\s*\+\+rmHomeRefreshToken;[\s\S]*?if\s*\(refreshToken\s*!==\s*rmHomeRefreshToken\)\s*return;/,
  "home room refreshes must ignore stale gateway responses"
);

assert.doesNotMatch(
  source,
  /闪电分账|\bopenSplit\b|\bviewSplit\b/,
  "removed flash-split feature must not leave UI or routing code behind"
);
assert.match(
  source,
  /\.tool-grid\s*\{[^}]*grid-template-columns\s*:\s*1fr/i,
  "home tools must use the approved single-column layout"
);

const homeMatch = source.match(
  /<div class="view show" id="viewHome">([\s\S]*?)<!--\s*=+\s*VIEW: 行程 tab/
);
assert.ok(homeMatch, "could not isolate the home view");
const home = homeMatch[1];
const homeCards = [...home.matchAll(/<div class="tool-card"[^>]*>/g)];
assert.equal(homeCards.length, 3, "home must contain exactly three tool cards");
assert.deepEqual(
  [...home.matchAll(/<div class="tool-card"[^>]*onclick="([^"]+)"/g)].map((match) => match[1]),
  ["openMidpoint()", "openSpinner()", "openGroupLedger()"],
  "home tool order or click handlers changed"
);
homeCards.forEach((match) => {
  assert.match(match[0], /role="button"/, "tool card is missing button semantics");
  assert.match(match[0], /tabindex="0"/, "tool card is missing keyboard focus");
});
assert.equal(
  (home.match(/class="tool-arrow" aria-hidden="true"/g) || []).length,
  3,
  "each home tool card needs one decorative arrow"
);

console.log(`index.html checks passed (${inlineScripts.length} inline scripts).`);
