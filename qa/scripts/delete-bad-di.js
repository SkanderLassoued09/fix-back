// Hard-delete the polluted TEST01 records (confirmed by the user).
// The _idnum generator (di.service.generateClientId) reads the latest DI by
// createdAt WITHOUT filtering isDeleted, so a soft delete would not clean it —
// these must be removed from the collections.
const { MongoClient } = require('C:/Users/meher/OneDrive/Bureau/fixtronix erp/fix-back/node_modules/mongodb');

(async () => {
  const client = new MongoClient('mongodb://127.0.0.1:27017');
  await client.connect();
  const db = client.db('fixtronix');

  const disRes = await db.collection('dis').deleteMany({ _idnum: 'TEST01' });
  const statsRes = await db.collection('stats').deleteMany({ _idnum: 'TEST01' });
  console.log('deleted from dis:', disRes.deletedCount, '| deleted from stats:', statsRes.deletedCount);

  // Verify: no non-conforming _idnum remain, and the latest DI is conforming
  // (so the next createDi resumes the DI<number> sequence cleanly).
  const all = await db
    .collection('dis')
    .find({ _idnum: { $exists: true } }, { projection: { _idnum: 1, createdAt: 1 } })
    .sort({ createdAt: -1 })
    .toArray();
  const bad = all.filter((d) => !/^DI\d+$/.test(String(d._idnum)));
  console.log('remaining non-conforming dis:', bad.length);
  console.log('latest dis _idnum now:', all[0]?._idnum, '| total dis:', all.length);

  await client.close();
})().catch((e) => {
  console.error('ERR', e.message);
  process.exit(1);
});
