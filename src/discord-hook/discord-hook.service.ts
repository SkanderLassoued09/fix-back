import { Injectable, Logger } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import axios from 'axios';
import { Client } from 'src/clients/entities/client.entity';
import { Company } from 'src/company/entities/company.entity';
import { Profile } from 'src/profile/entities/profile.entity';
import { Stat } from 'src/stat/entities/stat.entity';
import { currentActor } from 'src/common/request-context';

/**
 * Channels — each `sendXxx` posts through `postEmbed(channel, payload)`.
 * Every env file (`.env.{development,preprod,production}`) declares one
 * webhook URL per channel; a missing one is logged ONCE and the post is
 * silently skipped (never throws) so a partial config can't cascade a
 * failure through a DI-create call.
 *
 * Routage :
 *   - GENERAL_ATELIER : TOUT le flux (DI, documents, catalogue, PV, réunions) ;
 *   - ERROR           : erreurs opérationnelles ;
 *   - APP_ALERT       : alertes (stagnation, sauvegarde BDD, digests DiArchive/Jira) ;
 *   - DEMANDE_PDF     : salon « demande PDR » — rappel stock magasin.
 * SERVICE_TECHNIQUE n'a plus d'émetteur ; la clé reste pour TEST_DISCORD_CHANNELS.
 */
type ChannelKey =
  | 'GENERAL_ATELIER'
  | 'SERVICE_TECHNIQUE'
  | 'DEMANDE_PDF'
  | 'ERROR'
  | 'APP_ALERT';

/** Salon du rappel matinal du magasin (stock bas + fiches à compléter) : le
 *  salon « demande PDR » (clé historique `DEMANDE_PDF`). */
const STOCK_REMINDER_CHANNEL: ChannelKey = 'DEMANDE_PDF';

/** Libellés FR des rôles pour « 🙋 Action par » — la valeur brute (dont la
 *  typo persistée `COORDIANTOR`) ne doit jamais fuiter vers Discord. */
const ROLE_LABELS: Record<string, string> = {
  COORDIANTOR: 'Coordinatrice',
  TECH: 'Technicien',
  MAGASIN: 'Magasin',
  MANAGER: 'Manager',
  ADMIN_MANAGER: 'Admin Manager',
  ADMIN_TECH: 'Admin Tech',
};

// Centralized human-readable status labels with color emoji prefix.
// New raw enum values added to STATUS_DI MUST be added here so embeds
// never leak the raw enum name to Discord.
const STATUS_LABELS: Record<string, string> = {
  CREATED: '🆕 Créée',
  PENDING1: '🟡 En attente diagnostic',
  DIAGNOSTIC: '🧭 Diagnostic affecté',
  DIAGNOSTIC_Pause: '⏸️ Diagnostic en pause',
  INDIAGNOSTIC: '🔍 En diagnostic',
  MagasinEstimation: '🏬 Estimation magasin',
  // Renommé MAGASIN_PREPARATION → PROCESSING → CONFIRMATION (clé legacy
  // `PROCESSING` conservée pour les DI/logs pas encore migrés).
  CONFIRMATION: '🏬 CONFIRMATION',
  PROCESSING: '🏬 PROCESSING',
  CONFIRMATION_COMPOSANTS: '🤝 En attente confirmation Coordination',
  ATTENTE_CONFIRMATION_COORDINATION: '🤝 En attente confirmation Coordination',
  PENDING2: '📦 En attente de facturation',
  // Renommé : PRICING → PRICING_DIAG (clé legacy conservée pour les
  // DI/logs pas encore migrés).
  PRICING: '💰 PRICING',
  PRICING_DIAG: '💰 PRICING',
  // Phase Approval documentaire — SPLIT en WAITING_DEVIS → WAITING_BC (clés
  // legacy NEGOTIATION1/ATTENTE_BC_DEVIS conservées pour les DI pas encore migrées).
  WAITING_DEVIS: '🤝 Approval — attente devis',
  WAITING_BC: '🤝 Approval — attente BC',
  NEGOTIATION1: '🤝 Approval',
  ATTENTE_BC_DEVIS: '🤝 Approval',
  NEGOTIATION2: '🤝 Négociation 2 (Admin)',
  ANNULER: '❌ Annulée',
  PENDING3: '🚚 En attente réparation',
  REPARATION: '🛠️ Réparation affectée',
  REPARATION_Pause: '⏸️ Réparation en pause',
  INREPARATION: '🔧 En réparation',
  // Phase de clôture documentaire — SPLIT en WAITING_BL → WAITING_FACTURE (clés
  // legacy CLOSING/ATTENTE_BL_FACTURE conservées pour les DI pas encore migrées).
  WAITING_BL: '📄 Clôture — attente BL',
  WAITING_FACTURE: '📄 Clôture — attente facture',
  CLOSING: '📄 CLOSING',
  ATTENTE_BL_FACTURE: '📄 CLOSING',
  FINISHED: '✅ Terminée',
  IRREPARABLE: '⛔ Irréparable',
  RETOUR1: '🔁 Retour 1',
  RETOUR2: '🔁 Retour 2',
  RETOUR3: '⚠️ Retour 3',
};

/** Human-readable byte size for embeds (`1.4 MB`) — display only. */
function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.min(
    Math.floor(Math.log(bytes) / Math.log(1024)),
    units.length - 1,
  );
  return `${(bytes / 1024 ** i).toFixed(i === 0 ? 0 : 2)} ${units[i]}`;
}

interface EmbedContext {
  idnum: string;
  title: string;
  clientName: string;
  companyName: string;
  customerLabel: string; // company if present, otherwise client
  customerFieldName: string; // '🏢 Company' or '👤 Client'
  statusLabel: string;
  actorLabel: string; // « 🙋 Action par »
  techLabel: string; // « 👨‍🔧 Technicien »
}

/** Surcharges de `buildContext`, quand l'appelant en sait plus que le contexte
 *  de requête ou que la ligne Stat du cycle. */
interface EmbedContextOptions {
  /** Profil ou id — prioritaire sur l'acteur de la requête. */
  actor?: any;
  /** Profils ou ids — prioritaires, champ par champ, sur la ligne Stat. */
  tech?: { diag?: any; rep?: any };
  /** Cycle de la ligne Stat à lire (défaut : `di.ignoreCount`). */
  cycle?: number;
}

/**
 * 🔕 INTERRUPTEUR DES NOTIFICATIONS DISCORD DU FLUX.
 *
 * `false` → tout est émis. `true` → seuls les envois qui appellent
 * `deliverEmbed` DIRECTEMENT restent émis (retour, stagnation, rappel stock
 * magasin, sauvegarde BDD, erreurs, digest DiArchive) ; tous les autres sont
 * coupés à la source via le gate de `postEmbed`.
 *
 * ⚠️ Ni file d'attente ni gestion du 429 (Discord limite à ~5 req/s par
 * webhook) : surveiller les `[HTTP 429]` journalisés par `deliverEmbed`.
 */
const DISCORD_NOTIFS_DISABLED = false;

/** Plafond d'attente d'un webhook Discord. Voir `deliverEmbed`. */
const DISCORD_TIMEOUT_MS = 5000;

@Injectable()
export class DiscordHookService {
  private readonly logger = new Logger(DiscordHookService.name);
  /** Tracks channels whose URL was already reported missing — one warn
   *  per channel per process to avoid spamming logs on every send. */
  private readonly warnedMissing = new Set<ChannelKey>();

  /**
   * Resolve the webhook URL for a given channel from env. Each of the 3
   * environments (`.env.{development,preprod,production}`) declares one
   * DEDICATED webhook per channel — there is NO shared/legacy
   * `DISCORD_WEBHOOK_URL` fallback. A channel with no URL configured is
   * skipped by `postEmbed` (warned once, never throws).
   */
  private urlFor(channel: ChannelKey): string {
    switch (channel) {
      case 'GENERAL_ATELIER':
        return process.env.DISCORD_GENERAL_ATELIER_WEBHOOK || '';
      case 'SERVICE_TECHNIQUE':
        return process.env.DISCORD_SERVICE_TECHNIQUE_WEBHOOK || '';
      case 'DEMANDE_PDF':
        return process.env.DISCORD_DEMANDE_PDF_WEBHOOK || '';
      case 'ERROR':
        return process.env.DISCORD_ERROR_WEBHOOK || '';
      case 'APP_ALERT':
        return process.env.DISCORD_APP_ALERT_WEBHOOK || '';
    }
  }

