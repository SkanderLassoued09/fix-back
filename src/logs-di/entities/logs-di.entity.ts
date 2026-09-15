import { ObjectType, Field, Float, Int } from '@nestjs/graphql';
import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document } from 'mongoose';
import { DiCategory } from 'src/di_category/entities/di_category.entity';
import { DriveDoc } from 'src/common/graphql/drive-doc.type';
@Schema({ timestamps: true })
export class DiLogsDocument extends Document {
  @Prop()
  _id: string;
  @Prop()
  _idDi: string;
  @Prop()
  idIgnore: number;
  @Prop()
  // repair or not
  can_be_repaired: boolean;
  @Prop({ default: false })
  // pdr or not
  contain_pdr: boolean;
  // « Réparation réussie ? » / « Tests validés ? » du wizard réparation.
  // `null` = non renseigné (réparation antérieure, ou cycle pas encore réparé).
  @Prop({ type: Boolean, default: null })
  repair_success: boolean | null;
  @Prop({ type: Boolean, default: null })
  tests_validated: boolean | null;

  @Prop()
  // stats of tech
  stats_id: string;
  @Prop()
  // pdf file
  image: string;
  @Prop()
  // pdf file
  devis: string;
  @Prop()
  // pdf file
  facture: string;
  @Prop()
  // pdf file
  bon_de_commande: string;
  @Prop()
  // pdf file
  bon_de_livraison: string;
  @Prop()
  // affected by magasin
  price: number;
  @Prop()
  // affected by admins
  final_price: number;
  @Prop()
  discount: number;
  @Prop()
  discount_value: number;
  @Prop()
  type_client: string;
  @Prop()
  service_quality: string;
  @Prop()
  // status of DI
  status: string;
  @Prop()
  array_composants: Array<ComposantStructureLogs>;
  @Prop(() => [String])
  current_workers_ids: [string];
  @Prop(() => [String])
  current_roles: [string];
  @Prop({ default: false })
  isDeleted: boolean;

  @Prop({ defaultValue: false })
  isOpenedOnce: boolean;
  // Same root-cause fix as Di.gotComposantFromMagasin: string → boolean.
  @Prop({ type: Boolean, default: false })
  gotComposantFromMagasin: boolean;
  // confirmation component for magasin and coordinator section
  @Prop({ default: false })
  isConfirmedComponentFromCoordinator: boolean;
  @Prop({ default: false })
  isSentToCoordinator: boolean;
  @Prop({ type: String, ref: 'DiCategory' })
  di_category_id: DiCategory;
  @Prop()
  comment: string;
  /** remarque section  */
  @Prop({ nullable: true })
  remarque_manager: string;
  @Prop({ nullable: true })
  remarque_admin_manager: string;
  @Prop({ nullable: true })
  remarque_admin_tech: string;
  @Prop({ nullable: true })
  remarque_tech_diagnostic: string;
  @Prop({ nullable: true })
  remarque_tech_repair: string;
  @Prop({ nullable: true })
  remarque_magasin: string;
  @Prop({ nullable: true })
  remarque_coordinator: string;
  @Prop({
    nullable: true,
    enum: ['DEFAULT', 'IN_COORDINATOR', 'IN_MAGASIN'],
    default: 'IN_COORDINATOR',
  })
  handleSendingNotificationBetweenCoordinatorAndMagasin: string;
  @Prop({ nullable: true })
  confirmationComposant: string;

  @Prop({ nullable: true, default: false })
  isErrorFromFixtronix: boolean;

  // ─── Le cycle possede ses propres donnees ────────────────────────────────
  // Cette ligne n'est plus une simple trace : c'est LE dossier du cycle. Tout
  // ce qui appartient a un cycle (verdict, composants, documents, prix,
  // remarques) vit ici ; la DI n'en garde qu'un MIROIR du cycle courant, pour
  // les lecteurs aveugles au cycle (filtre magasin, routeurs, handshake).

