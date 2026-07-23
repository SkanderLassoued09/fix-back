// Mock the Sheets v4 API so the client never hits the network. `google.sheets`
// returns a fake `spreadsheets` surface whose methods are jest mocks.
jest.mock('googleapis', () => {
  const sheets = jest.fn();
  return { google: { sheets } };
});

import { google } from 'googleapis';
import { GoogleSheetsClient } from './google-sheets.client';

const sheetsFactory = google.sheets as unknown as jest.Mock;

describe('GoogleSheetsClient — OAuth auth + writes', () => {
  let append: jest.Mock;
  let clear: jest.Mock;
  let update: jest.Mock;
  let get: jest.Mock;
  let batchUpdate: jest.Mock;
  let authSentinel: any;
  let oauth: { getAuthenticatedClient: jest.Mock };
  let client: GoogleSheetsClient;

  beforeEach(() => {
    append = jest.fn().mockResolvedValue({ data: {} });
    clear = jest.fn().mockResolvedValue({ data: {} });
    update = jest.fn().mockResolvedValue({ data: {} });
    // Tab 'DI' already exists so appendRows takes the happy path (no auto-heal).
    get = jest
      .fn()
      .mockResolvedValue({ data: { sheets: [{ properties: { title: 'DI' } }] } });
    batchUpdate = jest.fn().mockResolvedValue({ data: {} });
    sheetsFactory.mockReturnValue({
      spreadsheets: { values: { append, clear, update }, get, batchUpdate },
    });

    // The shared OAuth factory hands back an opaque client; we assert it is the
    // exact object passed to google.sheets({ auth }).
    authSentinel = { __sharedOAuthClient: true };
    // getAuthenticatedClient is async now (refresh token read from Mongo).
    oauth = {
      getAuthenticatedClient: jest.fn().mockResolvedValue(authSentinel),
    };
    client = new GoogleSheetsClient(oauth as any);
    process.env.GOOGLE_SHEETS_ID = 'SHEET_1';
  });

  afterEach(() => {
    jest.clearAllMocks();
    delete process.env.GOOGLE_SHEETS_ID;
  });

  it('authenticates via the shared OAuth client (NOT a service account)', async () => {
    await client.appendRows('DI!A:U', [['T1394', 'AGRO NADHOUR']]);
    expect(oauth.getAuthenticatedClient).toHaveBeenCalledTimes(1);
    expect(sheetsFactory).toHaveBeenCalledWith({
      version: 'v4',
      auth: authSentinel,
    });
  });

  it('appends the rows to the configured spreadsheet', async () => {
    const rows = [
      ['T1394', 'AGRO NADHOUR'],
      ['T1345', 'CARTE FOUR'],
    ];
    await client.appendRows('DI!A:U', rows);
    expect(append).toHaveBeenCalledTimes(1);
    expect(append).toHaveBeenCalledWith(
      expect.objectContaining({
        spreadsheetId: 'SHEET_1',
        range: 'DI!A:U',
        requestBody: { values: rows },
      }),
    );
  });

  it('caches the client — a second write does not re-auth', async () => {
    await client.appendRows('DI!A:U', [['a']]);
    await client.appendRows('DI!A:U', [['b']]);
    expect(oauth.getAuthenticatedClient).toHaveBeenCalledTimes(1);
    expect(sheetsFactory).toHaveBeenCalledTimes(1);
  });

  it('no-ops on empty rows (no auth, no API call)', async () => {
    await client.appendRows('DI!A:U', []);
    expect(oauth.getAuthenticatedClient).not.toHaveBeenCalled();
    expect(sheetsFactory).not.toHaveBeenCalled();
    expect(append).not.toHaveBeenCalled();
  });

  it('raises a clear re-consent error when the token lacks the Sheets scope (403)', async () => {
    const scopeErr: any = new Error(
      'Request had insufficient authentication scopes.',
    );
    scopeErr.code = 403;
    append.mockRejectedValue(scopeErr);
    await expect(
      client.appendRows('DI!A:U', [['T1', 'x']]),
    ).rejects.toThrow(/spreadsheets|consentement|GOOGLE_OAUTH_REFRESH_TOKEN/i);
  });
});