  /**
   * Single post entry-point. NEVER throws:
   *   - missing URL → warn once, skip (a create-DI mutation can no longer
   *     crash because a webhook env var was forgotten)
   *   - axios failure → warn (already the pattern in the codebase — the
   *     Discord post is always best-effort)
   */
  async postEmbed(
    channel: ChannelKey,
    payload: object,
  ): Promise<void> {
    // 🔕 GATE — coupe À LA SOURCE tout ce qui passe par ici quand
    // DISCORD_NOTIFS_DISABLED vaut true (ouvert : false).
    //
    // Hors gate (appellent `deliverEmbed` DIRECTEMENT) :
    //   - RETOUR 1/2/3, STAGNATION, RAPPEL STOCK MAGASIN, SAUVEGARDE BDD ;
    //   - canal ERROR (`sendOperationalError`) — canal d'ALERTE, pas du bruit
    //     DI : coupé, les pannes n'étaient plus visibles que dans un fichier
    //     de log que personne ne surveille ;
    //   - digest DiArchive (`sendDiArchiveDigest`) — aucun autre canal : le
    //     cron calculait tout et ne publiait rien.
    // ▶️ Pour réactiver le flux DI : passer DISCORD_NOTIFS_DISABLED à false.
    //    ⚠️ Avant de le faire : il n'y a ni file d'attente ni gestion du 429
    //    (Discord limite à ~5 req/s par webhook).
    if (DISCORD_NOTIFS_DISABLED) {
      return;
    }
    return this.deliverEmbed(channel, payload);
  }

  /** Envoi bas-niveau réel vers le webhook Discord (sans gate). Utilisé
   *  directement par les seules notifications conservées (retour, stagnation,
   *  rappel stock magasin) et par `postEmbed` quand le gate est ouvert. */
  private async deliverEmbed(
    channel: ChannelKey,
    payload: object,
  ): Promise<void> {
    const url = this.urlFor(channel);
    if (!url) {
      if (!this.warnedMissing.has(channel)) {
        this.warnedMissing.add(channel);
        this.logger.warn(
          `Discord channel "${channel}" webhook is not configured → post skipped`,
        );
      }
      return;
    }
    try {
      // TIMEOUT OBLIGATOIRE : axios attend indéfiniment par défaut
      // (`timeout: 0`). Or 31 de ces envois sont `await`és DANS des mutations
      // DI : un webhook qui pend bloquait la mutation, donc la requête du
      // technicien, sans limite.
      await axios.post(url, payload, { timeout: DISCORD_TIMEOUT_MS });
    } catch (err) {
      // Le CODE HTTP est journalisé : sans lui, un 429 (limite de débit
      // Discord — 4 cas constatés dans les journaux) était indiscernable
      // d'un 404 ou d'une panne réseau.
      const status = (err as any)?.response?.status;
      this.logger.warn(
        `Discord post to "${channel}" failed${
          status ? ` [HTTP ${status}]` : ''
        }: ${(err as Error)?.message}`,
      );
    }
  }

  /** True when the Jira-digest channel (APP_ALERT) is reachable — lets
   *  the Jira-notify cron skip cleanly instead of claiming docs it can't
   *  deliver. Named for backwards compatibility with existing callers.
   *  Lisait SERVICE_TECHNIQUE alors que `sendJiraTasksDigest` poste sur
   *  APP_ALERT : retirer ce webhook aurait coupé le cron Jira en silence. */
  get isPvConfigured(): boolean {
    return !!this.urlFor('APP_ALERT');
  }

  constructor(
    @InjectModel(Client.name) private readonly clientModel: Model<any>,
    @InjectModel(Company.name) private readonly companyModel: Model<any>,
    @InjectModel(Profile.name) private readonly profileModel: Model<any>,
    @InjectModel(Stat.name) private readonly statModel: Model<any>,
  ) {}

  /**
   * Diagnostic — post a SELF-IDENTIFYING test embed to an ARBITRARY webhook URL.
   * Used by the `TEST_DISCORD_CHANNELS` action to verify each of the env's 5
   * Discord channels is wired to the right server/channel. Throws on HTTP
   * failure so the caller can report per-channel success/failure.
   */
  async sendTestEmbed(
    webhookUrl: string,
    channelName: string,
    nodeEnv: string,
  ): Promise<void> {
    const envUpper = (nodeEnv || '').toUpperCase();
    const tunis = new Intl.DateTimeFormat('fr-FR', {
      timeZone: 'Africa/Tunis',
      dateStyle: 'short',
      timeStyle: 'medium',
    }).format(new Date());
    await axios.post(webhookUrl, {
      embeds: [
        {
          title: `🔔 TEST WEBHOOK — [${envUpper}]`,
          description: `Si vous voyez ce message, le canal **${channelName}** de l'environnement **${nodeEnv}** est correctement câblé.`,
          color: 3447003, // blue
          fields: [
            { name: 'Canal', value: channelName, inline: true },
            { name: 'Environnement', value: envUpper, inline: true },
            { name: '🕐 Heure (Africa/Tunis)', value: tunis, inline: false },
          ],
          footer: { text: 'Fixtronix — diagnostic des webhooks' },
          timestamp: new Date().toISOString(),
        },
      ],
    });
  }

  // ─────────────────────────────────────────────────────────────────────
  // Centralized resolvers — every embed routes through these so no raw
  // ObjectIds, UUIDs, or enum values can leak to Discord.
  // ─────────────────────────────────────────────────────────────────────

  resolveStatusLabel(status: string | undefined | null): string {
    if (!status) return 'Inconnu';
    return STATUS_LABELS[status] || status;
  }

  private formatProfile(p: any): string {
    if (!p) return 'N/A';
    if (p.username) return p.username;
    const full = `${p.firstName || ''} ${p.lastName || ''}`.trim();
    return full || 'N/A';
  }

  async resolveProfileDisplay(value: any): Promise<string> {
    if (!value) return 'N/A';
    if (typeof value === 'object') {
      const display = this.formatProfile(value);
      if (display !== 'N/A') return display;
      // object lacks username/name fields — fall back to id lookup
      if (value._id) {
        const p = await this.profileModel.findOne({ _id: value._id }).lean();
        return this.formatProfile(p);
      }
      return 'N/A';
    }
    if (typeof value === 'string') {
      // looks like an id — resolve. If it doesn't match a profile, return
      // 'N/A' rather than echoing the raw string (avoid id leak).
      const p = await this.profileModel.findOne({ _id: value }).lean();
      return this.formatProfile(p);
    }
    return 'N/A';
  }

  private formatClient(c: any): string {
    if (!c) return '';
    return `${c.first_name || ''} ${c.last_name || ''}`.trim();
  }

  private async resolveClientName(value: any): Promise<string> {
    if (!value) return '';
    if (typeof value === 'object') {
      const display = this.formatClient(value);
      if (display) return display;
      if (value._id) {
        const c = await this.clientModel.findOne({ _id: value._id }).lean();
        return this.formatClient(c);
      }
      return '';
    }
    if (typeof value === 'string') {
      const c = await this.clientModel.findOne({ _id: value }).lean();
      return this.formatClient(c);
    }
    return '';
  }

  private async resolveCompanyName(value: any): Promise<string> {
    if (!value) return '';
    if (typeof value === 'object') {
      if (value.name) return value.name;
      if (value._id) {
        const co: any = await this.companyModel
          .findOne({ _id: value._id })
          .lean();
        return co?.name || '';
      }
      return '';
    }
    if (typeof value === 'string') {
      const co: any = await this.companyModel.findOne({ _id: value }).lean();
      return co?.name || '';
    }
    return '';
  }

  /**
   * « 🙋 Action par » — surcharge explicite, sinon acteur de la requête
   * (`currentActor`). `⚙️ Système` hors requête (cron / ACTION), `Inconnu`
   * quand la requête n'identifie personne. Ne lève jamais.
   */
  private async resolveActorLabel(explicit?: any): Promise<string> {
    try {
      let actor = explicit;
      if (actor === undefined || actor === null || actor === '') {
        const fromRequest = currentActor();
        if (fromRequest === undefined) return '⚙️ Système';
        if (!fromRequest) return 'Inconnu';
        actor = fromRequest;
      }
      // Id brut → profil (nom + rôle) ; objet (JWT, profil peuplé) → tel quel.
      const profile =
        typeof actor === 'string'
          ? await this.profileModel.findOne({ _id: actor }).lean()
          : actor;
      if (!profile) return 'Inconnu';
      const name = await this.resolveProfileDisplay(profile);
      if (!name || name === 'N/A') return 'Inconnu';
      const role = ROLE_LABELS[(profile as any)?.role];
      return role ? `${name} · ${role}` : name;
    } catch {
      return 'Inconnu';
    }
  }

