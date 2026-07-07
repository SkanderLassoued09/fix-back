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
  CREATED: '🆕 Created',
  PENDING1: '🟡 Pending Diagnostic',
  DIAGNOSTIC: '🧭 Diagnostic Assigned',
  DIAGNOSTIC_Pause: '⏸️ Diagnostic Paused',
  INDIAGNOSTIC: '🔍 In Diagnostic',
  MagasinEstimation: '🏬 Magasin Estimation',
  INMAGASIN: '🏬 In Magasin',
  PENDING2: '📦 Pending Pricing',
  PRICING: '💰 In Pricing',
  NEGOTIATION1: '🤝 Negotiation 1 (Manager)',
  NEGOTIATION2: '🤝 Negotiation 2 (Admin)',
  ANNULER: '❌ Cancelled',
  PENDING3: '🚚 Pending Reparation',
  REPARATION: '🛠️ Reparation Assigned',
  REPARATION_Pause: '⏸️ Reparation Paused',
  INREPARATION: '🔧 In Reparation',
  FINISHED: '✅ Finished',
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

@Injectable()
export class DiscordHookService {
  private readonly logger = new Logger(DiscordHookService.name);
  /** Tracks channels whose URL was already reported missing — one warn
   *  per channel per process to avoid spamming logs on every send. */
  private readonly warnedMissing = new Set<ChannelKey>();

  /**
   * Resolve the webhook URL for a given channel from env. Every channel
   * falls back to the legacy `DISCORD_WEBHOOK_URL` when its dedicated
   * env var is empty, so a partially migrated `.env` (dev machine still
   * carrying the old single-webhook) keeps working.
   */
  private urlFor(channel: ChannelKey): string {
    const legacy = process.env.DISCORD_WEBHOOK_URL || '';
    switch (channel) {
      case 'GENERAL_ATELIER':
        return process.env.DISCORD_GENERAL_ATELIER_WEBHOOK || legacy;
      case 'SERVICE_TECHNIQUE':
        return process.env.DISCORD_SERVICE_TECHNIQUE_WEBHOOK || legacy;
      case 'DEMANDE_PDF':
        return process.env.DISCORD_DEMANDE_PDF_WEBHOOK || legacy;
      case 'ERROR':
        return process.env.DISCORD_ERROR_WEBHOOK || legacy;
      case 'APP_ALERT':
        return process.env.DISCORD_APP_ALERT_WEBHOOK || legacy;
    }
  }

