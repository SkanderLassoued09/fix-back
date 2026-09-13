// Vérification ponctuelle : le job est-il enregistré, et le service câblé ?
const { NestFactory } = require('@nestjs/core');
process.env.NODE_ENV = 'development';
(async () => {
  const { AppModule } = require('/home/skander/Desktop/fx/fix-back/dist/app.module');
  const { SchedulerRegistry } = require('@nestjs/schedule');
  const {
    SessionCleanupService,
  } = require('/home/skander/Desktop/fx/fix-back/dist/session-cleanup/session-cleanup.service');

  const ctx = await NestFactory.createApplicationContext(AppModule, {
    logger: ['error'],
  });
  try {
    const reg = ctx.get(SchedulerRegistry, { strict: false });
    const jobs = [...reg.getCronJobs().keys()];
    console.log('jobs planifiés enregistrés : ' + jobs.length);
    jobs.filter((n) => /Session/i.test(n)).forEach((n) => console.log('  → ' + n));

    const svc = ctx.get(SessionCleanupService, { strict: false });
    console.log('service résolu : ' + (svc ? 'oui' : 'NON'));
    const res = await svc.run();
    console.log('résultat run() : ' + JSON.stringify(res));
  } finally {
    await ctx.close();
  }
})().catch((e) => {
  console.error('ÉCHEC : ' + (e.stack || e));
  process.exit(1);
});