  /**
   * « 👨‍🔧 Technicien » — ligne Stat du cycle (`{ _idDi, ignoreCount }`, une ligne
   * PAR cycle), surchargée champ par champ par `opts.tech`. Ne lève jamais :
   * une lecture ratée donne `Non affecté` plutôt que de bloquer l'envoi.
   */
  private async resolveTechLabel(
    di: any,
    opts: EmbedContextOptions,
  ): Promise<string> {
    try {
      let stat: any = null;
      if (di?._id && this.statModel?.findOne) {
        stat = await this.statModel
          .findOne({
            _idDi: String(di._id),
            ignoreCount: opts.cycle ?? di?.ignoreCount ?? 0,
          })
          .lean();
      }
      const diagRef = opts.tech?.diag ?? stat?.id_tech_diag;
      const repRef = opts.tech?.rep ?? stat?.id_tech_rep;
      const [diag, rep] = await Promise.all([
        diagRef ? this.resolveProfileDisplay(diagRef) : 'N/A',
        repRef ? this.resolveProfileDisplay(repRef) : 'N/A',
      ]);
      const hasDiag = diag !== 'N/A';
      const hasRep = rep !== 'N/A';
      if (hasDiag && hasRep) {
        return diag === rep
          ? `${diag} (diag + rép)`
          : `Diag : ${diag} · Rép : ${rep}`;
      }
      if (hasDiag) return `Diag : ${diag}`;
      if (hasRep) return `Rép : ${rep}`;
      return 'Non affecté';
    } catch {
      return 'Non affecté';
    }
  }

  async buildContext(
    di: any,
    opts: EmbedContextOptions = {},
  ): Promise<EmbedContext> {
    const idnum = di?._idnum || 'N/A';
    const title = di?.title || 'N/A';
    const [clientName, companyName, actorLabel, techLabel] = await Promise.all([
      this.resolveClientName(di?.client_id),
      this.resolveCompanyName(di?.company_id),
      this.resolveActorLabel(opts.actor),
      this.resolveTechLabel(di, opts),
    ]);
    const useCompany = Boolean(companyName);
    return {
      idnum,
      title,
      clientName: clientName || 'N/A',
      companyName: companyName || 'N/A',
      customerLabel: useCompany ? companyName : clientName || 'N/A',
      customerFieldName: useCompany ? '🏢 Société' : '👤 Client',
      statusLabel: this.resolveStatusLabel(di?.status),
      actorLabel,
      techLabel,
    };
  }

  // Build the standard skeleton: DI Number, Title, Customer, Status, Actor,
  // Technician. Append extraFields after them for context-specific data.
  private buildBaseFields(
    ctx: EmbedContext,
    statusOverride?: string,
    extraFields: any[] = [],
  ) {
    return [
      { name: '🆔 N° DI', value: ctx.idnum, inline: true },
      { name: '📄 Titre', value: ctx.title },
      {
        name: ctx.customerFieldName,
        value: ctx.customerLabel,
        inline: true,
      },
      {
        name: '📊 Statut',
        value: statusOverride || ctx.statusLabel,
        inline: true,
      },
      { name: '🙋 Action par', value: ctx.actorLabel, inline: true },
      { name: '👨‍🔧 Technicien', value: ctx.techLabel, inline: true },
      ...extraFields,
    ];
  }

  // ─────────────────────────────────────────────────────────────────────
  // Embed senders. Each one routes through buildContext so client,
  // company, technician and status are always resolved to display names.
  // ─────────────────────────────────────────────────────────────────────

  async sendDiPendingNotification(di: any) {
    // Acteur = créateur de la DI (juste aussi pour un import, où la requête
    // n'est pas celle du créateur) ; remplace l'ancien champ « Créée par ».
    const ctx = await this.buildContext(di, { actor: di?.createdBy });

    await this.postEmbed('GENERAL_ATELIER', {
      embeds: [
        {
          title: '📌 DI en attente',
          description: 'Une nouvelle DI a été créée et est en attente.',
          color: 16776960, // yellow (pending)
          fields: this.buildBaseFields(ctx),
          footer: { text: 'Fixtronix System' },
          timestamp: new Date().toISOString(),
        },
      ],
    });
  }

  async sendDiAssignedToTech({
    di,
    stat,
    technician,
  }: {
    di: any;
    stat: any;
    technician: any;
  }) {
    const ctx = await this.buildContext(
      {
        ...di,
        // The Stat carries the live status when DI hasn't been refetched yet.
        status: stat?.status || di?.status,
      },
      { tech: { diag: technician } },
    );

    await this.postEmbed('GENERAL_ATELIER', {
      embeds: [
        {
          title: '🛠️ DI affectée au technicien',
          description: 'Une DI a été affectée pour diagnostic.',
          color: 3447003, // blue
          fields: this.buildBaseFields(ctx),
          footer: { text: 'Fixtronix System' },
          timestamp: new Date().toISOString(),
        },
      ],
    });
  }

  async sendComponentsSentToCoordinator(di: any) {
    const ctx = await this.buildContext(di);
    await this.postEmbed('GENERAL_ATELIER', {
      embeds: [
        {
          title: '📦 Composants envoyés pour validation',
          description: 'Le magasin a envoyé des composants à la coordinatrice pour validation.',
          color: 10197915,
          fields: this.buildBaseFields(ctx, undefined, [
            { name: '🏬 Source', value: 'Magasin', inline: true },
            { name: '🧑‍💼 Destinataire', value: 'Coordinatrice', inline: true },
          ]),
          footer: { text: 'Fixtronix System' },
          timestamp: new Date().toISOString(),
        },
      ],
    });
  }

  async sendComponentsConfirmedByCoordinator(di: any) {
    const ctx = await this.buildContext(di);
    await this.postEmbed('GENERAL_ATELIER', {
      embeds: [
        {
          title: '✅ Composants validés par la coordinatrice',
          description:
            'La coordinatrice a validé les composants. Le magasin peut continuer.',
          color: 3066993,
          fields: this.buildBaseFields(ctx, undefined, [
            { name: '🧑‍💼 Source', value: 'Coordinatrice', inline: true },
            { name: '🏬 Destinataire', value: 'Magasin', inline: true },
          ]),
          footer: { text: 'Fixtronix System' },
          timestamp: new Date().toISOString(),
        },
      ],
    });
  }

  async sendDiInMagasin(di: any) {
    const ctx = await this.buildContext(di);
    await this.postEmbed('GENERAL_ATELIER', {
      embeds: [
        {
          title: '🏬 DI arrivée au magasin',
          description: 'La DI est maintenant au magasin.',
          color: 5763719,
          fields: this.buildBaseFields(ctx),
          footer: { text: 'Fixtronix System' },
          timestamp: new Date().toISOString(),
        },
      ],
    });
  }

  async sendDiStatusPending3(di: any) {
    const ctx = await this.buildContext(di);
    await this.postEmbed('GENERAL_ATELIER', {
      embeds: [
        {
          title: '🚚 DI passée en attente réparation',
          description: 'La DI passe à l\'étape suivante (attente réparation).',
          color: 5793266,
          fields: this.buildBaseFields(ctx),
          footer: { text: 'Fixtronix System' },
          timestamp: new Date().toISOString(),
        },
      ],
    });
  }

  async sendDiDevisUploaded({ di, fileName }: { di: any; fileName: string }) {
    const ctx = await this.buildContext(di);
    await this.postEmbed('GENERAL_ATELIER', {
      embeds: [
        {
          title: '🧾 Devis ajouté',
          description: 'Un devis a été ajouté.',
          color: 10181046,
          fields: this.buildBaseFields(ctx, undefined, [
            { name: '📎 Fichier', value: fileName },
          ]),
          footer: { text: 'Fixtronix System' },
          timestamp: new Date().toISOString(),
        },
      ],
    });
  }

  async sendDiBCUploaded({ di, fileName }: { di: any; fileName: string }) {
    const ctx = await this.buildContext(di);
    await this.postEmbed('GENERAL_ATELIER', {
      embeds: [
        {
          title: '📄 Bon de commande ajouté',
          description: 'Un bon de commande (PDF) a été ajouté pour cette DI.',
          color: 3447003,
          fields: this.buildBaseFields(ctx, undefined, [
            { name: '📎 Fichier', value: fileName },
          ]),
          footer: { text: 'Fixtronix System' },
          timestamp: new Date().toISOString(),
        },
      ],
    });
  }

  async sendDiPriceAssigned({ di, price }: { di: any; price: number }) {
    const ctx = await this.buildContext(di);
    await this.postEmbed('GENERAL_ATELIER', {
      embeds: [
        {
          title: '💰 Prix affecté à la DI',
          description: 'La facturation a été effectuée.',
          color: 3066993,
          fields: this.buildBaseFields(ctx, undefined, [
            { name: '💵 Prix', value: `${price} TND`, inline: true },
          ]),
          footer: { text: 'Fixtronix System' },
          timestamp: new Date().toISOString(),
        },
      ],
    });
  }

