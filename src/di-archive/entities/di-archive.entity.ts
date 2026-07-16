import { Field, ObjectType, registerEnumType } from '@nestjs/graphql';
import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document } from 'mongoose';

/**
 * `DiArchive` — collection DÉDIÉE et STANDALONE pour les DI historiques importées
 * depuis Excel. AUCUN lien avec l'entité `Di` opérationnelle (pas de ref, pas de
 * client_id/location_id, pas de garde de transition). L'import Di en masse
 * existant reste STRICTEMENT inchangé.
 */

/**
 * Complétude DOCUMENTAIRE (dimension 1) — combien des 4 documents sont présents.
 *  - INCOMPLET : au moins un des 4 (bc/bl/devis/facture) absent — DÉFAUT.
 *  - COMPLET   : les 4 documents présents.
 *  - CLOTURE   : les 4 présents ET clôturé par un admin/manager (terminal).
 * Nommage : enum interne SANS accent (`CLOTURE`) ; libellé affiché « Clôturé ».
 */
export enum StatutCompletude {
  INCOMPLET = 'INCOMPLET',
  COMPLET = 'COMPLET',
  CLOTURE = 'CLOTURE',
}
registerEnumType(StatutCompletude, { name: 'StatutCompletude' });

/**
 * Statut MÉTIER HISTORIQUE (dimension 2, DISTINCTE de `statutCompletude`) —
 * l'état repris du registre Excel (Livré, Terminé, Annulé, En cours, Att. BC…).
 * TEXTE LIBRE : le vocabulaire réel du registre est riche et hétérogène, on
 * stocke donc le libellé VERBATIM du fichier (aucun rejet « statut non reconnu »),
 * découplé du workflow opérationnel `STATUS_DI`. `null` quand le fichier n'a pas
 * de colonne Statut.
 */

/**
 * Provenance de l'enregistrement.
 *  - MANUAL    : créé via l'API/mutation `createDiArchive` (défaut).
 *  - MIGRATION : créé par l'import de masse .xlsx (estampillé + importBatchId).
 * Le chemin MIGRATION (statut historique écrit directement + origin + batch)
 * n'est JAMAIS exposé à l'API normale — il passe par `createFromMigration`.
 */
export enum DiArchiveOrigin {
  MANUAL = 'MANUAL',
  MIGRATION = 'MIGRATION',
}
registerEnumType(DiArchiveOrigin, { name: 'DiArchiveOrigin' });

/** The 4 uploadable document slots (input enum for the upload/remove mutations). */
export enum DiArchiveDocType {
  BC = 'BC',
  BL = 'BL',
  DEVIS = 'DEVIS',
  FACTURE = 'FACTURE',
}
registerEnumType(DiArchiveDocType, { name: 'DiArchiveDocType' });

/**
 * Référence de document Google Drive — STRICTEMENT la même structure que
 * `Di.driveDocs[*]` / la sortie de `uploadDiDocToDrive` (`{ driveFileId,
 * webViewLink, name }`). VIDE (null) à l'import ; rempli plus tard via l'UI.
 */
@ObjectType()
export class DriveDocRef {
  @Field({ nullable: true })
  driveFileId?: string;
  @Field({ nullable: true })
  webViewLink?: string;
  @Field({ nullable: true })
  name?: string;
}

@Schema({ timestamps: true, collection: 'di_archives' })
export class DiArchiveDocument extends Document {
  @Prop()
  _id: string;
  @Prop()
  title: string;
  @Prop()
  description: string;
  @Prop()
  // « N° Série »
  numSerie: string;
  @Prop()
  // rangement / emplacement — string libre (PAS un ref Location)
  arrangement: string;

  // Client — string simple (PAS de résolution/ref) : neutralise l'effet Drive à
  // la migration ; servira au nommage du dossier Drive plus tard.
  @Prop({ default: null })
  clientNom: string | null;

  // Société — string simple, JUMEAU de `clientNom` : AUCUNE résolution/ref vers
  // une entité, aucune auto-création. Le registre distingue client (personne) vs
  // société ; deux champs texte distincts (classification manuelle/ultérieure).
  @Prop({ default: null })
  societeNom: string | null;

  // Référence d'origine (« N° DI » du fichier) — clé d'idempotence de la migration.
  @Prop({ default: null })
  refOrigine: string | null;

