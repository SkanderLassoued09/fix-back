import { test, expect } from '@playwright/test';

test.use({ storageState: '.auth/ADMIN_MANAGER.json' });

test('point LOCATION : vide=vert, renseigné=rouge, meme valeur=meme couleur', async ({ page }) => {
    await page.goto('http://localhost:4200/tickets/ticket/ticket-list');
    await page.waitForSelector('.sav-location-dot', { timeout: 30000 });
    await page.waitForTimeout(1500);

    const rows = await page.$$eval('.sav-location-cell', (cells) =>
        cells.map((c) => {
            const dot = c.querySelector('.sav-location-dot') as HTMLElement;
            const rgb = dot ? getComputedStyle(dot).backgroundColor : '';
            return { texte: (c.textContent || '').trim(), rgb, classe: dot?.className || '' };
        })
    );

    const NAME: Record<string, string> = { 'rgb(22, 163, 74)': 'VERT', 'rgb(220, 38, 38)': 'ROUGE' };
    const VIDE = new Set(['', 'n/a', 'na', '—', '_', 'sans']);

    console.log(`\n=== ${rows.length} cellules LOCATION rendues ===`);
    const parValeur = new Map<string, Set<string>>();
    for (const r of rows) {
        const couleur = NAME[r.rgb] || r.rgb;
        if (!parValeur.has(r.texte)) parValeur.set(r.texte, new Set());
        parValeur.get(r.texte)!.add(couleur);
    }
    for (const [val, couleurs] of [...parValeur].sort()) {
        const attendu = VIDE.has(val.toLowerCase()) ? 'VERT' : 'ROUGE';
        const c = [...couleurs];
        const ok = c.length === 1 && c[0] === attendu;
        console.log(`${ok ? '  ok  ' : '  FAIL'}  ${JSON.stringify(val).padEnd(10)} -> ${c.join('+').padEnd(6)} (attendu ${attendu})`);
        expect(c.length, `« ${val} » doit avoir UNE seule couleur, or: ${c.join(' + ')}`).toBe(1);
        expect(c[0]).toBe(attendu);
    }
});