  async sendDiStatusPending2(di: any) {
    const ctx = await this.buildContext(di);
    await this.postEmbed('GENERAL_ATELIER', {
      embeds: [
        {
          title: '📦 Statut de la DI mis à jour',
          description: 'La DI est passée à l\'étape suivante (attente de facturation).',
          color: 15844367,
          fields: this.buildBaseFields(ctx),
          footer: { text: 'Fixtronix System' },
          timestamp: new Date().toISOString(),
        },
      ],
    });
  }

  async sendDiPricing(di: any) {
    const ctx = await this.buildContext(di);
    await this.postEmbed('GENERAL_ATELIER', {
      embeds: [
        {
          title: '💰 DI prête pour facturation',
          description: 'Une DI est prête pour la facturation. Action requise par l\'administrateur.',
          color: 16753920,
          fields: this.buildBaseFields(ctx),
          footer: { text: 'Fixtronix System' },
          timestamp: new Date().toISOString(),
        },
      ],
    });
  }

  async sendDiStatusPending1(di: any) {
    const ctx = await this.buildContext(di);
    await this.postEmbed('GENERAL_ATELIER', {
      embeds: [
        {
          title: '🆕 DI créée',
          description: 'Une nouvelle DI est entrée dans le flux.',
          color: 16776960,
          fields: this.buildBaseFields(ctx),
          footer: { text: 'Fixtronix System' },
          timestamp: new Date().toISOString(),
        },
      ],
    });
  }

  async sendDiIgnored(di: any) {
    const ctx = await this.buildContext(di);
    const isMax = (di?.ignoreCount || 0) >= 3;
    await this.postEmbed('GENERAL_ATELIER', {
      embeds: [
        {
          title: isMax ? '⚠️ DI ignorée (limite atteinte)' : '⚠️ DI ignorée',
          description: isMax
            ? 'Cette DI a atteint la limite maximale d\'ignorance.'
            : 'Cette DI a été ignorée.',
          color: isMax ? 15158332 : 16776960,
          fields: this.buildBaseFields(ctx, undefined, [
            {
              name: '🚫 Nombre d\'ignorances',
              value: `${di?.ignoreCount ?? 0}/3`,
              inline: true,
            },
          ]),
          footer: { text: 'Fixtronix System' },
          timestamp: new Date().toISOString(),
        },
      ],
    });
  }

  async sendDiFinished(di: any) {
    const ctx = await this.buildContext(di);
    await this.postEmbed('GENERAL_ATELIER', {
      embeds: [
        {
          title: '🎉 DI terminée',
          description: 'Le processus de réparation est entièrement terminé.',
          color: 3066993,
          fields: this.buildBaseFields(ctx, undefined, [
            {
              name: '💵 Prix final',
              value: di?.price ? `${di.price} TND` : 'N/A',
              inline: true,
            },
          ]),
          footer: { text: 'Fixtronix System' },
          timestamp: new Date().toISOString(),
        },
      ],
    });
  }

  async sendDiIrreparable(di: any) {
    // Clôture d'une DI NON RÉPARABLE (statut terminal IRREPARABLE) — l'équipement
    // ne peut pas être réparé. Miroir de `sendDiFinished` (canal général).
    const ctx = await this.buildContext(di);
    await this.postEmbed('GENERAL_ATELIER', {
      embeds: [
        {
          title: '⛔ DI irréparable',
          description: 'Équipement jugé non réparable — dossier clôturé.',
          color: 15158332,
          fields: this.buildBaseFields(ctx, undefined, [
            {
              name: '💵 Diagnostic',
              value: di?.price ? `${di.price} TND` : 'Non facturé',
              inline: true,
            },
          ]),
          footer: { text: 'Fixtronix System' },
          timestamp: new Date().toISOString(),
        },
      ],
    });
  }

  async sendDiInReparation(di: any) {
    // Called when status is REPARATION — assigned but not yet started.
    const ctx = await this.buildContext(di);
    await this.postEmbed('GENERAL_ATELIER', {
      embeds: [
        {
          title: '🛠️ DI prête pour réparation',
          description:
            'Phase de réparation affectée. En attente du démarrage par le technicien.',
          color: 15105570,
          fields: this.buildBaseFields(ctx),
          footer: { text: 'Fixtronix System' },
          timestamp: new Date().toISOString(),
        },
      ],
    });
  }

  async sendDiagnosticFinished({ di, diag }: { di: any; diag: any }) {
    const ctx = await this.buildContext(di);
    const repairable = diag?.can_be_repaired
      ? '✅ Réparable'
      : '🚫 Non réparable';
    await this.postEmbed('GENERAL_ATELIER', {
      embeds: [
        {
          title: '✅ Diagnostic terminé',
          description: 'Le technicien a terminé le diagnostic.',
          color: diag?.can_be_repaired ? 3066993 : 15158332,
          fields: this.buildBaseFields(ctx, undefined, [
            { name: '🧾 Résultat', value: repairable, inline: true },
            {
              name: '📦 Contient PDR',
              value: diag?.contain_pdr ? 'Oui' : 'Non',
              inline: true,
            },
            {
              name: '⚠️ Erreur Fixtronix',
              value: diag?.isErrorFromFixtronix ? 'Oui' : 'Non',
              inline: true,
            },
            {
              name: '📝 Note de diagnostic',
              value: diag?.remarque_tech_diagnostic || 'N/A',
            },
          ]),
          footer: { text: 'Fixtronix System' },
          timestamp: new Date().toISOString(),
        },
      ],
    });
  }

  // ── Pause / Resume / Started / Assigned (workflow refinements) ──────

  async sendDiagnosticPaused(di: any) {

    const ctx = await this.buildContext(di);
    const note = di?.remarque_tech_diagnostic;
    await this.postEmbed('GENERAL_ATELIER', {
      embeds: [
        {
          title: '⏸️ Diagnostic en pause',
          description: 'Le technicien a mis le diagnostic en pause.',
          color: 9807270,
          fields: this.buildBaseFields(
            ctx,
            undefined,
            note ? [{ name: '📝 Note', value: note }] : [],
          ),
          footer: { text: 'Fixtronix System' },
          timestamp: new Date().toISOString(),
        },
      ],
    });
  }

  async sendDiagnosticResumed(di: any) {
    const ctx = await this.buildContext(di);
    await this.postEmbed('GENERAL_ATELIER', {
      embeds: [
        {
          title: '▶️ Diagnostic repris',
          description: 'Le technicien a repris le diagnostic.',
          color: 3447003,
          fields: this.buildBaseFields(ctx),
          footer: { text: 'Fixtronix System' },
          timestamp: new Date().toISOString(),
        },
      ],
    });
  }

  async sendDiagnosticStarted(di: any) {
    const ctx = await this.buildContext(di);
    await this.postEmbed('GENERAL_ATELIER', {
      embeds: [
        {
          title: '🔍 Diagnostic démarré',
          description: 'Le technicien a démarré le diagnostic.',
          color: 3447003,
          fields: this.buildBaseFields(ctx),
          footer: { text: 'Fixtronix System' },
          timestamp: new Date().toISOString(),
        },
      ],
    });
  }

  async sendDiagnosticAssigned(di: any, technician?: any) {
    // Le technicien affecté est passé en surcharge (prioritaire sur la ligne
    // Stat) : le champ standard « 👨‍🔧 Technicien » le porte, sans doublon.
    const ctx = await this.buildContext(di, {
      tech: { diag: technician ?? undefined },
    });
    await this.postEmbed('GENERAL_ATELIER', {
      embeds: [
        {
          title: '🧭 Diagnostic affecté',
          description: 'La coordinatrice a affecté cette DI au diagnostic.',
          color: 3447003,
          fields: this.buildBaseFields(ctx),
          footer: { text: 'Fixtronix System' },
          timestamp: new Date().toISOString(),
        },
      ],
    });
  }

  async sendReparationStarted(di: any) {

    const ctx = await this.buildContext(di);
    await this.postEmbed('GENERAL_ATELIER', {
      embeds: [
        {
          title: '🔧 Réparation démarrée',
          description: 'Le technicien a démarré la réparation.',
          color: 15105570,
          fields: this.buildBaseFields(ctx),
          footer: { text: 'Fixtronix System' },
          timestamp: new Date().toISOString(),
        },
      ],
    });
  }

  async sendReparationPaused(di: any) {

    const ctx = await this.buildContext(di);
    const note = di?.remarque_tech_repair;
    await this.postEmbed('GENERAL_ATELIER', {
      embeds: [
        {
          title: '⏸️ Réparation en pause',
          description: 'Le technicien a mis la réparation en pause.',
          color: 9807270,
          fields: this.buildBaseFields(
            ctx,
            undefined,
            note ? [{ name: '📝 Note', value: note }] : [],
          ),
          footer: { text: 'Fixtronix System' },
          timestamp: new Date().toISOString(),
        },
      ],
    });
  }