  // 4 documents — fichier Drive uploadé (même forme que `Di.driveDocs[*]`). null
  // tant que rien n'est uploadé.
  @Prop({ type: Object, default: null })
  bc: DriveDocRef | null;
  @Prop({ type: Object, default: null })
  bl: DriveDocRef | null;
  @Prop({ type: Object, default: null })
  devis: DriveDocRef | null;
  @Prop({ type: Object, default: null })
  facture: DriveDocRef | null;

  // Références TEXTE des 4 documents, reprises des colonnes du registre Excel
  // (ex. « 072/24 »). Un doc compte comme PRÉSENT (pour la complétude) s'il a
  // une réf ici OU un upload Drive ci-dessus. Cellule vide → doc à uploader.
  @Prop({ default: null })
  bcRef: string | null;
  @Prop({ default: null })
  blRef: string | null;
  @Prop({ default: null })
  devisRef: string | null;
  @Prop({ default: null })
  factureRef: string | null;
  // « Valid. Client » — validation client (métadonnée, PAS dans la complétude 4-docs).
  @Prop({ default: null })
  validClient: string | null;

  // Dimension 1 — complétude documentaire. Défaut INCOMPLET.
  @Prop({
    type: String,
    enum: Object.values(StatutCompletude),
    default: StatutCompletude.INCOMPLET,
  })
  statutCompletude: StatutCompletude;

  // Dimension 2 — statut métier historique repris VERBATIM du fichier (texte
  // libre : Livré, En cours, Att. BC…). null si le fichier n'a pas de colonne.
  @Prop({ type: String, default: null })
  statutHistorique: string | null;

  // Traçabilité migration.
  @Prop({
    type: String,
    enum: Object.values(DiArchiveOrigin),
    default: DiArchiveOrigin.MANUAL,
  })
  origin: DiArchiveOrigin;
  @Prop({ default: null })
  importBatchId: string | null;

  createdAt: Date;
  updatedAt: Date;
}
export const DiArchiveSchema = SchemaFactory.createForClass(DiArchiveDocument);

// Idempotence : un `refOrigine` (N° DI) migré ne peut exister qu'une fois.
// PARTIAL (pas sparse) : n'indexe que les valeurs string → les lignes de base
// sans refOrigine (null) ne sont pas contraintes.
DiArchiveSchema.index(
  { refOrigine: 1 },
  { unique: true, partialFilterExpression: { refOrigine: { $type: 'string' } } },
);

// Ordre par défaut de la liste `/archives` (dernier créé en premier) sur une
// collection volumineuse (~1400 lignes) paginée CÔTÉ SERVEUR : sans cet index,
// chaque page force un tri en mémoire de toute la collection filtrée.
DiArchiveSchema.index({ createdAt: -1 });

@ObjectType()
export class DiArchive {
  @Field({ nullable: true })
  _id: string;
  @Field({ nullable: true })
  title: string;
  @Field({ nullable: true })
  description: string;
  @Field({ nullable: true })
  numSerie: string;
  @Field({ nullable: true })
  arrangement: string;
  @Field({ nullable: true })
  clientNom?: string;
  @Field({ nullable: true })
  societeNom?: string;
  @Field({ nullable: true })
  refOrigine?: string;

  @Field(() => DriveDocRef, { nullable: true })
  bc?: DriveDocRef;
  @Field(() => DriveDocRef, { nullable: true })
  bl?: DriveDocRef;
  @Field(() => DriveDocRef, { nullable: true })
  devis?: DriveDocRef;
  @Field(() => DriveDocRef, { nullable: true })
  facture?: DriveDocRef;

  // Références texte des documents (reprises du registre).
  @Field({ nullable: true })
  bcRef?: string;
  @Field({ nullable: true })
  blRef?: string;
  @Field({ nullable: true })
  devisRef?: string;
  @Field({ nullable: true })
  factureRef?: string;
  @Field({ nullable: true })
  validClient?: string;

  @Field(() => StatutCompletude)
  statutCompletude: StatutCompletude;
  @Field({ nullable: true })
  statutHistorique?: string;

  @Field(() => DiArchiveOrigin)
  origin: DiArchiveOrigin;
  @Field({ nullable: true })
  importBatchId?: string;

  @Field({ nullable: true })
  createdAt?: Date;
  @Field({ nullable: true })
  updatedAt?: Date;
}
