import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import axios from 'axios';
import { Client } from 'src/clients/entities/client.entity';
import { Company } from 'src/company/entities/company.entity';
import { Profile } from 'src/profile/entities/profile.entity';

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
  // Critical operational-alerts webhook — now read from env (was hardcoded).
  private readonly webhookUrl = process.env.DISCORD_WEBHOOK_URL ?? '';

  constructor(
    @InjectModel(Client.name) private readonly clientModel: Model<any>,
    @InjectModel(Company.name) private readonly companyModel: Model<any>,
    @InjectModel(Profile.name) private readonly profileModel: Model<any>,
  ) {}

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
    if (!this.webhookUrl) {
      throw new Error('DISCORD_WEBHOOK_URL is not defined');
    }
    const ctx = await this.buildContext(di);
    const createdBy = await this.resolveProfileDisplay(di?.createdBy);

    await axios.post(this.webhookUrl, {
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

    await axios.post(this.webhookUrl, {
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
    await axios.post(this.webhookUrl, {
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
    await axios.post(this.webhookUrl, {
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
    await axios.post(this.webhookUrl, {
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
    await axios.post(this.webhookUrl, {
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
    await axios.post(this.webhookUrl, {
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
    await axios.post(this.webhookUrl, {
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
    await axios.post(this.webhookUrl, {
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
    await axios.post(this.webhookUrl, {
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
    await axios.post(this.webhookUrl, {
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
    await axios.post(this.webhookUrl, {
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
    await axios.post(this.webhookUrl, {
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
    await axios.post(this.webhookUrl, {
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
    await axios.post(this.webhookUrl, {
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
    await axios.post(this.webhookUrl, {
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
    await axios.post(this.webhookUrl, {
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
    await axios.post(this.webhookUrl, {
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
    await axios.post(this.webhookUrl, {
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
    await axios.post(this.webhookUrl, {
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
    await axios.post(this.webhookUrl, {
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
    await axios.post(this.webhookUrl, {
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
    await axios.post(this.webhookUrl, {
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
    await axios.post(this.webhookUrl, {
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
    await axios.post(this.webhookUrl, {
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
    await axios.post(this.webhookUrl, {
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
    await axios.post(this.webhookUrl, {
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
    await axios.post(this.webhookUrl, {
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
    if (!this.webhookUrl) {
      throw new Error('DISCORD_WEBHOOK_URL is not defined');
    }

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

    await axios.post(this.webhookUrl, {
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
    const url = process.env.DISCORD_VALIDATION_WEBHOOK_URL;
    if (!url) {
      throw new Error('DISCORD_VALIDATION_WEBHOOK_URL is not defined');
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
    if (!this.webhookUrl) {
      throw new Error('DISCORD_WEBHOOK_URL is not defined');
    }

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

    await axios.post(this.webhookUrl, {
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
}
