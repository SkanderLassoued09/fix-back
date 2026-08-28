/**
 * Résolution des comptes de test À L'EXÉCUTION.
 *
 * Les specs codaient en dur l'`_id` du technicien. Deux bases coexistent sur ce
 * poste (`fixtronix`, `fixtronixproddb`) avec des `_id` différents pour le même
 * username, donc un id figé rend la DI seedée invisible dans la liste tech et la
 * spec échoue pour une raison sans rapport avec le flux testé. On lit le profil
 * dans la base réellement utilisée.
 */

/** `_id` du profil pour un username donné. Jette si le compte n'existe pas. */
export async function profileIdByUsername(
  db: any,
  username: string,
): Promise<string> {
  const p = await db
    .collection('profiles')
    .findOne({ username, isDeleted: { $ne: true } }, { projection: { _id: 1 } });
  if (!p?._id) {
    throw new Error(
      `Compte de test « ${username} » introuvable dans la base ${db.databaseName}. ` +
        `Vérifiez MONGO_DB (l'app lit fixtronixproddb).`,
    );
  }
  return String(p._id);
}

/** `_id` du technicien de test (username « tech »). */
export function techId(db: any): Promise<string> {
  return profileIdByUsername(db, 'tech');
}
