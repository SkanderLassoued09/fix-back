import { Injectable, Logger } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import axios from 'axios';
import { Client } from 'src/clients/entities/client.entity';
import { Company } from 'src/company/entities/company.entity';
import { Profile } from 'src/profile/entities/profile.entity';

/**
 * Channels — each `sendXxx` posts through `postEmbed(channel, payload)`.
 * Every env file (`.env.{development,preprod,production}`) declares one
 * webhook URL per channel; a missing one is logged ONCE and the post is
 * silently skipped (never throws) so a partial config can't cascade a
 * failure through a DI-create call.
 */
type ChannelKey =
  | 'GENERAL_ATELIER'
  | 'SERVICE_TECHNIQUE'
  | 'DEMANDE_PDF'
  | 'ERROR'
  | 'APP_ALERT';

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
  INMAGASIN: '🏬 En magasin',
  PENDING2: '📦 En attente de facturation',
  PRICING: '💰 Facturation en cours',
  NEGOTIATION1: '🤝 Négociation 1 (Manager)',
  NEGOTIATION2: '🤝 Négociation 2 (Admin)',
  ANNULER: '❌ Annulée',
  PENDING3: '🚚 En attente réparation',
  REPARATION: '🛠️ Réparation affectée',
  REPARATION_Pause: '⏸️ Réparation en pause',
  INREPARATION: '🔧 En réparation',
  FINISHED: '✅ Terminée',
  RETOUR1: '🔁 Retour 1',
  RETOUR2: '🔁 Retour 2',
  RETOUR3: '⚠️ Retour 3',
};

interface EmbedContext {
  idnum: string;
  title: string;
  clientName: string;
  companyName: string;
  customerLabel: string; // company if present, otherwise client
  customerFieldName: string; // '🏢 Company' or '👤 Client'
  statusLabel: string;
}

/**
 * 🔕 INTERRUPTEUR TEMPORAIRE DES NOTIFICATIONS DISCORD.
 *
 * `true` → seules RETOUR (1/2/3) et STAGNATION DI sont émises ; tous les autres
 * types (pending, assigned, pricing, finished, diagnostic, réparation, PV,
 * digest DiArchive…) sont coupés à la source via le gate de `postEmbed`. Aucune
 * donnée n'est supprimée ; les émetteurs restent dans le code.
 *
 * ▶️ POUR TOUT RÉACTIVER : repasser cette constante à `false` (une seule ligne).
 */