  async sendReparationResumed(di: any) {

    const ctx = await this.buildContext(di);
    await this.postEmbed('GENERAL_ATELIER', {
      embeds: [
        {
          title: '▶️ Réparation reprise',
          description: 'Le technicien a repris la réparation.',
          color: 15105570,
          fields: this.buildBaseFields(ctx),
          footer: { text: 'Fixtronix System' },
          timestamp: new Date().toISOString(),
        },
      ],
    });
  }

  async sendDiNegotiation1(di: any) {
    const ctx = await this.buildContext(di);
    await this.postEmbed('GENERAL_ATELIER', {
      embeds: [
        {
          title: '🤝 Négociation démarrée (Manager)',
          description: 'La DI est entrée dans le premier tour de négociation (Manager).',
          color: 15418782,
          fields: this.buildBaseFields(ctx, undefined, [
            {
              name: '💵 Prix initial',
              value: di?.price ? `${di.price} TND` : 'N/A',
              inline: true,
            },
          ]),
          footer: { text: 'Fixtronix System' },
          timestamp: new Date().toISOString(),
        },
      ],
    });
  }

  async sendDiNegotiation2(di: any) {
    const ctx = await this.buildContext(di);
    await this.postEmbed('GENERAL_ATELIER', {
      embeds: [
        {
          title: '🤝 Négociation escaladée (Admin Manager)',
          description: 'Négociation escaladée vers l\'Admin Manager.',
          color: 15418782,
          fields: this.buildBaseFields(ctx, undefined, [
            {
              name: '💵 Prix initial',
              value: di?.price ? `${di.price} TND` : 'N/A',
              inline: true,
            },
            {
              name: '💵 Prix final',
              value: di?.final_price ? `${di.final_price} TND` : 'N/A',
              inline: true,
            },
          ]),
          footer: { text: 'Fixtronix System' },
          timestamp: new Date().toISOString(),
        },
      ],
    });
  }

  async sendDiCancelled(di: any) {
    const ctx = await this.buildContext(di);
    await this.postEmbed('GENERAL_ATELIER', {
      embeds: [
        {
          title: '❌ DI annulée',
          description: 'La DI a été annulée pendant la négociation.',
          color: 15158332,
          fields: this.buildBaseFields(ctx),
          footer: { text: 'Fixtronix System' },
          timestamp: new Date().toISOString(),
        },
      ],
    });
  }

  async sendDiAbandoned(di: any, motif: string) {
    const ctx = await this.buildContext(di);
    await this.postEmbed('GENERAL_ATELIER', {
      embeds: [
        {
          title: '🚫 Diagnostic abandonné',
          description: `Un technicien a abandonné le diagnostic — motif : ${motif}. DI renvoyée à la coordination (PENDING1) pour réaffectation.`,
          color: 15105570,
          fields: this.buildBaseFields(ctx),
          footer: { text: 'Fixtronix System' },
          timestamp: new Date().toISOString(),
        },
      ],
    });
  }

  async sendDiRetour(di: any, level: 1 | 2 | 3) {
    // Technicien du cycle QUI REVIENT (niveau - 1) : la ligne Stat du nouveau
    // cycle n'existe pas encore au moment du retour.
    const ctx = await this.buildContext(di, { cycle: level - 1 });
    const titles = {
      1: '🔁 Retour 1',
      2: '🔁 Retour 2',
      3: '⚠️ Retour 3 — Alerte finale',
    };
    const colors = { 1: 15844367, 2: 15105570, 3: 15158332 } as const;
    const descriptions = {
      1: 'DI retournée pour la première fois.',
      2: 'DI retournée une seconde fois.',
      3: 'La DI a atteint le niveau de retour final. Attention opérationnelle requise.',
    };
    // Notification CONSERVÉE → envoi direct (contourne le gate de postEmbed).
    await this.deliverEmbed('GENERAL_ATELIER', {
      embeds: [
        {
          title: titles[level],
          description: descriptions[level],
          color: colors[level],
          fields: this.buildBaseFields(ctx, undefined, [
            {
              name: '🚫 Nombre d\'ignorances',
              value: `${di?.ignoreCount ?? 0}/3`,
              inline: true,
            },
          ]),
          footer: { text: 'Fixtronix System' },
          timestamp: new Date().toISOString(),
        },
      ],
    });
  }

  async sendDiBLUploaded({ di, fileName }: { di: any; fileName: string }) {
    const ctx = await this.buildContext(di);
    await this.postEmbed('GENERAL_ATELIER', {
      embeds: [
        {
          title: '📦 Bon de livraison ajouté',
          description: 'Un bon de livraison (BL) a été ajouté.',
          color: 3447003,
          fields: this.buildBaseFields(ctx, undefined, [
            { name: '📎 Fichier', value: fileName },
          ]),
          footer: { text: 'Fixtronix System' },
          timestamp: new Date().toISOString(),
        },
      ],
    });
  }

  /**
   * Operational error — generic structured-failure notification used by
   * OperationalErrorService. Reuses the existing webhook (no new infra)
   * and the same axios.post pattern as every other embed.
   *
   * Failure of THIS method is the caller's problem to swallow — the
   * OperationalErrorService wraps the call in try/catch so a flaky
   * webhook can never cascade.
   */
  async sendOperationalError(entry: {
    timestamp: string;
    module: string;
    submodule: string;
    method: string;
    severity: string;
    error: string;
    message: string;
    payload?: Record<string, any>;
  }) {
    const severityColor: Record<string, number> = {
      CRITICAL: 15158332, // red
      HIGH: 15158332, // red
      MEDIUM: 16289308, // orange
      LOW: 10070709, // grey
    };
    const severityEmoji: Record<string, string> = {
      CRITICAL: '🛑',
      HIGH: '🚨',
      MEDIUM: '⚠️',
      LOW: 'ℹ️',
    };

    // Keep payload compact for the embed — full payload is in the daily
    // log file. Discord rejects fields > 1024 chars.
    let payloadPreview = '_(vide)_';
    if (entry.payload && Object.keys(entry.payload).length) {
      const json = JSON.stringify(entry.payload, null, 0);
      payloadPreview = '```json\n' + (json.length > 800 ? json.slice(0, 797) + '...' : json) + '\n```';
    }

    // HORS GATE (`deliverEmbed`) : le gate visait le BRUIT du flux DI, pas le
    // canal d'ALERTE. Passé par `postEmbed`, il était coupé lui aussi — les
    // pannes opérationnelles n'étaient alors plus visibles QUE dans
    // `logs/YYYY-MM/errors-*.log`, un fichier que personne ne surveille. Même
    // traitement que les alertes de sauvegarde BDD.
    await this.deliverEmbed('ERROR', {
      embeds: [
        {
          title: `${severityEmoji[entry.severity] ?? '⚠️'} FIXTRONIX · Erreur opérationnelle`,
          description: entry.error,
          color: severityColor[entry.severity] ?? severityColor.MEDIUM,
          fields: [
            { name: '🧩 Module', value: `\`${entry.module}/${entry.submodule}\``, inline: true },
            { name: '🛠 Méthode', value: `\`${entry.method}\``, inline: true },
            { name: '🎚 Gravité', value: entry.severity, inline: true },
            { name: '💬 Message', value: entry.message?.slice(0, 1000) || '_(aucun message)_' },
            { name: '📦 Données', value: payloadPreview },
          ],
          footer: { text: "Fixtronix · Capture d'erreur" },
          timestamp: entry.timestamp,
        },
      ],
    });
  }

  /**
   * Validation-failure notification → a SEPARATE webhook
   * (`DISCORD_VALIDATION_WEBHOOK_URL`), kept OFF the critical operational
   * channel. Dev-only drift visibility. Contains ONLY field+rule messages —
   * never the submitted values / PII. Gating + dedup live in
   * OperationalErrorService.captureValidation().
   */
  async sendValidationError(entry: {
    operation: string;
    env: string;
    correlationId: string;
    messages: { message: string; drift: boolean }[];
    suppressed?: number;
  }) {
    // Legacy dev-only channel; separate from the 5 channel-migration URLs.
    // Off in prod (DISCORD_NOTIFY_VALIDATION=false). Skip silently if no
    // URL configured so a missing var never breaks the drift-watch path.
    const url = process.env.DISCORD_VALIDATION_WEBHOOK_URL;
    if (!url) {
      this.logger.warn(
        'DISCORD_VALIDATION_WEBHOOK_URL not set → validation error not sent',
      );
      return;
    }
    const hasDrift = entry.messages.some((m) => m.drift);
    const lines = entry.messages
      .map((m) => `${m.drift ? '⚠ ' : '• '}${m.message}`)
      .join('\n')
      .slice(0, 1000);
    const description =
      (hasDrift ? '⚠ **Drift front↔back probable**\n' : '') +
      (entry.suppressed
        ? `_(+${entry.suppressed} occurrence(s) regroupée(s) depuis le dernier envoi)_`
        : '');

    await axios.post(url, {
      embeds: [
        {
          title: `🧪 Validation échouée · ${entry.operation}`,
          description: description || undefined,
          color: 16289308, // orange
          fields: [
            { name: '🌐 Env', value: `\`${entry.env}\``, inline: true },
            {
              name: '🔗 Correlation',
              value: `\`${entry.correlationId}\``,
              inline: true,
            },
            { name: '📋 Messages', value: lines || '_(aucun)_' },
          ],
          footer: { text: 'Fixtronix · Validation drift watch (dev)' },
        },
      ],
    });
  }

