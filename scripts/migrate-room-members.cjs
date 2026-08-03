function validUid(value) {
  return typeof value === "string" && value.length > 0;
}

function uniqueUids(values) {
  return [...new Set(values.filter(validUid))];
}

/* `room.members` is the active, top-level membership list. In contrast,
   `ledger.members` is intentionally historical: expense records still need
   the name of somebody who has left a room. It must never grant access. */
function activeTopLevelMemberUids(room) {
  if (!Array.isArray(room.members)) return [];
  return uniqueUids(room.members.map((member) => member && member.uid));
}

function existingMemberUids(room) {
  return Array.isArray(room.memberUids) ? uniqueUids(room.memberUids) : [];
}

function isTypedRoom(room) {
  const type = room.toolType || room.roomType;
  return type === "ledger" || type === "midpoint";
}

function ownerUidFor(room) {
  if (validUid(room.ownerUid)) return room.ownerUid;

  const active = activeTopLevelMemberUids(room);
  if (isTypedRoom(room)) return active.length > 0 ? active[0] : null;

  const existing = existingMemberUids(room);
  if (existing.length > 0) return existing[0];

  return active.length > 0 ? active[0] : null;
}

function memberUidsFor(room, ownerUid) {
  const trustedExisting = isTypedRoom(room) ? [] : existingMemberUids(room);
  return uniqueUids([...trustedExisting, ownerUid, ...activeTopLevelMemberUids(room)]);
}

function migrationPatchFor(room) {
  const ownerUid = ownerUidFor(room);
  const nextMemberUids = memberUidsFor(room, ownerUid);
  const currentMemberUids = existingMemberUids(room);
  const patch = {};

  if (ownerUid && room.ownerUid !== ownerUid) patch.ownerUid = ownerUid;
  if (JSON.stringify([...nextMemberUids].sort()) !== JSON.stringify([...currentMemberUids].sort())) {
    patch.memberUids = nextMemberUids;
  }

  return { ownerUid, memberUids: nextMemberUids, patch };
}

function requireDbSuccess(result, label) {
  if (result && result.code) {
    throw new Error(`${label}: ${result.message || result.code}`);
  }
  return result;
}

async function main() {
  if (process.env.RUN_ROOM_MEMBERSHIP_MIGRATION !== "1") {
    throw new Error(
      "Room membership migration is disabled by default. Set RUN_ROOM_MEMBERSHIP_MIGRATION=1 for an intentional one-time run."
    );
  }

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
      const migration = migrationPatchFor(room);
      if (!migration.ownerUid || migration.memberUids.length === 0) {
        orphaned += 1;
        console.warn(`Room ${room._id} has no recoverable authenticated owner/member; it will stay private.`);
      }

      if (Object.keys(migration.patch).length > 0) {
        const result = requireDbSuccess(
          await rooms.doc(room._id).update(migration.patch),
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

module.exports = {
  activeTopLevelMemberUids,
  existingMemberUids,
  isTypedRoom,
  ownerUidFor,
  memberUidsFor,
  migrationPatchFor
};

if (require.main === module) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.stack : String(error));
    process.exitCode = 1;
  });
}
