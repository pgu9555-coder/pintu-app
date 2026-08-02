const cloudbase = require("@cloudbase/node-sdk");

const envId = process.env.CLOUDBASE_ENV_ID || "pintu-d4g77ecn24b674fa0";
const secretId = process.env.TCB_SECRET_ID;
const secretKey = process.env.TCB_SECRET_KEY;

if (!secretId || !secretKey) {
  throw new Error("Missing TCB_SECRET_ID or TCB_SECRET_KEY.");
}

const app = cloudbase.init({ env: envId, secretId, secretKey });
const db = app.database();
const rooms = db.collection("rooms");

function nestedMembers(room) {
  const values = [];
  if (Array.isArray(room.members)) values.push(...room.members);
  if (room.ledger && Array.isArray(room.ledger.members)) values.push(...room.ledger.members);
  if (room.meetup && Array.isArray(room.meetup.people)) values.push(...room.meetup.people);
  return values.filter((member) => member && typeof member.uid === "string" && member.uid.length > 0);
}

function ownerUidFor(room) {
  if (typeof room.ownerUid === "string" && room.ownerUid.length > 0) return room.ownerUid;
  const firstIdentifiedMember = nestedMembers(room)[0];
  return firstIdentifiedMember ? firstIdentifiedMember.uid : null;
}

function memberUidsFor(room, ownerUid) {
  const values = [];
  if (Array.isArray(room.memberUids)) values.push(...room.memberUids);
  if (ownerUid) values.push(ownerUid);
  nestedMembers(room).forEach((member) => values.push(member.uid));
  return [...new Set(values.filter((uid) => typeof uid === "string" && uid.length > 0))];
}

function requireDbSuccess(result, label) {
  if (result && result.code) {
    throw new Error(`${label}: ${result.message || result.code}`);
  }
  return result;
}

async function main() {
  let offset = 0;
  let scanned = 0;
  let migrated = 0;
  let orphaned = 0;
  while (true) {
    const response = requireDbSuccess(await rooms.skip(offset).limit(100).get(), "Read rooms");
    const batch = response.data || [];
    if (!batch.length) break;
    for (const room of batch) {
      scanned += 1;
      const ownerUid = ownerUidFor(room);
      const next = memberUidsFor(room, ownerUid);
      const current = Array.isArray(room.memberUids) ? [...new Set(room.memberUids)].sort() : [];
      const patch = {};
      if (ownerUid && room.ownerUid !== ownerUid) patch.ownerUid = ownerUid;
      if (JSON.stringify([...next].sort()) !== JSON.stringify(current)) patch.memberUids = next;
      if (!ownerUid || next.length === 0) {
        orphaned += 1;
        console.warn(`Room ${room._id} has no recoverable authenticated owner/member; it will stay private.`);
      }
      if (Object.keys(patch).length > 0) {
        const result = requireDbSuccess(
          await rooms.doc(room._id).update(patch),
          `Migrate room ${room._id}`
        );
        if (result.updated !== 1) throw new Error(`Room ${room._id} was not updated.`);
        migrated += 1;
      }
    }
    offset += batch.length;
    if (batch.length < 100) break;
  }
  console.log(`Room membership migration verified: ${scanned} scanned, ${migrated} updated, ${orphaned} orphaned.`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack : String(error));
  process.exitCode = 1;
});
