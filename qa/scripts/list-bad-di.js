// Read-only: list DIs whose _idnum doesn't match the real convention "DI<number>".
// Uses fix-back's mongodb driver (qa/ doesn't depend on mongodb).
const { MongoClient } = require('C:/Users/meher/OneDrive/Bureau/fixtronix erp/fix-back/node_modules/mongodb');

(async () => {
  const client = new MongoClient('mongodb://127.0.0.1:27017');
  await client.connect();
  const db = client.db('fixtronix');
  const cols = (await db.listCollections().toArray()).map((c) => c.name);
  console.log('COLLECTIONS:', cols.join(', '));

  for (const name of cols) {
    const c = db.collection(name);
    const sample = await c.findOne({ _idnum: { $exists: true } });
    if (!sample) continue;
    const all = await c
      .find({ _idnum: { $exists: true } }, { projection: { _idnum: 1, title: 1, status: 1, isDeleted: 1, createdAt: 1 } })
      .sort({ createdAt: -1 })
      .toArray();
    const bad = all.filter((d) => !/^DI\d+$/.test(String(d._idnum)));
    console.log(`\n[collection: ${name}] total with _idnum=${all.length}  non-conforming=${bad.length}`);
    bad.forEach((d) =>
      console.log(
        '  BAD ' +
          JSON.stringify({ _id: d._id, _idnum: d._idnum, title: d.title, status: d.status, isDeleted: !!d.isDeleted }),
      ),
    );
    console.log('  latest 6 by createdAt: ' + all.slice(0, 6).map((d) => `${d._idnum}${d.isDeleted ? '(del)' : ''}`).join(', '));
  }
  await client.close();
})().catch((e) => {
  console.error('ERR', e.message);
  process.exit(1);
});