  /**
   * Single post entry-point. NEVER throws:
   *   - missing URL → warn once, skip (a create-DI mutation can no longer
   *     crash because a webhook env var was forgotten)
   *   - axios failure → warn (already the pattern in the codebase — the
   *     Discord post is always best-effort)
   */
  private async postEmbed(
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
          footer: { text: 'Fixtronix — diagnostic webhooks' },
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
    if (!status) return 'Unknown';
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
      customerFieldName: useCompany ? '🏢 Company' : '👤 Client',
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
      { name: '🆔 DI Number', value: ctx.idnum, inline: true },
      { name: '📄 Title', value: ctx.title },
      {
        name: ctx.customerFieldName,
        value: ctx.customerLabel,
        inline: true,
      },
      {
        name: '📊 Status',
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
          title: '📌 DI Pending',
          description: 'A new DI has been created and is pending.',
          color: 16776960, // yellow (pending)
          fields: this.buildBaseFields(ctx, undefined, [
            { name: '🧑‍💼 Created By', value: createdBy, inline: true },
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
          title: '🛠️ DI Assigned to Technician',
          description: 'A DI has been assigned for diagnostic.',
          color: 3447003, // blue
          fields: this.buildBaseFields(ctx, undefined, [
            { name: '👨‍🔧 Technician', value: techDisplay, inline: true },
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
          title: '📦 Components Sent for Confirmation',
          description: 'Magasin sent components to coordinator for validation.',
          color: 10197915,
          fields: this.buildBaseFields(ctx, undefined, [
            { name: '🏬 Source', value: 'Magasin', inline: true },
            { name: '🧑‍💼 Target', value: 'Coordinator', inline: true },
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
          title: '✅ Components Confirmed by Coordinator',
          description:
            'Coordinator validated the components. Magasin can proceed.',
          color: 3066993,
          fields: this.buildBaseFields(ctx, undefined, [
            { name: '🧑‍💼 Source', value: 'Coordinator', inline: true },
            { name: '🏬 Target', value: 'Magasin', inline: true },
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
          title: '🏬 DI Arrived in Magasin',
          description: 'The DI is now in the warehouse/magasin.',
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
          title: '🚚 DI Moved to Pending3',
          description: 'DI advanced to the next stage (Pending3).',
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
          title: '🧾 Devis Uploaded',
          description: 'A quote (devis) has been uploaded.',
          color: 10181046,
          fields: this.buildBaseFields(ctx, undefined, [
            { name: '📎 File', value: fileName },
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
          title: '📄 Bon de Commande Uploaded',
          description: 'A BC (PDF) has been uploaded for this DI.',
          color: 3447003,
          fields: this.buildBaseFields(ctx, undefined, [
            { name: '📎 File', value: fileName },
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
          title: '💰 DI Price Assigned',
          description: 'Pricing has been completed.',
          color: 3066993,
          fields: this.buildBaseFields(ctx, undefined, [
            { name: '💵 Price', value: `${price} TND`, inline: true },
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
          title: '📦 DI Status Updated',
          description: 'DI moved to Pending2 (next processing stage).',
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
          title: '💰 DI Ready for Pricing',
          description: 'A DI is ready for pricing. Action required by admin.',
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
          title: '🆕 DI Created (Pending1)',
          description: 'A new DI entered the workflow.',
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
          title: isMax ? '⚠️ DI Ignored (Limit Reached)' : '⚠️ DI Ignored',
          description: isMax
            ? 'This DI reached the maximum ignore limit.'
            : 'This DI has been ignored.',
          color: isMax ? 15158332 : 16776960,
          fields: this.buildBaseFields(ctx, undefined, [
            {
              name: '🚫 Ignore Count',
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
          title: '🎉 DI Completed',
          description: 'Repair process is fully completed.',
          color: 3066993,
          fields: this.buildBaseFields(ctx, undefined, [
            {
              name: '💵 Final Price',
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
          title: '🛠️ DI Ready for Reparation',
          description:
            'Reparation phase assigned. Awaiting technician to start.',
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
      ? '✅ Repairable'
      : '🚫 Not Repairable';
    await this.postEmbed('SERVICE_TECHNIQUE', {
      embeds: [
        {
          title: '✅ Diagnostic Completed',
          description: 'Technician has finished the diagnostic.',
          color: diag?.can_be_repaired ? 3066993 : 15158332,
          fields: this.buildBaseFields(ctx, undefined, [
            { name: '🧾 Result', value: repairable, inline: true },
            {
              name: '📦 Contains PDR',
              value: diag?.contain_pdr ? 'Yes' : 'No',
              inline: true,
            },
            {
              name: '⚠️ Fixtronix Error',
              value: diag?.isErrorFromFixtronix ? 'Yes' : 'No',
              inline: true,
            },
            {
              name: '📝 Diagnostic Note',
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
          title: '⏸️ Diagnostic Paused',
          description: 'Technician paused the diagnostic process.',
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
          title: '▶️ Diagnostic Resumed',
          description: 'Technician resumed the diagnostic.',
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
          title: '🔍 Diagnostic Started',
          description: 'Technician started the diagnostic.',
          color: 3447003,
          fields: this.buildBaseFields(ctx),
          footer: { text: 'Fixtronix System' },
          timestamp: new Date().toISOString(),
        },
      ],
    });
  }

  async sendDiagnosticAssigned(di: any) {

    const ctx = await this.buildContext(di);
    await this.postEmbed('SERVICE_TECHNIQUE', {
      embeds: [
        {
          title: '🧭 Diagnostic Assigned',
          description: 'Coordinator assigned this DI to diagnostic.',
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
    await this.postEmbed('SERVICE_TECHNIQUE', {
      embeds: [
        {
          title: '🔧 Reparation Started',
          description: 'Technician started the repair.',
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
          title: '⏸️ Reparation Paused',
          description: 'Technician paused the repair.',
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
          title: '▶️ Reparation Resumed',
          description: 'Technician resumed the repair.',
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
          title: '🤝 Negotiation Started (Manager)',
          description: 'DI entered the first negotiation round (Manager).',
          color: 15418782,
          fields: this.buildBaseFields(ctx, undefined, [
            {
              name: '💵 Initial Price',
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
          title: '🤝 Negotiation Escalated (Admin Manager)',
          description: 'Negotiation escalated to Admin Manager.',
          color: 15418782,
          fields: this.buildBaseFields(ctx, undefined, [
            {
              name: '💵 Initial Price',
              value: di?.price ? `${di.price} TND` : 'N/A',
              inline: true,
            },
            {
              name: '💵 Final Price',
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
          title: '❌ DI Cancelled',
          description: 'DI was cancelled during negotiation.',
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
      3: '⚠️ Retour 3 — Final Alert',
    };
    const colors = { 1: 15844367, 2: 15105570, 3: 15158332 } as const;
    const descriptions = {
      1: 'DI returned for the first time.',
      2: 'DI returned a second time.',
      3: 'DI reached the final retour level. Operational attention required.',
    };
    await this.postEmbed('GENERAL_ATELIER', {
      embeds: [
        {
          title: titles[level],
          description: descriptions[level],
          color: colors[level],
          fields: this.buildBaseFields(ctx, undefined, [
            {
              name: '🚫 Ignore Count',
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
          title: '📦 Bon de Livraison Uploaded',
          description: 'A delivery slip (BL) has been uploaded.',
          color: 3447003,
          fields: this.buildBaseFields(ctx, undefined, [
            { name: '📎 File', value: fileName },
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
    let payloadPreview = '_(empty)_';
    if (entry.payload && Object.keys(entry.payload).length) {
      const json = JSON.stringify(entry.payload, null, 0);
      payloadPreview = '```json\n' + (json.length > 800 ? json.slice(0, 797) + '...' : json) + '\n```';
    }

    await this.postEmbed('ERROR', {
      embeds: [
        {
          title: `${severityEmoji[entry.severity] ?? '⚠️'} FIXTRONIX Operational Error`,
          description: entry.error,
          color: severityColor[entry.severity] ?? severityColor.MEDIUM,
          fields: [
            { name: '🧩 Module', value: `\`${entry.module}/${entry.submodule}\``, inline: true },
            { name: '🛠 Method', value: `\`${entry.method}\``, inline: true },
            { name: '🎚 Severity', value: entry.severity, inline: true },
            { name: '💬 Message', value: entry.message?.slice(0, 1000) || '_(no message)_' },
            { name: '📦 Payload', value: payloadPreview },
          ],
          footer: { text: 'Fixtronix Operations · Error capture' },
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
            { name: '📋 Messages', value: lines || '_(none)_' },
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

    await this.postEmbed('APP_ALERT', {
      embeds: [
        {
          title: `${severityEmoji[alert.severity] ?? '⚠️'} FIXTRONIX Operational Alert`,
          description:
            'This DI has remained too long in the same status and requires operational review.',
          color: severityColor[alert.severity] ?? severityColor.WARNING,
          fields: [
            { name: '🧾 DI', value: String(meta.diIdnum ?? alert.diId), inline: true },
            { name: '📌 Status', value: statusLabel, inline: true },
            { name: '🎚 Severity', value: alert.severity, inline: true },
            {
              name: '⏱ Stagnation Duration',
              value: ageHours !== null ? `${ageHours}h` : 'n/a',
              inline: true,
            },
            { name: '🪧 Threshold', value: alert.type, inline: true },
            {
              name: '🆔 Alert',
              value: alert._id,
              inline: true,
            },
          ],
          footer: { text: 'Fixtronix Operations' },
          timestamp: (alert.createdAt ?? new Date()).toISOString
            ? (alert.createdAt as Date).toISOString()
            : new Date().toISOString(),
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

    await this.postEmbed('APP_ALERT', {
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
