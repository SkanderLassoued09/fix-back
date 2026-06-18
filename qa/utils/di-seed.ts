/**
 * QA seed helpers for DIs — produce VALID, app-shaped ids/entities instead of
 * forged junk (`INMAG-…`, `LIFE-…`). The backend numbers DIs as `DI{n}`
 * (max of existing `^DI\d+$` + 1); a forged `_idnum` like `INMAG-xxx` used to
 * (a) display wrong and (b) poison the counter → `DINaN`. The backend is now
 * hardened to ignore junk, and seeds should mirror the real format too.
 */

/** Next DI number, mirroring the backend: max of conforming `DI{n}` ids + 1
 *  (junk ids ignored). Never NaN. */
export async function nextDiNum(db: any): Promise<number> {
  const rows = await db
    .collection('dis')
    .find({ _idnum: { $regex: '^DI[0-9]+$' } }, { projection: { _idnum: 1 } })
    .toArray();
  let max = 0;
  for (const r of rows) {
    const n = parseInt(String(r._idnum).slice(2), 10);
    if (Number.isFinite(n) && n > max) max = n;
  }
  return max + 1;
}

/** A valid, real-format DI `_idnum` (`DI{n}`) for a seed — never a junk prefix. */
export async function nextDiIdnum(db: any): Promise<string> {
  return `DI${await nextDiNum(db)}`;
}

/** Pick an existing (non-deleted) client id so a seeded DI resolves an entity
 *  in the UI instead of showing "Unknown". Returns null if none seeded. */
export async function anyClientId(db: any): Promise<string | null> {
  const c = await db
    .collection('clients')
    .findOne({ isDeleted: { $ne: true } });
  return c?._id ?? null;
}
