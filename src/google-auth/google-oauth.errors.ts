/**
 * Custom exceptions + diagnostics for the shared Google OAuth 2.0 grant.
 *
 * Goal: turn Google's opaque failures (`invalid_grant`, a bare 400) into
 * ACTIONABLE operator messages, and never leak a secret (client secret,
 * refresh token, access token) into a log or an error message.
 */

/** Base type so callers can `instanceof GoogleOAuthBaseError` catch the family. */
export abstract class GoogleOAuthBaseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = new.target.name;
  }
}

/** `.env` is missing one or more of the OAuth app credentials. */
export class InvalidOAuthConfigError extends GoogleOAuthBaseError {
  constructor(readonly missing: string[]) {
    super(
      `Configuration OAuth Google invalide — variables manquantes dans .env : ` +
        `${missing.join(', ')}. Renseignez-les puis redémarrez le backend.`,
    );
  }
}

/** The OAuth app is configured but no refresh token is present. */
export class MissingRefreshTokenError extends GoogleOAuthBaseError {
  constructor() {
    super(
      `GOOGLE_OAUTH_REFRESH_TOKEN absent. Lancez le consentement ` +
        `(GET /auth/google) avec le compte Gmail propriétaire du quota, puis ` +
        `collez le refresh token renvoyé dans .env (il doit couvrir les scopes ` +
        `Drive + Sheets).`,
    );
  }
}

/**
 * Google rejected the grant (`invalid_grant` / auth failure). Carries the
 * decoded Google fields + an actionable diagnostic. NON-RETRYABLE by design.
 */
export class GoogleOAuthGrantError extends GoogleOAuthBaseError {
  constructor(
    message: string,
    readonly googleError?: string,
    readonly googleErrorDescription?: string,
    readonly httpStatus?: number,
  ) {
    super(message);
  }
}

/** A Google Drive upload failed for a non-auth reason (after retries). */
export class GoogleDriveUploadError extends GoogleOAuthBaseError {
  constructor(
    message: string,
    readonly httpStatus?: number,
    readonly reason?: string,
  ) {
    super(message);
  }
}

/**
 * Mask a secret for logs: keep a short readable prefix, hide the rest, never
 * reveal the length precisely. `1//03zXbY…` → `1//03z…****`. Empty/undefined
 * → `<absent>`.
 */
export function maskSecret(value: string | undefined | null): string {
  if (!value) return '<absent>';
  const visible = value.slice(0, 6);
  return `${visible}…****`;
}

/**
 * Decode the many shapes googleapis surfaces an OAuth/HTTP error as, WITHOUT
 * throwing on any of them. Returns the fields worth logging.
 */
export function extractGoogleError(err: unknown): {
  error?: string;
  errorDescription?: string;
  httpStatus?: number;
  message: string;
} {
  const anyErr = err as any;
  // googleapis GaxiosError: err.response.data = { error, error_description }
  // for the token endpoint; for Drive API it's { error: { code, message } }.
  const data = anyErr?.response?.data;
  const oauthError =
    typeof data?.error === 'string' ? data.error : anyErr?.error;
  const oauthErrorDescription =
    data?.error_description ?? anyErr?.error_description;
  const httpStatus =
    anyErr?.response?.status ??
    (typeof anyErr?.code === 'number' ? anyErr.code : undefined);
  const message =
    data?.error?.message ??
    (typeof data?.error === 'string' ? data.error : undefined) ??
    anyErr?.errors?.[0]?.message ??
    anyErr?.message ??
    String(err);
  return {
    error: typeof oauthError === 'string' ? oauthError : undefined,
    errorDescription:
      typeof oauthErrorDescription === 'string'
        ? oauthErrorDescription
        : undefined,
    httpStatus: typeof httpStatus === 'number' ? httpStatus : undefined,
    message: String(message),
  };
}

/** True when Google returned `invalid_grant` (refresh token no longer usable). */
export function isInvalidGrant(err: unknown): boolean {
  const { error, message } = extractGoogleError(err);
  return error === 'invalid_grant' || /invalid_grant/i.test(message);
}

/** True for TRANSIENT failures worth retrying (rate limit / 5xx / network). */
export function isTransientError(err: unknown): boolean {
  const anyErr = err as any;
  const code = anyErr?.response?.status ?? anyErr?.code;
  if (code === 429) return true;
  if (typeof code === 'number' && code >= 500 && code < 600) return true;
  // Node network errors have string codes, never a numeric HTTP status.
  const netCodes = [
    'ETIMEDOUT',
    'ECONNRESET',
    'ECONNREFUSED',
    'ENOTFOUND',
    'EAI_AGAIN',
    'ESOCKETTIMEDOUT',
  ];
  return typeof code === 'string' && netCodes.includes(code);
}

/**
 * Build the actionable `invalid_grant` diagnostic. `invalid_grant` is NEVER
 * recoverable by retrying — it always means the refresh token is no longer
 * valid. List the concrete causes + the manual action, so the operator fixes
 * it instead of staring at "invalid_grant".
 */
export function buildInvalidGrantDiagnostic(err: unknown): GoogleOAuthGrantError {
  const { error, errorDescription, httpStatus } = extractGoogleError(err);
  const msg =
    `Google a rejeté le refresh token (invalid_grant) — le token n'est plus ` +
    `valide et AUCUN retry ne le récupérera. Causes possibles :\n` +
    `  1. Écran de consentement OAuth en mode "Testing" → les refresh tokens ` +
    `EXPIRENT au bout de 7 jours (cause la plus fréquente d'un token qui ` +
    `"marchait puis casse"). Publiez l'app en "In production" dans Google ` +
    `Cloud Console (OAuth consent screen).\n` +
    `  2. Token révoqué manuellement (myaccount.google.com/permissions) ou par ` +
    `un changement de mot de passe du compte Google.\n` +
    `  3. Client OAuth (CLIENT_ID/SECRET) différent de celui qui a émis le ` +
    `token — vérifiez que .env pointe le même projet OAuth.\n` +
    `  4. Plus de 50 refresh tokens émis pour ce couple (compte, client) : ` +
    `Google révoque silencieusement les plus anciens. Rejouer /auth/google en ` +
    `boucle (prompt=consent) déclenche ce cas.\n` +
    `  5. Token inutilisé pendant 6 mois.\n` +
    `ACTION MANUELLE REQUISE : relancez GET /auth/google avec le compte ` +
    `propriétaire du quota, copiez le nouveau refresh token dans ` +
    `GOOGLE_OAUTH_REFRESH_TOKEN (.env.<env>) et redémarrez le backend.`;
  return new GoogleOAuthGrantError(
    msg,
    error ?? 'invalid_grant',
    errorDescription,
    httpStatus,
  );
}
