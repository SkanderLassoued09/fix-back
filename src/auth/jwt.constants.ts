/**
 * Secret de signature des JWT — SOURCE UNIQUE, partagée par `JwtModule`
 * (signature), `JwtStrategy` (vérification Passport) et `request-context`
 * (vérification souple pour identifier l'acteur des notifications).
 *
 * ⚠️ Toujours codé en dur (valeur historique inchangée) : le passage en
 * variable d'environnement relève d'une passe sécurité dédiée.
 */
export const JWT_SECRET = 'hide-me';
