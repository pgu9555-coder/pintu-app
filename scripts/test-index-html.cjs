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
assert.match(source, /mpDecisionWrite\([^)]*['"]publishDecisionCandidates['"]/, "shared decision candidates must use the guarded decision writer");
assert.match(source, /mpDecisionWrite\([^)]*['"]setDecisionVote['"]/, "shared decision votes must use the guarded decision writer");
assert.match(source, /mpDecisionWrite\([^)]*['"]confirmDecisionCandidate['"]/, "shared decision confirmation must use the guarded decision writer");
assert.match(
  source,
  /room\.meetup\s*=\s*Object\.assign\(\{\},\s*room\.meetup\s*\|\|\s*\{\},\s*\{\s*people:\s*people\s*\}\)/,
  "updating a meetup point must preserve the current shared decision"
);
assert.match(
  source,
  /if\s*\(result\s*&&\s*result\.meetup\)\s*\{[\s\S]*?currentDecision[\s\S]*?incomingDecision\.revision[\s\S]*?room\.meetup\s*=\s*nextMeetup/,
  "meetup writes must reconcile the server meetup response"
);
assert.match(source, /incomingRevision\s*<\s*currentRevision/, "late shared-decision responses must not overwrite newer UI state");
assert.match(source, /https:\/\/uri\.amap\.com\/navigation\?to=/, "confirmed destinations must open AMap navigation");
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

for (const id of ["homeJoinName", "homeJoinCode", "homeJoinRoomBtn", "homeJoinError"]) {
  assert.match(home, new RegExp(`id=["']${id}["']`), `home universal join is missing #${id}`);
}
assert.match(
  source,
  /rmRoomGateway\(\s*['"]join['"]\s*,\s*\{\s*code:\s*code,\s*type:\s*['"]auto['"],\s*name:\s*name\s*\}/,
  "home universal join must ask the gateway to auto-detect room type"
);
assert.match(
  source,
  /rmEnterTypedRoom\(found\.docId,\s*type\)/,
  "home universal join must route using the server-returned room type"
);
assert.match(home, /tool-icon ledger[\s\S]*?ti-receipt-2/, "the ledger home card needs its own receipt icon");
assert.match(source, /card\.dataset\.roomType\s*=\s*room\.toolType/, "room cards must expose their type for icon styling");
assert.match(source, /room\.toolType\s*===\s*['"]midpoint['"]\s*\?\s*['"]map-pin-share['"][\s\S]*?['"]receipt-2['"]/, "midpoint and ledger cards need distinct icons");
assert.match(source, /schemaVersion:\s*3[\s\S]*?policy:\s*['"]owner-disband-only['"]/, "new local rooms must carry the persistent-room schema marker");
assert.match(source, /document\.execCommand\(['"]copy['"]\)\s*===\s*true/, "clipboard fallback must verify that copying actually succeeded");
assert.match(source, /function\s+copyRoomCode\s*\(/, "room code copying needs reliable success/failure feedback");

console.log(`index.html checks passed (${inlineScripts.length} inline scripts).`);