  /**
   * BACKUP_DB_TO_DRIVE — nightly database backup SUCCEEDED.
   *
   * ⚠️ Goes through `deliverEmbed` (NOT `postEmbed`) on purpose: the global
   * `DISCORD_NOTIFS_DISABLED` gate would swallow it, and a backup channel that
   * is silent by design defeats its own purpose. The whole point of the daily
   * success line is that its ABSENCE is the alarm — so it must never be gated.
   */
  /**
   * Digest quotidien de complétude documentaire DiArchive.
   *
   * HORS GATE (`deliverEmbed`) : ce digest n'a AUCUN autre canal — ni cloche ni
   * journal. Passé par `postEmbed`, le cron de 08 h interrogeait la base,
   * calculait tout et ne publiait rien.
   *
   * Sender TYPÉ : l'appelant passait `postEmbed` en direct, seul endroit du
   * dépôt à dépendre de ce détail d'implémentation.
   */
  async sendDiArchiveDigest(description: string): Promise<void> {
    await this.deliverEmbed('APP_ALERT', {
      embeds: [
        {
          title: '📊 FIXTRONIX · Suivi documentaire DiArchive',
          description,
          color: 16289308, // amber — constant across cases per user spec
          footer: { text: 'Fixtronix · Digest quotidien' },
          timestamp: new Date().toISOString(),
        },
      ],
    });
  }

  async sendDbBackupSuccess(info: {
    fileName: string;
    dbName: string;
    sizeBytes: number;
    durationMs: number;
    folderName: string;
    webViewLink?: string;
    deleted?: number;
    kept?: number;
    env?: string;
  }): Promise<void> {
    const envUpper = (info.env || process.env.NODE_ENV || 'development')
      .trim()
      .toUpperCase();
    const when = new Intl.DateTimeFormat('fr-FR', {
      timeZone: process.env.APP_TIMEZONE || 'Africa/Tunis',
      dateStyle: 'short',
      timeStyle: 'short',
    }).format(new Date());

    await this.deliverEmbed('APP_ALERT', {
      embeds: [
        {
          title: `💾 Sauvegarde BDD OK — [${envUpper}]`,
          description:
            `Base \`${info.dbName}\` sauvegardée sur Google Drive · ${when} (Africa/Tunis).` +
            (info.webViewLink ? `\n[Ouvrir le fichier](${info.webViewLink})` : ''),
          color: 3066993, // green
          fields: [
            { name: '📄 Fichier', value: info.fileName, inline: false },
            {
              name: '📦 Taille',
              value: formatBytes(info.sizeBytes),
              inline: true,
            },
            {
              name: '⏱️ Durée',
              value: `${(info.durationMs / 1000).toFixed(1)} s`,
              inline: true,
            },
            { name: '📁 Dossier', value: info.folderName, inline: true },
            ...(typeof info.deleted === 'number'
              ? [
                  {
                    name: '🧹 Rétention',
                    value: `${info.kept ?? '?'} conservé(s), ${info.deleted} supprimé(s)`,
                    inline: false,
                  },
                ]
              : []),
          ],
          footer: { text: 'Fixtronix · Sauvegarde quotidienne' },
          timestamp: new Date().toISOString(),
        },
      ],
    });
  }

  /**
   * BACKUP_DB_TO_DRIVE — nightly database backup FAILED. Same ungated
   * `deliverEmbed` path as the success line: a backup that fails silently is
   * strictly worse than no backup at all.
   */
  async sendDbBackupFailure(info: {
    reason: string;
    dbName?: string;
    step?: string;
    env?: string;
  }): Promise<void> {
    const envUpper = (info.env || process.env.NODE_ENV || 'development')
      .trim()
      .toUpperCase();
    const when = new Intl.DateTimeFormat('fr-FR', {
      timeZone: process.env.APP_TIMEZONE || 'Africa/Tunis',
      dateStyle: 'short',
      timeStyle: 'short',
    }).format(new Date());

    await this.deliverEmbed('APP_ALERT', {
      embeds: [
        {
          title: `🚨 ÉCHEC sauvegarde BDD — [${envUpper}]`,
          description:
            `**Aucune sauvegarde n'a été produite ce soir.** Intervention requise · ${when} (Africa/Tunis).`,
          color: 15158332, // red
          fields: [
            {
              name: '🗄️ Base',
              value: info.dbName || 'inconnue',
              inline: true,
            },
            { name: '🔧 Étape', value: info.step || 'inconnue', inline: true },
            {
              name: '❌ Motif',
              // Discord hard-caps a field value at 1024 chars.
              value: (info.reason || 'inconnu').slice(0, 1024),
              inline: false,
            },
          ],
          footer: { text: 'Fixtronix · Sauvegarde quotidienne' },
          timestamp: new Date().toISOString(),
        },
      ],
    });
  }

  /**
   * Operational stagnation alert. Reads everything from the persisted
   * alert document — no Di / Profile / Company lookups needed, so this
   * works inside the ACTION runtime with the same fidelity as the
   * realtime app.
   */
  async sendStagnationAlert(alert: {
    _id: string;
    diId: string;
    type: string;
    severity: string;
    message: string;
    metadata?: Record<string, any>;
    createdAt?: Date;
  }) {
    const meta = alert.metadata ?? {};
    const ageHours =
      typeof meta.ageMs === 'number'
        ? Math.round(meta.ageMs / (60 * 60 * 1000))
        : null;
    const statusLabel = meta.status
      ? STATUS_LABELS[meta.status] ?? meta.status
      : 'unknown';
    const severityColor: Record<string, number> = {
      CRITICAL: 15158332, // red
      WARNING: 16289308, // orange
      INFO: 3447003, // blue
    };
    const severityEmoji: Record<string, string> = {
      CRITICAL: '🚨',
      WARNING: '⚠️',
      INFO: 'ℹ️',
    };

    await this.deliverEmbed('APP_ALERT', {
      embeds: [
        {
          title: `${severityEmoji[alert.severity] ?? '⚠️'} FIXTRONIX · Alerte opérationnelle`,
          description:
            'Cette DI est restée trop longtemps dans le même statut et nécessite une revue opérationnelle.',
          color: severityColor[alert.severity] ?? severityColor.WARNING,
          fields: [
            { name: '🧾 DI', value: String(meta.diIdnum ?? alert.diId), inline: true },
            { name: '📌 Statut', value: statusLabel, inline: true },
            { name: '🎚 Gravité', value: alert.severity, inline: true },
            {
              name: '⏱ Durée de stagnation',
              value: ageHours !== null ? `${ageHours}h` : 'n/a',
              inline: true,
            },
            { name: '🪧 Seuil', value: alert.type, inline: true },
            {
              name: '🆔 Alerte',
              value: alert._id,
              inline: true,
            },
          ],
          footer: { text: 'Fixtronix · Opérations' },
          timestamp: (alert.createdAt ?? new Date()).toISOString
            ? (alert.createdAt as Date).toISOString()
            : new Date().toISOString(),
        },
      ],
    });
  }

