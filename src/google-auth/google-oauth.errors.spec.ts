import {
  GoogleOAuthGrantError,
  buildInvalidGrantDiagnostic,
  extractGoogleError,
  isInvalidGrant,
  isTransientError,
  maskSecret,
} from './google-oauth.errors';

describe('google-oauth.errors', () => {
  describe('maskSecret', () => {
    it('keeps a short prefix and hides the rest (never the full value)', () => {
      const masked = maskSecret('1//03zXbYsecrettokenmaterial');
      expect(masked).toBe('1//03z…****');
      expect(masked).not.toContain('secrettokenmaterial');
    });
    it('handles absent values', () => {
      expect(maskSecret(undefined)).toBe('<absent>');
      expect(maskSecret('')).toBe('<absent>');
      expect(maskSecret(null)).toBe('<absent>');
    });
  });

  describe('extractGoogleError', () => {
    it('decodes the token-endpoint shape { error, error_description }', () => {
      const err = {
        response: {
          status: 400,
          data: { error: 'invalid_grant', error_description: 'Token has been expired or revoked.' },
        },
      };
      const info = extractGoogleError(err);
      expect(info.error).toBe('invalid_grant');
      expect(info.errorDescription).toBe('Token has been expired or revoked.');
      expect(info.httpStatus).toBe(400);
    });

    it('decodes the Drive API shape { error: { code, message } }', () => {
      const err = {
        code: 403,
        errors: [{ reason: 'storageQuotaExceeded', message: 'no quota' }],
        response: { data: { error: { code: 403, message: 'no quota' } } },
      };
      const info = extractGoogleError(err);
      expect(info.httpStatus).toBe(403);
      expect(info.message).toBe('no quota');
    });

    it('never throws on a bare Error', () => {
      const info = extractGoogleError(new Error('boom'));
      expect(info.message).toBe('boom');
      expect(info.error).toBeUndefined();
    });
  });

  describe('isInvalidGrant', () => {
    it('true for the structured invalid_grant', () => {
      expect(
        isInvalidGrant({ response: { data: { error: 'invalid_grant' } } }),
      ).toBe(true);
    });
    it('true when the message mentions invalid_grant', () => {
      expect(isInvalidGrant(new Error('invalid_grant'))).toBe(true);
    });
    it('false for unrelated errors', () => {
      expect(isInvalidGrant(new Error('ETIMEDOUT'))).toBe(false);
      expect(isInvalidGrant({ code: 500 })).toBe(false);
    });
  });

  describe('isTransientError (retry policy)', () => {
    it('retries 429 and 5xx', () => {
      expect(isTransientError({ code: 429 })).toBe(true);
      expect(isTransientError({ response: { status: 500 } })).toBe(true);
      expect(isTransientError({ response: { status: 503 } })).toBe(true);
    });
    it('retries network errors', () => {
      expect(isTransientError({ code: 'ETIMEDOUT' })).toBe(true);
      expect(isTransientError({ code: 'ECONNRESET' })).toBe(true);
    });
    it('does NOT retry 4xx or invalid_grant', () => {
      expect(isTransientError({ code: 400 })).toBe(false);
      expect(isTransientError({ response: { status: 403 } })).toBe(false);
      expect(
        isTransientError({ response: { data: { error: 'invalid_grant' } } }),
      ).toBe(false);
    });
  });

  describe('buildInvalidGrantDiagnostic', () => {
    it('produces an actionable, non-generic message (not just "invalid_grant")', () => {
      const diag = buildInvalidGrantDiagnostic({
        response: {
          status: 400,
          data: { error: 'invalid_grant', error_description: 'Token expired' },
        },
      });
      expect(diag).toBeInstanceOf(GoogleOAuthGrantError);
      expect(diag.googleError).toBe('invalid_grant');
      expect(diag.httpStatus).toBe(400);
      // Names the real causes + the required manual action.
      expect(diag.message).toMatch(/Testing/);
      expect(diag.message).toMatch(/7 jours/);
      expect(diag.message).toMatch(/\/auth\/google/);
      expect(diag.message).toMatch(/ACTION MANUELLE REQUISE/);
      // Never a bare code.
      expect(diag.message.length).toBeGreaterThan(50);
    });
  });
});
