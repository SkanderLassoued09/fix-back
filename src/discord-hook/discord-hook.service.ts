import { Injectable } from '@nestjs/common';
import axios from 'axios';

@Injectable()
export class DiscordHookService {
  private readonly webhookUrl =
    'https://discord.com/api/webhooks/1501210507581984859/EgrS4cT9DrGOnzrJcAJmZWelTKB0Iw-Gi7PVl7Z1hOrkQ4XEWGbk2A4V6l0-3AKZJhB1';

  async sendDiPendingNotification(di: any) {
    if (!this.webhookUrl) {
      throw new Error('DISCORD_WEBHOOK_URL is not defined');
    }

    await axios.post(this.webhookUrl, {
      embeds: [
        {
          title: '📌 DI Pending',
          description: 'A new DI has been created and is pending.',
          color: 16776960, // yellow (pending)

          fields: [
            {
              name: '🆔 DI Number',
              value: di._idnum,
              inline: true,
            },
            {
              name: '📄 Title',
              value: di.title || 'N/A',
            },
            {
              name: '👤 Client',
              value: di.client_id || 'N/A',
              inline: true,
            },
            {
              name: '🧑‍💼 Created By',
              value: di.createdBy || 'N/A',
              inline: true,
            },
            {
              name: '📌 Status',
              value: di.status,
              inline: true,
            },
          ],

          footer: {
            text: 'Fixtronix System',
          },

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
    await axios.post(this.webhookUrl, {
      embeds: [
        {
          title: '🛠️ DI Assigned to Technician',
          description: 'A DI has been assigned for diagnostic.',
          color: 3447003, // blue

          fields: [
            {
              name: '🆔 DI Number',
              value: di._idnum,
              inline: true,
            },
            {
              name: '📄 Title',
              value: di.title || 'N/A',
            },
            {
              name: '👤 Client',
              value: di.client_id || 'N/A',
              inline: true,
            },
            {
              name: '👨‍🔧 Technician',
              value: technician?.fullName || technician?._id || 'N/A',
              inline: true,
            },
            {
              name: '📊 Status',
              value: stat.status || 'N/A',
              inline: true,
            },
            {
              name: '🧾 Diagnostic ID',
              value: stat._id || 'N/A',
              inline: true,
            },
          ],

          footer: {
            text: 'Fixtronix System',
          },

          timestamp: new Date().toISOString(),
        },
      ],
    });
  }

  async sendComponentsSentToCoordinator(di: any) {
    await axios.post(this.webhookUrl, {
      embeds: [
        {
          title: '📦 Components Sent for Confirmation',
          description: 'Magasin sent components to coordinator for validation.',
          color: 10197915, // purple / workflow step

          fields: [
            {
              name: '🆔 DI Number',
              value: di?._idnum || 'N/A',
              inline: true,
            },
            {
              name: '📄 Title',
              value: di?.title || 'N/A',
            },
            {
              name: '👤 Client',
              value: di?.client_id || 'N/A',
              inline: true,
            },
            {
              name: '🏬 Source',
              value: 'Magasin',
              inline: true,
            },
            {
              name: '🧑‍💼 Target',
              value: 'Coordinator',
              inline: true,
            },
            {
              name: '📌 Flow',
              value:
                di?.handleSendingNotificationBetweenCoordinatorAndMagasin ||
                'N/A',
              inline: true,
            },
          ],

          footer: {
            text: 'Fixtronix System',
          },

          timestamp: new Date().toISOString(),
        },
      ],
    });
  }

  async sendComponentsConfirmedByCoordinator(di: any) {
    await axios.post(this.webhookUrl, {
      embeds: [
        {
          title: '✅ Components Confirmed by Coordinator',
          description:
            'Coordinator validated the components. Magasin can proceed.',
          color: 3066993, // green (approval)

          fields: [
            {
              name: '🆔 DI Number',
              value: di?._idnum || 'N/A',
              inline: true,
            },
            {
              name: '📄 Title',
              value: di?.title || 'N/A',
            },
            {
              name: '👤 Client',
              value: di?.client_id || 'N/A',
              inline: true,
            },
            {
              name: '🧑‍💼 Source',
              value: 'Coordinator',
              inline: true,
            },
            {
              name: '🏬 Target',
              value: 'Magasin',
              inline: true,
            },
            {
              name: '📌 Flow Reset',
              value:
                di?.handleSendingNotificationBetweenCoordinatorAndMagasin ||
                'DEFAULT',
              inline: true,
            },
          ],

          footer: {
            text: 'Fixtronix System',
          },

          timestamp: new Date().toISOString(),
        },
      ],
    });
  }

  async sendDiInMagasin(di: any) {
    await axios.post(this.webhookUrl, {
      embeds: [
        {
          title: '🏬 DI Arrived in Magasin',
          description: 'The DI is now in the warehouse/magasin.',
          color: 5763719,

          fields: [
            {
              name: '🆔 DI Number',
              value: di._idnum || 'N/A',
              inline: true,
            },
            {
              name: '📄 Title',
              value: di.title || 'N/A',
            },
            {
              name: '👤 Client',
              value: di.client_id || 'N/A',
              inline: true,
            },
            {
              name: '📌 Status',
              value: di.status,
              inline: true,
            },
          ],

          footer: {
            text: 'Fixtronix System',
          },

          timestamp: new Date().toISOString(),
        },
      ],
    });
  }
  async sendDiStatusPending3(di: any) {
    await axios.post(this.webhookUrl, {
      embeds: [
        {
          title: '🚚 DI Moved to Pending3',
          description: 'DI advanced to the next stage (Pending3).',
          color: 5793266, // teal / progression color

          fields: [
            {
              name: '🆔 DI Number',
              value: di._idnum || 'N/A',
              inline: true,
            },
            {
              name: '📄 Title',
              value: di.title || 'N/A',
            },
            {
              name: '👤 Client',
              value: di.client_id || 'N/A',
              inline: true,
            },
            {
              name: '📌 Status',
              value: di.status,
              inline: true,
            },
          ],

          footer: {
            text: 'Fixtronix System',
          },

          timestamp: new Date().toISOString(),
        },
      ],
    });
  }

  async sendDiDevisUploaded({ di, fileName }: { di: any; fileName: string }) {
    await axios.post(this.webhookUrl, {
      embeds: [
        {
          title: '🧾 Devis Uploaded',
          description: 'A quote (devis) has been uploaded.',
          color: 10181046, // purple-ish

          fields: [
            {
              name: '🆔 DI Number',
              value: di?._idnum || 'N/A',
              inline: true,
            },
            {
              name: '📄 Title',
              value: di?.title || 'N/A',
            },
            {
              name: '👤 Client',
              value: di?.client_id || 'N/A',
              inline: true,
            },
            {
              name: '📎 File',
              value: fileName,
            },
            {
              name: '📌 Status',
              value: di?.status || 'N/A',
              inline: true,
            },
          ],

          footer: {
            text: 'Fixtronix System',
          },

          timestamp: new Date().toISOString(),
        },
      ],
    });
  }

  async sendDiBCUploaded({ di, fileName }: { di: any; fileName: string }) {
    await axios.post(this.webhookUrl, {
      embeds: [
        {
          title: '📄 Bon de Commande Uploaded',
          description: 'A BC (PDF) has been uploaded for this DI.',
          color: 3447003, // blue

          fields: [
            {
              name: '🆔 DI Number',
              value: di?._idnum || 'N/A',
              inline: true,
            },
            {
              name: '📄 Title',
              value: di?.title || 'N/A',
            },
            {
              name: '👤 Client',
              value: di?.client_id || 'N/A',
              inline: true,
            },
            {
              name: '📎 File',
              value: fileName,
            },
            {
              name: '📌 Status',
              value: di?.status || 'N/A',
              inline: true,
            },
          ],

          footer: {
            text: 'Fixtronix System',
          },

          timestamp: new Date().toISOString(),
        },
      ],
    });
  }

  async sendDiPriceAssigned({ di, price }: { di: any; price: number }) {
    await axios.post(this.webhookUrl, {
      embeds: [
        {
          title: '💰 DI Price Assigned',
          description: 'Pricing has been completed.',
          color: 3066993, // green (completed step)

          fields: [
            {
              name: '🆔 DI Number',
              value: di?._idnum || 'N/A',
              inline: true,
            },
            {
              name: '📄 Title',
              value: di?.title || 'N/A',
            },
            {
              name: '👤 Client',
              value: di?.client_id || 'N/A',
              inline: true,
            },
            {
              name: '💵 Price',
              value: `${price} TND`,
              inline: true,
            },
            {
              name: '📌 Status',
              value: di?.status || 'N/A',
              inline: true,
            },
          ],

          footer: {
            text: 'Fixtronix System',
          },

          timestamp: new Date().toISOString(),
        },
      ],
    });
  }

  async sendDiStatusPending2(di: any) {
    await axios.post(this.webhookUrl, {
      embeds: [
        {
          title: '📦 DI Status Updated',
          description: 'DI moved to Pending2 (next processing stage).',
          color: 15844367, // orange

          fields: [
            {
              name: '🆔 DI Number',
              value: di._idnum || 'N/A',
              inline: true,
            },
            {
              name: '📄 Title',
              value: di.title || 'N/A',
            },
            {
              name: '👤 Client',
              value: di.client_id || 'N/A',
              inline: true,
            },
            {
              name: '📌 New Status',
              value: di.status,
              inline: true,
            },
          ],

          footer: {
            text: 'Fixtronix System',
          },

          timestamp: new Date().toISOString(),
        },
      ],
    });
  }

  async sendDiPricing(di: any) {
    await axios.post(this.webhookUrl, {
      embeds: [
        {
          title: '💰 DI Ready for Pricing',
          description: 'A DI is ready for pricing. Action required by admin.',
          color: 16753920, // gold-ish

          fields: [
            {
              name: '🆔 DI Number',
              value: di._idnum || 'N/A',
              inline: true,
            },
            {
              name: '📄 Title',
              value: di.title || 'N/A',
            },
            {
              name: '👤 Client',
              value: di.client_id || 'N/A',
              inline: true,
            },
            {
              name: '📌 Status',
              value: di.status,
              inline: true,
            },
          ],

          footer: {
            text: 'Fixtronix System',
          },

          timestamp: new Date().toISOString(),
        },
      ],
    });
  }

  async sendDiStatusPending1(di: any) {
    await axios.post(this.webhookUrl, {
      embeds: [
        {
          title: '🆕 DI Created (Pending1)',
          description: 'A new DI entered the workflow.',
          color: 16776960, // yellow

          fields: [
            {
              name: '🆔 DI Number',
              value: di._idnum || 'N/A',
              inline: true,
            },
            {
              name: '📄 Title',
              value: di.title || 'N/A',
            },
            {
              name: '👤 Client',
              value: di.client_id || 'N/A',
              inline: true,
            },
            {
              name: '📌 Status',
              value: di.status,
              inline: true,
            },
          ],

          footer: {
            text: 'Fixtronix System',
          },

          timestamp: new Date().toISOString(),
        },
      ],
    });
  }

  async sendDiIgnored(di: any) {
    const isMax = (di.ignoreCount || 0) >= 3;

    await axios.post(this.webhookUrl, {
      embeds: [
        {
          title: isMax ? '⚠️ DI Ignored (Limit Reached)' : '⚠️ DI Ignored',
          description: isMax
            ? 'This DI reached the maximum ignore limit.'
            : 'This DI has been ignored.',
          color: isMax ? 15158332 : 16776960, // red if max, yellow otherwise

          fields: [
            {
              name: '🆔 DI Number',
              value: di?._idnum || 'N/A',
              inline: true,
            },
            {
              name: '📄 Title',
              value: di?.title || 'N/A',
            },
            {
              name: '👤 Client',
              value: di?.client_id || 'N/A',
              inline: true,
            },
            {
              name: '🚫 Ignore Count',
              value: `${di.ignoreCount}/3`,
              inline: true,
            },
          ],

          footer: {
            text: 'Fixtronix System',
          },

          timestamp: new Date().toISOString(),
        },
      ],
    });
  }

  async sendDiFinished(di: any) {
    await axios.post(this.webhookUrl, {
      embeds: [
        {
          title: '🎉 DI Completed',
          description: 'Repair process is fully completed.',
          color: 3066993, // green

          fields: [
            {
              name: '🆔 DI Number',
              value: di._idnum || 'N/A',
              inline: true,
            },
            {
              name: '📄 Title',
              value: di.title || 'N/A',
            },
            {
              name: '👤 Client',
              value: di.client_id || 'N/A',
              inline: true,
            },
            {
              name: '💵 Final Price',
              value: di.price ? `${di.price} TND` : 'N/A',
              inline: true,
            },
            {
              name: '📌 Status',
              value: di.status,
              inline: true,
            },
          ],

          footer: {
            text: 'Fixtronix System',
          },

          timestamp: new Date().toISOString(),
        },
      ],
    });
  }

  async sendDiInReparation(di: any) {
    await axios.post(this.webhookUrl, {
      embeds: [
        {
          title: '🛠️ DI In Reparation',
          description: 'Repair process has started.',
          color: 15105570, // amber / in-progress

          fields: [
            {
              name: '🆔 DI Number',
              value: di._idnum || 'N/A',
              inline: true,
            },
            {
              name: '📄 Title',
              value: di.title || 'N/A',
            },
            {
              name: '👤 Client',
              value: di.client_id || 'N/A',
              inline: true,
            },
            {
              name: '📌 Status',
              value: di.status,
              inline: true,
            },
          ],

          footer: {
            text: 'Fixtronix System',
          },

          timestamp: new Date().toISOString(),
        },
      ],
    });
  }

  async sendDiagnosticFinished({ di, diag }: { di: any; diag: any }) {
    const result = diag?.can_be_repaired ? 'Repairable' : 'Not Repairable';

    await axios.post(this.webhookUrl, {
      embeds: [
        {
          title: '✅ Diagnostic Completed',
          description: 'Technician has finished the diagnostic.',
          color: diag?.can_be_repaired ? 3066993 : 15158332, // green / red

          fields: [
            {
              name: '🆔 DI Number',
              value: di?._idnum || 'N/A',
              inline: true,
            },
            {
              name: '📄 Title',
              value: di?.title || 'N/A',
            },
            {
              name: '👤 Client',
              value: di?.client_id || 'N/A',
              inline: true,
            },
            {
              name: '🧾 Result',
              value: result,
              inline: true,
            },
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
          ],

          footer: {
            text: 'Fixtronix System',
          },

          timestamp: new Date().toISOString(),
        },
      ],
    });
  }
}