  /**
   * Daily grouped stagnation reminder — ONE embed summarizing the currently
   * stagnant DIs by age band (24h / 72h / >7j). Replaces the per-DI ping
   * (stagnation alerts are now created `silent`); fired by the 08:00
   * Africa/Tunis cron. Best-effort like the other DI notifications — routes
   * through `postEmbed` (APP_ALERT), which logs + skips on a missing/failed hook.
   */
  async sendStagnationDigest(digest: {
    total: number;
    buckets: Array<{
      label: string;
      severity: string;
      count: number;
      examples: string[];
    }>;
    generatedAt?: Date;
  }): Promise<void> {
    const severityColor: Record<string, number> = {
      CRITICAL: 15158332, // red
      WARNING: 16289308, // orange
      INFO: 3447003, // blue
    };
    const severityEmoji: Record<string, string> = {
      CRITICAL: '🔴',
      WARNING: '🟠',
      INFO: '🟡',
    };
    // Embed color follows the worst severity that actually has DIs in it.
    const rank: Record<string, number> = { INFO: 0, WARNING: 1, CRITICAL: 2 };
    const worst = digest.buckets
      .filter((b) => b.count > 0)
      .reduce(
        (acc, b) =>
          (rank[b.severity] ?? 0) > (rank[acc] ?? 0) ? b.severity : acc,
        'INFO',
      );

    const when = new Intl.DateTimeFormat('fr-FR', {
      timeZone: 'Africa/Tunis',
      dateStyle: 'short',
      timeStyle: 'short',
    }).format(digest.generatedAt ?? new Date());

    const fields = digest.buckets.map((b) => ({
      name: `${severityEmoji[b.severity] ?? '•'} ${b.label} — ${b.count}`,
      value: b.count
        ? (
            b.examples.map((ref) => `• ${ref}`).join('\n') +
            (b.count > b.examples.length
              ? `\n… +${b.count - b.examples.length} autre(s)`
              : '')
          ).slice(0, 1024)
        : '_aucune_',
    }));

    await this.deliverEmbed('APP_ALERT', {
      embeds: [
        {
          title: '📊 Rappel quotidien — DI stagnantes',
          description: `${digest.total} DI en attente, regroupées par ancienneté · ${when} (Africa/Tunis).`,
          color: severityColor[worst] ?? severityColor.INFO,
          fields,
          footer: { text: 'Fixtronix · Rappel stagnation' },
          timestamp: (digest.generatedAt ?? new Date()).toISOString(),
        },
      ],
    });
  }

  /**
   * Rappel quotidien des DI STAGNANTES (≥ seuil) — feuille du jour générée.
   * UNE seule embed vers `fixtronix-app-alert` via le chemin NON-gated
   * `deliverEmbed` (comme le digest Jira/stagnation), donc NON impacté par
   * `DISCORD_NOTIFS_DISABLED` — que l'on NE modifie pas.
   */
  async sendDailyStagnationReminder(report: {
    date: string; // YYYY-MM-DD (worksheet name)
    count: number;
    seuil: number;
    unite: string;
    examples: string[]; // _idNum refs (up to ~8)
    spreadsheetUrl?: string; // lien PROFOND vers l'onglet du jour (gid)
  }): Promise<void> {
    const when = new Intl.DateTimeFormat('fr-FR', {
      timeZone: 'Africa/Tunis',
      dateStyle: 'short',
      timeStyle: 'short',
    }).format(new Date());
    // Lien cliquable vers la feuille du jour — titre + ligne « Détails ».
    const link = report.spreadsheetUrl
      ? `\n🔗 [Ouvrir la feuille « ${report.date} »](${report.spreadsheetUrl})`
      : '';
    await this.deliverEmbed('APP_ALERT', {
      embeds: [
        {
          title: '⏳ Rappel quotidien — DI stagnantes',
          ...(report.spreadsheetUrl ? { url: report.spreadsheetUrl } : {}),
          description:
            `${report.count} DI stagnante(s) dans le même statut depuis ≥ ${report.seuil} ${report.unite}.\n` +
            `Feuille du jour : \`${report.date}\` · ${when} (Africa/Tunis).` +
            link,
          color: 16289308, // orange (WARNING)
          fields: report.examples.length
            ? [
                {
                  name: `Exemples (${report.examples.length})`,
                  value: report.examples.map((r) => `• ${r}`).join('\n'),
                },
              ]
            : [],
          footer: { text: 'Fixtronix · Rappel stagnation quotidien' },
          timestamp: new Date().toISOString(),
        },
      ],
    });
  }

  /**
   * Rappel matinal du magasin — 08:00 Africa/Tunis, lun–ven. UN embed qui
   * reprend les deux sujets : le stock bas (§1) et les fiches dont un champ clé
   * est vide (§2). Chaque bloc n'apparaît que s'il a quelque chose à dire, et
   * l'appelant ne poste rien quand tout est propre.
   *
   * Passe par `deliverEmbed` — PAS `postEmbed` — pour contourner
   * `DISCORD_NOTIFS_DISABLED`, comme retour et stagnation : c'est un rappel
   * quotidien demandé explicitement, il ne doit pas tomber dans la vanne.
   */
  async sendMagasinStockReminder(report: {
    threshold: number;
    rupture: { count: number; examples: string };
    low: { count: number; examples: string };
    incomplete: {
      affected: number;
      status: number;
      price: number;
      qty: number;
      examples: string;
    };
  }): Promise<void> {
    const when = new Intl.DateTimeFormat('fr-FR', {
      timeZone: 'Africa/Tunis',
      dateStyle: 'short',
      timeStyle: 'short',
    }).format(new Date());

    const fields: Array<{ name: string; value: string }> = [];
    if (report.rupture.count) {
      fields.push({
        name: `\u{1F534} Rupture (${report.rupture.count})`,
        value: report.rupture.examples || '—',
      });
    }
    if (report.low.count) {
      fields.push({
        name: `\u{1F7E0} Bientôt vide \u2264${report.threshold} (${report.low.count})`,
        value: report.low.examples || '—',
      });
    }
    if (report.incomplete.affected) {
      fields.push({
        name: `\u{1F4DD} Fiches à compléter (${report.incomplete.affected})`,
        value:
          `Statut : ${report.incomplete.status} · Prix : ${report.incomplete.price} · ` +
          `Quantité : ${report.incomplete.qty}\n` +
          (report.incomplete.examples || '—'),
      });
    }

    const summary = report.incomplete.affected
      ? `Une fiche au statut vide n'est ni décrémentée ni surveillée : la compléter la fait entrer dans le suivi de stock.`
      : `Stock à réapprovisionner.`;

    await this.deliverEmbed(STOCK_REMINDER_CHANNEL, {
      embeds: [
        {
          title: '\u{1F4E6} Rappel matinal — stock magasin',
          description: `${summary}\n${when} (Africa/Tunis).`,
          color: 16289308, // orange (WARNING)
          fields,
          footer: { text: 'Fixtronix · Rappel stock magasin' },
          timestamp: new Date().toISOString(),
        },
      ],
    });
  }

  /**
   * Catalog event — a NEW composant was added to the parts catalog (NOT an
   * update). Useful for procurement / admin visibility: who added what, at
   * what price, in what category. Routes through the DI events webhook to
   * keep the critical-ops channel quiet. Author is taken from the JWT via the
   * resolver's `@CurrentUser`; rare missing-author case shows "Auteur inconnu".
   */
  async sendComposantCreated({
    composant,
    profile,
    categoryName,
  }: {
    composant: any;
    profile?: any;
    categoryName?: string;
  }) {

    const author = await this.resolveProfileDisplay(profile);
    const role = profile?.role ? ` · ${profile.role}` : '';
    const priceLine = (v: any) =>
      Number.isFinite(Number(v))
        ? `${Number(v).toLocaleString('fr-TN', { minimumFractionDigits: 3, maximumFractionDigits: 3 })} TND`
        : '—';
    await this.postEmbed('GENERAL_ATELIER', {
      embeds: [
        {
          title: '🧩 Nouveau composant catalogue',
          description: `Le composant **${composant?.name ?? '—'}** a été ajouté au catalogue.`,
          color: 3066993, // green — non-critical informational
          fields: [
            {
              name: '👤 Auteur',
              value: `${author}${role}`,
              inline: true,
            },
            {
              name: '🏷️ Catégorie',
              value: categoryName || composant?.category_composant_id || '—',
              inline: true,
            },
            {
              name: '📦 Package',
              value: composant?.package || '—',
              inline: true,
            },
            {
              name: '💵 Prix achat',
              value: priceLine(composant?.prix_achat),
              inline: true,
            },
            {
              name: '💰 Prix vente',
              value: priceLine(composant?.prix_vente),
              inline: true,
            },
            {
              name: '📊 Stock',
              value: String(composant?.quantity_stocked ?? 0),
              inline: true,
            },
          ],
          footer: { text: 'Fixtronix · Catalogue' },
          timestamp: new Date().toISOString(),
        },
      ],
    });
  }

  /**
   * DI flow event — a technician was assigned to REPARATION (the diagnostic
   * counterpart `sendDiagnosticAssigned` already exists). Surfaces the tech
   * load, who assigned, and the current DI status so the on-call coordinator
   * can react quickly. Routes through the DI events webhook.
   */
  async sendReparationAssigned({
    di,
    technician,
    assignedBy,
    activeDiCount,
  }: {
    di: any;
    technician: any;
    assignedBy?: any;
    activeDiCount?: number;
  }) {

    // Technicien réparation + affecteur passés en surcharge : ils alimentent les
    // champs standards « 👨‍🔧 Technicien » et « 🙋 Action par ».
    const ctx = await this.buildContext(di, {
      tech: { rep: technician },
      actor: assignedBy,
    });
    const extras: Array<{ name: string; value: string; inline?: boolean }> = [];
    if (Number.isFinite(activeDiCount)) {
      extras.push({
        name: '📋 DI actifs (tech)',
        value: String(activeDiCount),
        inline: true,
      });
    }
    await this.postEmbed('GENERAL_ATELIER', {
      embeds: [
        {
          title: '🛠️ Réparation affectée',
          description: 'Le coordinateur a affecté ce DI à un technicien réparation.',
          color: 15105570, // orange
          fields: this.buildBaseFields(ctx, undefined, extras),
          footer: { text: 'Fixtronix System' },
          timestamp: new Date().toISOString(),
        },
      ],
    });
  }

