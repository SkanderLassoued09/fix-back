import { Injectable, Logger } from '@nestjs/common';
import axios from 'axios';
import { OperationalErrorService } from 'src/operational-error/operational-error.service';

/**
 * Jira Cloud integration (REST API v3).
 *
 * One responsibility: turn a meeting "Action à mener" into a Jira issue in the
 * configured project. Mirrors the codebase's external-integration conventions
 * (Discord / Google Drive):
 *   - **Best-effort**: every method swallows failures and returns null — a Jira
 *     outage or 4xx must NEVER break the operation that triggered it.
 *   - **Env-gated**: inert (no network) until JIRA_* env vars are set, so dev /
 *     test runs and unconfigured deployments behave exactly as before.
 *   - **Self-logging**: failures route through `OperationalErrorService.capture`
 *     at severity LOW (the "best-effort side-effect failed" tier).
 *
 * Credentials come from env only (never hardcoded):
 *   JIRA_BASE_URL · JIRA_EMAIL · JIRA_API_TOKEN · JIRA_PROJECT_KEY
 *   (+ optional JIRA_API_VERSION=3, JIRA_TIMEOUT=10000, JIRA_ISSUE_TYPE=Task)
 */

export interface JiraIssueResult {
  issueKey: string;
  url: string;
}

/** The subset of an Action à mener Jira needs, plus the resolved assignee email. */
export interface JiraActionInput {
  titre: string;
  description?: string;
  /** Domain enum: 'BASSE' | 'MOYENNE' | 'HAUTE'. */
  priorite?: string;
  echeance?: Date | string | null;
  /** Resolved by the caller from the responsable Profile (Jira needs it to
   *  look up an accountId). Null/absent → issue created unassigned. */
  assigneeEmail?: string | null;
}

/** Meeting context embedded in the Jira description for traceability. */
export interface JiraMeetingContext {
  _id?: string;
  reference?: string;
  titre?: string;
}

/** A normalized Jira issue row as returned by `searchIssues`. */
export interface JiraSearchIssue {
  issueKey: string;
  titre: string;
  /** Assignee email when exposed, else display name, else null. */
  responsable: string | null;
  /** Jira `duedate` (date-only field) parsed to a Date, or null. */
  echeance: Date | null;
  url: string;
}

@Injectable()
export class JiraService {
  private readonly logger = new Logger(JiraService.name);

  private readonly baseUrl = (process.env.JIRA_BASE_URL ?? '').replace(
    /\/+$/,
    '',
  );
  private readonly email = process.env.JIRA_EMAIL ?? '';
  private readonly apiToken = process.env.JIRA_API_TOKEN ?? '';
  private readonly projectKey = process.env.JIRA_PROJECT_KEY ?? '';
  private readonly apiVersion = process.env.JIRA_API_VERSION ?? '3';
  private readonly issueType = process.env.JIRA_ISSUE_TYPE ?? 'Task';
  private readonly timeout = Number(process.env.JIRA_TIMEOUT ?? 10000) || 10000;

  constructor(private readonly opError: OperationalErrorService) {}

  /** True only when every required credential is present — else fully inert. */
  get isConfigured(): boolean {
    return !!(
      this.baseUrl &&
      this.email &&
      this.apiToken &&
      this.projectKey
    );
  }

  private get issueUrlBase(): string {
    return `${this.baseUrl}/rest/api/${this.apiVersion}/issue`;
  }

  private authHeaders(): Record<string, string> {
    const basic = Buffer.from(`${this.email}:${this.apiToken}`).toString(
      'base64',
    );
    return {
      Authorization: `Basic ${basic}`,
      'Content-Type': 'application/json',
      Accept: 'application/json',
    };
  }

  /** BASSE/MOYENNE/HAUTE → Jira's default priority names; null = omit field. */
  private mapPriority(priorite?: string): string | null {
    switch ((priorite ?? '').toUpperCase()) {
      case 'BASSE':
        return 'Low';
      case 'MOYENNE':
        return 'Medium';
      case 'HAUTE':
        return 'High';
      default:
        return null;
    }
  }