  // References Drive du cycle, memes clefs que `Di.driveDocs`
  // (BC/Devis/BL/Facture) : { driveFileId, webViewLink, name }. Sans elles la
  // ligne ne portait qu'une URL nue, donc ni le vrai nom de fichier ni de quoi
  // satisfaire `isDriveDocRef` — et les portes documentaires ne voyaient rien.
  // `Image` reste au niveau DI (photo de creation, pas un livrable de cycle).
  @Prop({ type: Object, default: {} })
  driveDocs: Record<
    string,
    { driveFileId: string; webViewLink: string; name: string }
  >;

  // Bornes du cycle. `closedAt` est pose a l'ouverture du cycle SUIVANT : il
  // rend verifiable l'invariant « on n'ecrit jamais dans un cycle clos ».
  @Prop({ default: null })
  openedAt: Date | null;
  @Prop({ default: null })
  closedAt: Date | null;

  // Motif/date du retour qui a OUVERT ce cycle (donc jamais sur le cycle 0).
  // Sur la DI ces deux champs sont ecrases a chaque retour : le motif du
  // retour 1 y etait perdu des le retour 2. Ici il est conserve par cycle.
  @Prop({ default: null })
  retourReason: string | null;
  @Prop({ default: null })
  retourDate: Date | null;

  // Ligne DEDUITE apres coup par la migration 014, PAS observee en direct.
  // Meme convention que `Di.statusHistory[].reconstructed` : une donnee
  // reconstituee ne doit jamais se faire passer pour une donnee mesuree.
  @Prop({ type: Boolean, default: false })
  reconstructed: boolean;
  @Prop({ default: null })
  reconstructedReason: string | null;

  @Prop({ type: Number, default: null })
  repairEstimate: number;
  @Prop({ type: Boolean, default: false })
  needsDevisBeforeRepair: boolean;
  @Prop({ default: null })
  pricingRequestSentAt: Date | null;
  @Prop({ type: String, ref: 'Profile', default: null })
  pricingRequestSentBy: string | null;
  @Prop({ default: null })
  componentsConfirmedAt: Date | null;
  @Prop({ type: String, ref: 'Profile', default: null })
  componentsConfirmedBy: string | null;
  @Prop({ default: null })
  stockDecrementedAt: Date | null;

  createdAt: Date;
  updatedAt: Date;
}
export const DiLogsSchema = SchemaFactory.createForClass(DiLogsDocument);

// UNE seule ligne de snapshot par (DI, cycle de retour). Sans cette contrainte,
// `logsDiService.create` — appelé à chaque affectation de technicien — insérait
// une 2e ligne lors d'une réaffectation : l'écriture du verdict (findOneAndUpdate)
// et sa lecture (findOne) pouvaient alors viser des documents DIFFÉRENTS, et le
// routeur concluait « pas d'erreur Fixtronix » → PENDING2 → facturation client.
// Effet de bord corrigé au passage : la liste des retours est indexée PAR POSITION
// côté front (logsDi[0] = Retour 1), donc un doublon décalait tous les libellés.
// La collection n'avait jusqu'ici AUCUN index (COLLSCAN à chaque lecture).
DiLogsSchema.index({ _idDi: 1, idIgnore: 1 }, { unique: true });

@ObjectType()
export class LogsDi {
  @Field(() => String, { nullable: true })
  _id: string;
  @Field(() => String, { nullable: true })
  _idDi?: string;
  @Field(() => Number, { nullable: true })
  idIgnore?: number;
  @Field(() => Boolean, { nullable: true })
  can_be_repaired?: boolean;

  @Field(() => Boolean, { nullable: true })
  contain_pdr?: boolean;

  @Field(() => Boolean, { nullable: true })
  repair_success?: boolean | null;

  @Field(() => Boolean, { nullable: true })
  tests_validated?: boolean | null;

  @Field(() => String, { nullable: true })
  stats_id?: string;

  @Field(() => String, { nullable: true })
  image?: string;

  @Field(() => String, { nullable: true })
  devis?: string;

  @Field(() => String, { nullable: true })
  facture?: string;

  @Field(() => String, { nullable: true })
  bon_de_commande?: string;

  @Field(() => String, { nullable: true })
  bon_de_livraison?: string;

  @Field(() => Number, { nullable: true })
  price?: number;

  @Field(() => Number, { nullable: true })
  final_price?: number;