  /**
   * Procès-Verbal de Réunion — fired after a PV is persisted (Retour or
   * standalone flow). Routes to `pvWebhookUrl` (env DISCORD_PV_WEBHOOK_URL,
   * fallback to the critical channel). Best-effort: any failure here is
   * swallowed by the caller (ReunionPvService) so a flaky webhook never
   * blocks the meeting record.
   */
  async sendReunionPvCreated({
    pv,
    di,
    profile,
  }: {
    pv: any;
    di?: any;
    profile?: any;
  }) {
    const authorName = profile
      ? `${profile.firstName ?? ''} ${profile.lastName ?? ''}`.trim() ||
        profile.username ||
        'Utilisateur'
      : 'Utilisateur';
    const fields: Array<{ name: string; value: string; inline?: boolean }> = [
      { name: '🆔 Référence', value: pv?.reference ?? 'N/A', inline: true },
      { name: '📝 Titre', value: String(pv?.titre ?? 'N/A').slice(0, 256) },
      { name: '👤 Créé par', value: authorName, inline: true },
      {
        name: '📅 Date réunion',
        value: pv?.dateReunion
          ? new Date(pv.dateReunion).toISOString().slice(0, 10)
          : 'N/A',
        inline: true,
      },
    ];
    if (pv?.prochaineReunion) {
      fields.push({
        name: '📆 Prochaine réunion',
        value: this.formatReunionDateTime(pv.prochaineReunion),
        inline: true,
      });
    }
    if (di?._idnum) {
      fields.push({ name: '🔗 DI liée', value: String(di._idnum), inline: true });
    }
    if (pv?.contexteRetour?.niveau) {
      fields.push({
        name: '🔁 Niveau Retour',
        value: String(pv.contexteRetour.niveau),
        inline: true,
      });
    }
    // Personnes concernées — resolve participant profile ids to display names.
    const participantsLine = await this.resolveParticipantsLine(
      pv?.participants,
    );
    if (participantsLine) {
      fields.push({ name: '👥 Participants', value: participantsLine });
    }
    await this.postEmbed('GENERAL_ATELIER', {
      embeds: [
        {
          title: '📄 Procès-Verbal de Réunion',
          description: 'Un PV de réunion vient d\'être enregistré.',
          color: 3447003, // blue
          fields,
          footer: { text: 'Fixtronix System' },
          timestamp: new Date().toISOString(),
        },
      ],
    });
  }

  /** Africa/Tunis date+time for meeting embeds (reminder needs the hour). */
  private formatReunionDateTime(value: any): string {
    if (!value) return 'N/A';
    const d = new Date(value);
    if (isNaN(d.getTime())) return 'N/A';
    return new Intl.DateTimeFormat('fr-FR', {
      timeZone: 'Africa/Tunis',
      dateStyle: 'short',
      timeStyle: 'short',
    }).format(d);
  }

  /** "Alice Martin (Présent) · Bob Durand (Excusé)" — resolved, capped for the
   *  Discord 1024-char field. Empty string when there are no participants. */
  private async resolveParticipantsLine(participants: any[]): Promise<string> {
    const list = Array.isArray(participants) ? participants : [];
    if (!list.length) return '';
    const statutLabel: Record<string, string> = {
      PRESENT: 'Présent',
      ABSENT: 'Absent',
      EXCUSE: 'Excusé',
    };
    const names = await Promise.all(
      list.slice(0, 30).map(async (p) => {
        const name = await this.resolveProfileDisplay(p?.profile ?? p);
        const st = statutLabel[p?.statut] ? ` (${statutLabel[p.statut]})` : '';
        return `${name}${st}`;
      }),
    );
    return names.join(' · ').slice(0, 1024);
  }

  /**
   * Procès-Verbal reminder — fired by the REUNION_REMINDER cron ~5 min before a
   * meeting starts. Best-effort (routes through `postEmbed` → SERVICE_TECHNIQUE,
   * logs+skips on a missing/failed hook). `url` (when APP_BASE_URL is set) makes
   * the embed title clickable and opens the detail modal to document the meeting.
   */
  async sendReunionReminder({
    pv,
    url,
  }: {
    pv: any;
    url?: string | null;
  }): Promise<void> {
    const fields: Array<{ name: string; value: string; inline?: boolean }> = [
      { name: '🆔 Référence', value: pv?.reference ?? 'N/A', inline: true },
      { name: '📝 Titre', value: String(pv?.titre ?? 'N/A').slice(0, 256) },
      {
        name: '🕐 Heure (Africa/Tunis)',
        value: this.formatReunionDateTime(pv?.dateReunion),
        inline: true,
      },
    ];
    if (pv?.objet) {
      fields.push({ name: '🎯 Objet', value: String(pv.objet).slice(0, 1024) });
    }
    const participantsLine = await this.resolveParticipantsLine(
      pv?.participants,
    );
    if (participantsLine) {
      fields.push({ name: '👥 Participants', value: participantsLine });
    }
    if (url) {
      fields.push({ name: '🔗 Documenter', value: `[Ouvrir la réunion](${url})` });
    }
    await this.postEmbed('GENERAL_ATELIER', {
      embeds: [
        {
          title: '⏰ Rappel — réunion dans ~5 min',
          ...(url ? { url } : {}),
          description:
            'La réunion va commencer. Ouvrez-la pour documenter (ordre du jour, décisions, actions…).',
          color: 16763904, // amber
          fields,
          footer: { text: 'Fixtronix · Rappel réunion' },
          timestamp: new Date().toISOString(),
        },
      ],
    });
  }

  /**
   * Grouped "Jira tasks due soon" digest — ONE embed, one field per
   * `responsable` (section), listing `[issueKey](url) — titre (échéance)` with
   * the échéance rendered in Africa/Tunis. Used by the SYNC_JIRA_DUE_SOON cron
   * which reads PENDING JiraCronNotification rows (it no longer hits Jira).
   *
   * Unlike the best-effort DI notifications, this **throws** on a missing
   * webhook or an HTTP failure so the caller can revert the claimed rows to
   * PENDING (nothing is silently lost).
   */
  async sendJiraTasksDigest(
    items: Array<{
      issueKey: string;
      titre?: string;
      responsable?: string | null;
      echeance?: Date | string | null;
      url?: string;
    }>,
  ): Promise<void> {
    // DEDICATED APP_ALERT channel only — NO legacy fallback. Resolve + guard
    // here (not via the best-effort `postEmbed`) so a missing URL or an HTTP
    // failure THROWS: the SYNC_JIRA_DUE_SOON caller reverts the claimed rows to
    // PENDING instead of marking them PROCESSED with nothing delivered.
    const url = this.urlFor('APP_ALERT');
    if (!url) {
      throw new Error('Discord APP_ALERT webhook not configured');
    }

    // Section by responsable (null/empty → "Non assigné").
    const groups = new Map<string, typeof items>();
    for (const it of items) {
      const key = (it.responsable ?? '').trim() || 'Non assigné';
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(it);
    }

    const fmtEcheance = (d?: Date | string | null): string =>
      d
        ? new Date(d).toLocaleDateString('fr-FR', { timeZone: 'Africa/Tunis' })
        : 'N/A';

    // Discord limits: ≤25 fields, field value ≤1024 chars.
    const fields = [...groups.entries()].slice(0, 25).map(([resp, tasks]) => ({
      name: `👤 ${resp}`.slice(0, 256),
      value: tasks
        .map(
          (t) =>
            `• [${t.issueKey}](${t.url ?? ''}) — ${String(t.titre ?? '').slice(
              0,
              120,
            )} _(échéance ${fmtEcheance(t.echeance)})_`,
        )
        .join('\n')
        .slice(0, 1024),
    }));

    await axios.post(url, {
      embeds: [
        {
          title: '⏰ Tâches Jira proches échéance',
          description: `${items.length} tâche(s) à traiter, regroupée(s) par responsable.`,
          color: 16763904, // amber
          fields,
          footer: { text: 'Fixtronix System' },
          timestamp: new Date().toISOString(),
        },
      ],
    });
  }
}
