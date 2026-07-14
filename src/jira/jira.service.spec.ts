import axios from 'axios';
import { JiraService } from './jira.service';

jest.mock('axios', () => ({
  __esModule: true,
  default: { post: jest.fn(), get: jest.fn(), put: jest.fn() },
}));

const mAxios = axios as unknown as {
  post: jest.Mock;
  get: jest.Mock;
  put: jest.Mock;
};

const opError = { capture: jest.fn() } as any;

const meeting = { _id: 'pv1', reference: 'PV-2026-001', titre: 'Réunion' };

describe('JiraService (writer)', () => {
  let service: JiraService;

  beforeAll(() => {
    process.env.JIRA_BASE_URL = 'https://acme.atlassian.net';
    process.env.JIRA_EMAIL = 'bot@acme.io';
    process.env.JIRA_API_TOKEN = 'tok';
    process.env.JIRA_PROJECT_KEY = 'FIX';
    process.env.JIRA_API_VERSION = '3';
  });

  beforeEach(() => {
    jest.clearAllMocks();
    service = new JiraService(opError);
  });

  it('is configured when all JIRA_* env vars are present', () => {
    expect(service.isConfigured).toBe(true);
  });

  it('createIssueForAction: assigns by email + sets duedate, returns assigned=true', async () => {
    // user/search resolves an account for the email
    mAxios.get.mockResolvedValue({
      data: [{ accountId: 'acc-1', emailAddress: 'alice@acme.io' }],
    });
    mAxios.post.mockResolvedValue({ data: { key: 'FIX-10' } });

    const res = await service.createIssueForAction(
      {
        titre: 'Commander pièce',
        echeance: new Date('2026-08-01T10:00:00Z'),
        priorite: 'HAUTE',
        assigneeEmail: 'alice@acme.io',
      },
      meeting,
    );

    expect(res).toEqual({
      issueKey: 'FIX-10',
      url: 'https://acme.atlassian.net/browse/FIX-10',
      assigned: true,
    });
    const body = mAxios.post.mock.calls[0][1];
    expect(body.fields.assignee).toEqual({ id: 'acc-1' });
    expect(body.fields.duedate).toBe('2026-08-01'); // Date → YYYY-MM-DD
    expect(body.fields.priority).toEqual({ name: 'High' });
    expect(body.fields.project).toEqual({ key: 'FIX' });
  });

  it('createIssueForAction: email not a Jira user → created UNASSIGNED, assigned=false', async () => {
    mAxios.get.mockResolvedValue({ data: [] }); // no account matched
    mAxios.post.mockResolvedValue({ data: { key: 'FIX-11' } });

    const res = await service.createIssueForAction(
      { titre: 'Tâche', assigneeEmail: 'ghost@nope.io' },
      meeting,
    );

    expect(res).toMatchObject({ issueKey: 'FIX-11', assigned: false });
    const body = mAxios.post.mock.calls[0][1];
    expect(body.fields.assignee).toBeUndefined(); // never lost, just unassigned
  });

  it('updateIssueForAction: PUTs the same issueKey (idempotent, no new issue)', async () => {
    mAxios.get.mockResolvedValue({
      data: [{ accountId: 'acc-1', emailAddress: 'alice@acme.io' }],
    });
    mAxios.put.mockResolvedValue({ status: 204, data: '' });

    const res = await service.updateIssueForAction(
      'FIX-10',
      {
        titre: 'Commander pièce (v2)',
        echeance: new Date('2026-08-02T10:00:00Z'),
        assigneeEmail: 'alice@acme.io',
      },
      meeting,
    );

    expect(res).toEqual({
      issueKey: 'FIX-10',
      url: 'https://acme.atlassian.net/browse/FIX-10',
      assigned: true,
    });
    expect(mAxios.post).not.toHaveBeenCalled(); // no create
    expect(mAxios.put).toHaveBeenCalledTimes(1);
    const [putUrl, putBody] = mAxios.put.mock.calls[0];
    expect(putUrl).toContain('/issue/FIX-10');
    expect(putBody.fields.summary).toBe('Commander pièce (v2)');
    expect(putBody.fields.duedate).toBe('2026-08-02');
  });

  it('is inert (returns null, no HTTP) when unconfigured', async () => {
    delete process.env.JIRA_BASE_URL;
    const bare = new JiraService(opError);
    const res = await bare.createIssueForAction({ titre: 'x' }, meeting);
    expect(res).toBeNull();
    expect(mAxios.post).not.toHaveBeenCalled();
    process.env.JIRA_BASE_URL = 'https://acme.atlassian.net'; // restore
  });
});