  /** Date → "YYYY-MM-DD" (Jira `duedate`); null when absent/invalid. */
  private toDueDate(value?: Date | string | null): string | null {
    if (!value) return null;
    const d = new Date(value);
    if (isNaN(d.getTime())) return null;
    return d.toISOString().slice(0, 10);
  }

  /** The lines that make up the issue body (action detail + traceability). */
  private descriptionLines(
    action: JiraActionInput,
    meeting: JiraMeetingContext,
  ): string[] {
    const lines: string[] = [];
    if ((action.description ?? '').trim()) {
      lines.push(action.description!.trim());
    }
    const meta: string[] = [];
    if (meeting.reference) meta.push(`Réunion: ${meeting.reference}`);
    if (meeting._id) meta.push(`PV id: ${meeting._id}`);
    const due = this.toDueDate(action.echeance);
    if (due) meta.push(`Échéance: ${due}`);
    if (action.priorite) meta.push(`Priorité: ${action.priorite}`);
    if (meta.length) lines.push(meta.join(' · '));
    return lines.length ? lines : ['—'];
  }

  /**
   * Build the `description` field. API v3 requires Atlassian Document Format
   * (ADF); v2 takes a plain string. We branch so JIRA_API_VERSION can switch.
   */
  private buildDescription(
    action: JiraActionInput,
    meeting: JiraMeetingContext,
  ): any {
    const lines = this.descriptionLines(action, meeting);
    if (this.apiVersion.startsWith('2')) {
      return lines.join('\n');
    }
    return {
      type: 'doc',
      version: 1,
      content: lines.map((text) => ({
        type: 'paragraph',
        content: [{ type: 'text', text }],
      })),
    };
  }

  /**
   * Best-effort accountId lookup. Jira Cloud assigns by `accountId`, not email,
   * so we search by the responsable's email. Needs the "Browse users"
   * permission; any failure (no permission, no match, no email) → null =
   * unassigned. Never throws.
   */
  private async resolveAccountId(
    email?: string | null,
  ): Promise<string | null> {
    if (!email) return null;
    try {
      const res = await axios.get(
        `${this.baseUrl}/rest/api/${this.apiVersion}/user/search`,
        { headers: this.authHeaders(), params: { query: email }, timeout: this.timeout },
      );
      const rows: any[] = Array.isArray(res.data) ? res.data : [];
      const exact = rows.find(
        (u) =>
          (u?.emailAddress ?? '').toLowerCase() === email.toLowerCase(),
      );
      return (exact ?? rows[0])?.accountId ?? null;
    } catch {
      return null;
    }
  }

  /**
   * Create ONE Jira issue for an action. Returns `{ issueKey, url }` on success
   * or `null` on any failure / when unconfigured / when the action has no title.
   * Never throws.
   *
   * Resilience: some projects don't expose priority/duedate/assignee on the
   * create screen and reject them with a 400. We retry once with a minimal
   * payload (project + summary + description + issuetype) so the action still
   * lands in Jira instead of being dropped.
   */
  async createIssueForAction(
    action: JiraActionInput,
    meeting: JiraMeetingContext,
  ): Promise<JiraIssueResult | null> {
    if (!this.isConfigured) return null;
    const summary = (action.titre ?? '').trim();
    if (!summary) return null;

    const accountId = await this.resolveAccountId(action.assigneeEmail);

    const fields: any = {
      project: { key: this.projectKey },
      summary: summary.slice(0, 254),
      description: this.buildDescription(action, meeting),
      issuetype: { name: this.issueType },
    };
    const priority = this.mapPriority(action.priorite);
    if (priority) fields.priority = { name: priority };
    const due = this.toDueDate(action.echeance);
    if (due) fields.duedate = due;
    if (accountId) fields.assignee = { id: accountId };

    try {
      return await this.postIssue(fields, meeting, false);
    } catch (err: any) {
      if (err?.response?.status === 400) {
        // Optional fields not configured on the project → retry minimal.
        try {
          return await this.postIssue(
            {
              project: fields.project,
              summary: fields.summary,
              description: fields.description,
              issuetype: fields.issuetype,
            },
            meeting,
            true,
          );
        } catch (retryErr) {
          await this.capture(action, meeting, retryErr);
          return null;
        }
      }
      await this.capture(action, meeting, err);
      return null;
    }
  }