const DISCORD_NOTIFS_DISABLED = true;

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
    // 🔕 GATE TEMPORAIRE — Discord réduit à RETOUR (1/2/3) + STAGNATION.
    // Toutes les autres notifications (~28 types + le digest DiArchive externe)
    // passent par ici et sont donc coupées À LA SOURCE. Retour & stagnation
    // appellent `deliverEmbed` directement pour NE PAS être gated.
    // ▶️ Pour tout réactiver : passer DISCORD_NOTIFS_DISABLED à false.
    if (DISCORD_NOTIFS_DISABLED) {
      return;
    }
    return this.deliverEmbed(channel, payload);
  }

  /** Envoi bas-niveau réel vers le webhook Discord (sans gate). Utilisé
   *  directement par les seules notifications conservées (retour + stagnation)
   *  et par `postEmbed` quand le gate est ouvert. */
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
      await axios.post(url, payload);
    } catch (err) {
      this.logger.warn(
        `Discord post to "${channel}" failed: ${(err as Error)?.message}`,
      );
    }
  }

  /** True when the Jira-digest channel (APP_ALERT) is reachable — lets
   *  the Jira-notify cron skip cleanly instead of claiming docs it can't
   *  deliver. Named for backwards compatibility with existing callers. */
  get isPvConfigured(): boolean {
    return !!this.urlFor('SERVICE_TECHNIQUE');
  }

  constructor(
    @InjectModel(Client.name) private readonly clientModel: Model<any>,
    @InjectModel(Company.name) private readonly companyModel: Model<any>,
    @InjectModel(Profile.name) private readonly profileModel: Model<any>,
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

  async buildContext(di: any): Promise<EmbedContext> {
    const idnum = di?._idnum || 'N/A';
    const title = di?.title || 'N/A';
    const [clientName, companyName] = await Promise.all([
      this.resolveClientName(di?.client_id),
      this.resolveCompanyName(di?.company_id),
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
    };
  }

  // Build the standard 4-field skeleton: DI Number, Title, Customer, Status.
  // Append extraFields after status for context-specific data.
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
      ...extraFields,
    ];
  }

  // ─────────────────────────────────────────────────────────────────────
  // Embed senders. Each one routes through buildContext so client,
  // company, technician and status are always resolved to display names.
  // ─────────────────────────────────────────────────────────────────────

  async sendDiPendingNotification(di: any) {
    const ctx = await this.buildContext(di);
    const createdBy = await this.resolveProfileDisplay(di?.createdBy);

    await this.postEmbed('GENERAL_ATELIER', {
      embeds: [
        {
          title: '📌 DI en attente',
          description: 'Une nouvelle DI a été créée et est en attente.',
          color: 16776960, // yellow (pending)
          fields: this.buildBaseFields(ctx, undefined, [
            { name: '🧑‍💼 Créée par', value: createdBy, inline: true },
          ]),
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
    const ctx = await this.buildContext({
      ...di,
      // The Stat carries the live status when DI hasn't been refetched yet.
      status: stat?.status || di?.status,
    });
    const techDisplay = await this.resolveProfileDisplay(technician);

    await this.postEmbed('SERVICE_TECHNIQUE', {
      embeds: [
        {
          title: '🛠️ DI affectée au technicien',
          description: 'Une DI a été affectée pour diagnostic.',
          color: 3447003, // blue
          fields: this.buildBaseFields(ctx, undefined, [
            { name: '👨‍🔧 Technicien', value: techDisplay, inline: true },
          ]),
          footer: { text: 'Fixtronix System' },
          timestamp: new Date().toISOString(),
        },
      ],
    });
  }

  async sendComponentsSentToCoordinator(di: any) {
    const ctx = await this.buildContext(di);
    await this.postEmbed('SERVICE_TECHNIQUE', {
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
    await this.postEmbed('SERVICE_TECHNIQUE', {
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
    await this.postEmbed('DEMANDE_PDF', {
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
    await this.postEmbed('DEMANDE_PDF', {
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

  async sendDiInReparation(di: any) {
    // Called when status is REPARATION — assigned but not yet started.
    const ctx = await this.buildContext(di);
    await this.postEmbed('SERVICE_TECHNIQUE', {
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
    await this.postEmbed('SERVICE_TECHNIQUE', {
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
    await this.postEmbed('SERVICE_TECHNIQUE', {
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
    await this.postEmbed('SERVICE_TECHNIQUE', {
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
    await this.postEmbed('SERVICE_TECHNIQUE', {
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
    const ctx = await this.buildContext(di);
    // Include the assigned diagnostic technician so this SINGLE notification is
    // complete (it replaces the old, duplicate `sendDiAssignedToTech`). Only add
    // the field when the tech resolves to a real name — never surface "N/A".
    const extras: Array<{ name: string; value: string; inline?: boolean }> = [];
    if (technician !== undefined && technician !== null) {
      const techDisplay = await this.resolveProfileDisplay(technician);
      if (techDisplay && techDisplay !== 'N/A') {
        extras.push({ name: '👨‍🔧 Technicien', value: techDisplay, inline: true });
      }
    }
    await this.postEmbed('SERVICE_TECHNIQUE', {
      embeds: [
        {
          title: '🧭 Diagnostic affecté',
          description: 'La coordinatrice a affecté cette DI au diagnostic.',
          color: 3447003,
          fields: this.buildBaseFields(ctx, undefined, extras),
          footer: { text: 'Fixtronix System' },
          timestamp: new Date().toISOString(),
        },
      ],
    });
  }

  async sendReparationStarted(di: any) {

    const ctx = await this.buildContext(di);
    await this.postEmbed('SERVICE_TECHNIQUE', {
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
    await this.postEmbed('SERVICE_TECHNIQUE', {
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
    await this.postEmbed('SERVICE_TECHNIQUE', {
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

  async sendDiRetour(di: any, level: 1 | 2 | 3) {
    const ctx = await this.buildContext(di);
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
    await this.postEmbed('DEMANDE_PDF', {
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

    await this.postEmbed('ERROR', {
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
    await this.postEmbed('SERVICE_TECHNIQUE', {
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

    const ctx = await this.buildContext(di);
    const techDisplay = await this.resolveProfileDisplay(technician);
    const assignerDisplay = await this.resolveProfileDisplay(assignedBy);
    const extras = [
      { name: '👨‍🔧 Technicien réparation', value: techDisplay, inline: true },
    ];
    if (assignerDisplay && assignerDisplay !== 'N/A') {
      extras.push({
        name: '🧑‍💼 Affecté par',
        value: assignerDisplay,
        inline: true,
      });
    }
    if (Number.isFinite(activeDiCount)) {
      extras.push({
        name: '📋 DI actifs (tech)',
        value: String(activeDiCount),
        inline: true,
      });
    }
    await this.postEmbed('SERVICE_TECHNIQUE', {
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
    await this.postEmbed('SERVICE_TECHNIQUE', {
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
    await this.postEmbed('SERVICE_TECHNIQUE', {
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
