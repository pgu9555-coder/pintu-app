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
  /rmRoomGateway\(\s*['"]syncLedger['"]\s*,\s*\{[\s\S]*?membershipEpoch:\s*payloadMembershipEpoch/,
  "shared-ledger writes must carry the epoch captured with the queued payload"
);
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
assert.match(source, /schemaVersion:\s*4[\s\S]*?policy:\s*['"]owner-disband-only['"]/, "new local rooms must carry the persistent-room schema marker");
assert.match(source, /document\.execCommand\(['"]copy['"]\)\s*===\s*true/, "clipboard fallback must verify that copying actually succeeded");
assert.match(source, /function\s+copyRoomCode\s*\(/, "room code copying needs reliable success/failure feedback");

assert.match(source, /var\s+GL_MAX_EXPENSE_CENTS\s*=\s*1000000000000\s*;/, "ledger client cap must match roomGateway's 1e12-cent cap");
assert.match(
  source,
  /function\s+glAmountToCents\s*\(value\)\s*\{[\s\S]*?Number\.isFinite\(amount\)[\s\S]*?amount\s*<=\s*0[\s\S]*?Number\.isSafeInteger\(cents\)[\s\S]*?cents\s*>\s*GL_MAX_EXPENSE_CENTS/,
  "ledger amounts must be finite, positive safe-integer cents within the backend cap"
);
assert.match(source, /function\s+glAddExpense\s*\([\s\S]*?glAmountToCents\(amountEl\.value\)[\s\S]*?glShowInvalidAmount\(amountEl\)/, "new expenses must reject invalid amounts before local insertion");
assert.match(source, /glSaveExpenseEdit[\s\S]*?glAmountToCents\(amountInput\.value\)[\s\S]*?glShowInvalidAmount\(amountInput\)/, "expense edits must reject invalid amounts before saving");
assert.match(source, /function\s+glDeleteMember\(id\)[\s\S]*?trip\.roomDocId\s*&&\s*protectedMember\s*&&\s*protectedMember\.uid/, "shared room members must be protected from web deletion before mutation");
assert.match(source, /function\s+glOpenMemberEditor\(id\)[\s\S]*?trip\.roomDocId\s*&&\s*member\.uid/, "shared room members must be protected from web rename before opening the editor");
assert.match(source, /protectedMember\s*=\s*Boolean\(trip\.roomDocId\s*&&\s*m\.uid\)/, "web member UI must hide destructive controls for true room members");
assert.match(source, /payloadMembershipEpoch[\s\S]*?membershipEpoch:\s*payloadMembershipEpoch/, "a queued web ledger write must retain its original membership epoch");
assert.match(source, /syncBlocked[\s\S]*?remoteNeedsRepair\s*&&\s*!hasPendingSync\s*&&\s*!syncBlocked/, "blocked stale Web ledger writes must not be replayed during cloud hydration");
assert.match(source, /function glQueueCloudSync\(trip, explicitConfirmation\)[\s\S]*?state\.blocked\s*&&\s*!explicitConfirmation/, "only an explicit new Web save may reconfirm a blocked ledger payload");
assert.match(source, /\['INVALID_LEDGER', 'INVALID_REQUEST', 'INVALID_DECISION', 'FORBIDDEN', 'WRONG_ROOM_TYPE', 'ROOM_TYPE_MISMATCH', 'CONTENT_REJECTED', 'STALE_MEMBERSHIP'\]/, "non-retryable web ledger conflicts must stop automatic retries");
assert.match(source, /function\s+glPersistTrips\(\)[\s\S]*?本机保存失败，本次未同步/, "web local-storage failures must be visible and must not claim a sync");

assert.match(source, /inputEl\.dataset\.locationGeneration\s*=\s*String\(Number\(inputEl\.dataset\.locationGeneration\s*\|\|\s*0\)\s*\+\s*1\)/, "typing or selecting an address must advance the location generation");
assert.match(source, /function\s+geolocateMe\s*\(inputEl\)\s*\{[\s\S]*?var\s+locationGeneration\s*=[\s\S]*?getCurrentPosition\(function\(status, result\)\{[\s\S]*?locationGeneration\)\s*return;[\s\S]*?reverseGeocodePosition[\s\S]*?locationGeneration\)\s*return;/, "stale geolocation and reverse-geocode callbacks must not overwrite a newer address");
assert.match(source, /const\s+selectTip\s*=\s*\(e\)\s*=>\s*\{[\s\S]*?clearTimeout\(timer\);[\s\S]*?requestId\s*\+=\s*1;[\s\S]*?boxEl\.style\.display\s*=\s*['"]none['"]/, "selecting an address must cancel pending autocomplete responses");
assert.match(source, /inputEl\.addEventListener\(['"]input['"][\s\S]*?boxEl\.style\.display\s*=\s*['"]none['"][\s\S]*?searchAddress\(inputEl\.value\.trim\(\),\s*350\)/, "typing a new query must hide cached suggestions until matching results arrive");

assert.match(source, /var\s+swipeTransitionBusy\s*=\s*false\s*;/, "swipe flow needs a transition busy state");
assert.match(source, /function\s+swipeAction\s*\(dir\)\s*\{\s*if\s*\(swipeTransitionBusy\s*\|\|\s*swipeIndex\s*>=\s*swipeDeck\.length\)\s*return;/, "rapid swipe button taps must be ignored while a card exits");
assert.match(source, /function\s+flyOutCardEl\s*\(card, dir\)\s*\{\s*if\s*\(swipeTransitionBusy\s*\|\|\s*!card\s*\|\|\s*card\.dataset\.swipeExiting\s*===\s*['"]true['"]\)\s*return;[\s\S]*?swipeTransitionBusy\s*=\s*false;[\s\S]*?renderSwipeStack\(\);/, "swipe flow must unlock only after its exit animation completes");
assert.match(source, /function\s+openFoodSwipe\s*\([\s\S]*?resetSwipeTransition\(\);[\s\S]*?function\s+restartFoodSwipe\s*\([\s\S]*?resetSwipeTransition\(\);/, "re-entering or restarting the swipe deck must reset transition state");

assert.match(source, /function\s+rmEnsureTcbReady\s*\(\)[\s\S]*?rmGatewayTimeout\(loginRequest,\s*30000,\s*['"]CloudBase 登录['"]\)/, "CloudBase authentication must time out instead of leaving room controls busy forever");
assert.match(source, /rmTcbError\s*=\s*null;[\s\S]*?rmBackendStatus\s*=\s*\{\s*state:\s*['"]starting['"]/, "a later room action must be able to start a fresh CloudBase login attempt");
assert.match(source, /function\s+createTyped\s*\([\s\S]*?rmEnsureTcbReady\(\)\.then/, "typed room creation must use retryable bounded backend initialization");
assert.match(source, /function\s+findAnyTypedRoom\s*\([\s\S]*?rmEnsureTcbReady\(\)\.then/, "universal room join must use retryable bounded backend initialization");
assert.doesNotMatch(source, /a\.amap\.com\/jsapi_demos/, "map markers must not depend on the unreliable AMap demo-assets host");

console.log(`index.html checks passed (${inlineScripts.length} inline scripts).`);