  /**
   * Run a JQL search and return normalized issue rows. Unlike the best-effort
   * `createIssueForAction` (which returns null), this **throws** on an API
   * error so a polling caller (the due-soon cron) can log it and skip the run
   * cleanly rather than silently treating an outage as "no issues".
   *
   * Endpoint: POST /rest/api/{v}/search/jql — Jira Cloud's **enhanced** JQL
   * search. The classic `GET /rest/api/3/search` was removed by Atlassian
   * (returns 410 Gone since 2025), so we POST `{ jql, fields, maxResults }`
   * here. The response shape (`issues[].key` / `.fields`) is unchanged.
   */
  async searchIssues(
    jql: string,
    fields: string[] = ['summary', 'duedate', 'assignee'],
    maxResults = 50,
  ): Promise<JiraSearchIssue[]> {
    if (!this.isConfigured) {
      throw new Error(
        'Jira not configured (JIRA_BASE_URL/JIRA_EMAIL/JIRA_API_TOKEN/JIRA_PROJECT_KEY)',
      );
    }
    const res = await axios.post(
      `${this.baseUrl}/rest/api/${this.apiVersion}/search/jql`,
      { jql, fields, maxResults },
      { headers: this.authHeaders(), timeout: this.timeout },
    );
    const issues: any[] = Array.isArray(res.data?.issues)
      ? res.data.issues
      : [];
    return issues.map((it) => {
      const f = it?.fields ?? {};
      return {
        issueKey: it?.key,
        titre: f.summary ?? '',
        responsable:
          f.assignee?.emailAddress ?? f.assignee?.displayName ?? null,
        echeance: f.duedate ? new Date(f.duedate) : null,
        url: `${this.baseUrl}/browse/${it?.key}`,
      };
    });
  }

  private async postIssue(
    fields: any,
    meeting: JiraMeetingContext,
    minimal: boolean,
  ): Promise<JiraIssueResult> {
    const res = await axios.post(
      this.issueUrlBase,
      { fields },
      { headers: this.authHeaders(), timeout: this.timeout },
    );
    const issueKey = res.data?.key as string;
    const url = `${this.baseUrl}/browse/${issueKey}`;
    this.logger.log(
      `Created Jira issue ${issueKey} for PV ${
        meeting.reference ?? meeting._id
      }${minimal ? ' (minimal payload)' : ''}`,
    );
    return { issueKey, url };
  }

  /** Structured, PII-free capture (no emails/tokens in the payload). */
  private async capture(
    action: JiraActionInput,
    meeting: JiraMeetingContext,
    err: any,
  ): Promise<void> {
    const status = err?.response?.status;
    const body = err?.response?.data;
    const detail = status
      ? `HTTP ${status}: ${JSON.stringify(
          body?.errors ?? body?.errorMessages ?? body ?? '',
        )}`
      : err?.message ?? String(err);
    await this.opError.capture({
      module: 'reunion-pv',
      submodule: 'jira',
      method: 'CREATE_ISSUE',
      severity: 'LOW',
      error: 'Jira issue creation failed',
      message: String(detail).slice(0, 500),
      payload: {
        pvId: meeting?._id,
        reference: meeting?.reference,
        action: (action?.titre ?? '').slice(0, 80),
      },
    });
  }
}
