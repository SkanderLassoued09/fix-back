"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
require("./src/config/load-env");
const core_1 = require("@nestjs/core");
const schedule_1 = require("@nestjs/schedule");
const app_module_1 = require("./src/app.module");
const magasin_stock_reminder_service_1 = require("./src/magasin-stock/magasin-stock-reminder.service");
(async () => {
    var _a, _b, _c, _d;
    const ctx = await core_1.NestFactory.createApplicationContext(app_module_1.AppModule, {
        logger: ['error'],
    });
    try {
        const reg = ctx.get(schedule_1.SchedulerRegistry, { strict: false });
        const jobs = [...reg.getCronJobs().entries()];
        console.log(`jobs planifiés : ${jobs.length}`);
        for (const [name, job] of jobs) {
            if (/Magasin/i.test(name)) {
                const next = (_b = (_a = job).nextDate) === null || _b === void 0 ? void 0 : _b.call(_a);
                console.log(`  → ${name} · prochaine = ${(_d = (_c = next === null || next === void 0 ? void 0 : next.toString) === null || _c === void 0 ? void 0 : _c.call(next)) !== null && _d !== void 0 ? _d : next}`);
            }
        }
        const svc = ctx.get(magasin_stock_reminder_service_1.MagasinStockReminderService, { strict: false });
        console.log(`DI MagasinStockReminderService : ${svc ? 'résolu' : 'NON RÉSOLU'}`);
        console.log(`DI DiscordHookService injecté : ${svc.discordHookService ? 'oui' : 'NON'}`);
        console.log(`seuil effectif : ${svc.threshold()}`);
        const inc = await svc.detectIncomplete();
        console.log(`§2 à compléter : affected=${inc.affected} statut=${inc.status} ` +
            `prix=${inc.price} quantité=${inc.qty}`);
        console.log(`  exemples statut : ${svc.fmtParts(inc.statusMissing)}`);
    }
    finally {
        await ctx.close();
    }
})().catch((e) => {
    console.error('ÉCHEC : ' + (e.stack || e));
    process.exit(1);
});
//# sourceMappingURL=probe-magasin.tmp.js.map