  @Field(() => Number, { nullable: true })
  discount?: number;

  @Field(() => Number, { nullable: true })
  discount_value?: number;

  @Field(() => String, { nullable: true })
  type_client?: string;

  @Field(() => String, { nullable: true })
  service_quality?: string;

  @Field(() => String, { nullable: true })
  di_category_id: string;
  @Field(() => String, { nullable: true })
  status?: string;

  @Field(() => [ComposantStructureLogs], { nullable: true })
  array_composants?: Array<ComposantStructureLogs>;

  @Field(() => [String], { nullable: true })
  current_workers_ids?: string[];

  @Field(() => [String], { nullable: true })
  current_roles?: string[];

  @Field(() => Boolean, { nullable: true })
  isDeleted?: boolean;

  @Field(() => Boolean, { nullable: true })
  isErrorFromFixtronix: boolean;
  @Field(() => Boolean, { nullable: true })
  isOpenedOnce?: boolean;

  @Field(() => Boolean, { nullable: true })
  gotComposantFromMagasin?: boolean;

  @Field(() => Boolean, { nullable: true })
  isConfirmedComponentFromCoordinator?: boolean;

  @Field(() => Boolean, { nullable: true })
  isSentToCoordinator?: boolean;

  @Field(() => String, { nullable: true })
  handleSendingNotificationBetweenCoordinatorAndMagasin: string;
  @Field(() => String, { nullable: true })
  comment?: string;

  @Field(() => String, { nullable: true })
  remarque_manager?: string;

  @Field(() => String, { nullable: true })
  remarque_admin_manager?: string;

  @Field(() => String, { nullable: true })
  remarque_admin_tech?: string;

  @Field(() => String, { nullable: true })
  remarque_tech_diagnostic?: string;

  @Field(() => String, { nullable: true })
  remarque_tech_repair?: string;

  @Field(() => String, { nullable: true })
  remarque_magasin?: string;

  @Field(() => String, { nullable: true })
  remarque_coordinator?: string;

  @Field(() => String, { nullable: true })
  confirmationComposant?: string;

  /** Documents REELS du cycle (nom + lien Drive), derives de `driveDocs`.
   *  Meme forme que `Di.documents` : l'onglet d'un cycle lit CETTE liste, et
   *  n'a donc plus aucune raison de retomber sur les fichiers de la DI. */
  @Field(() => [DriveDoc], { nullable: true })
  documents?: DriveDoc[];

  @Field(() => Date, { nullable: true })
  openedAt?: Date;
  @Field(() => Date, { nullable: true })
  closedAt?: Date;
  @Field(() => String, { nullable: true })
  retourReason?: string;
  @Field(() => Date, { nullable: true })
  retourDate?: Date;
  @Field(() => Boolean, { nullable: true })
  reconstructed?: boolean;
  @Field(() => String, { nullable: true })
  reconstructedReason?: string;
  @Field(() => Number, { nullable: true })
  repairEstimate?: number;
  @Field(() => Boolean, { nullable: true })
  needsDevisBeforeRepair?: boolean;
  @Field(() => Date, { nullable: true })
  pricingRequestSentAt?: Date;
  @Field(() => String, { nullable: true })
  pricingRequestSentBy?: string;
  @Field(() => Date, { nullable: true })
  componentsConfirmedAt?: Date;
  @Field(() => String, { nullable: true })
  componentsConfirmedBy?: string;

  @Field(() => Date, { nullable: true })
  createdAt?: Date;

  @Field(() => Date, { nullable: true })
  updatedAt?: Date;
}

@ObjectType()
export class ComposantStructureLogs {
  @Field({ nullable: true })
  nameComposant: string;
  @Field({ nullable: true })
  quantity: number;
  @Field({ nullable: true, defaultValue: false })
  isUpdated: boolean;
  /** Prix de vente catalogue figé quand le magasin valide la pièce (phase
   *  diagnostic). Écrit par le serveur uniquement — absent des inputs. */
  @Field(() => Float, { nullable: true })
  prixVenteDiag?: number;
  /** Prix de vente catalogue figé à la fin de la réparation. */
  @Field(() => Float, { nullable: true })
  prixVenteRep?: number;
}
