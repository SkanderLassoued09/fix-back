import { ObjectType, Field } from '@nestjs/graphql';
import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document } from 'mongoose';
import { Client } from 'src/clients/entities/client.entity';
import { Company } from 'src/company/entities/company.entity';
import { DiCategory } from 'src/di_category/entities/di_category.entity';
import { Location } from 'src/location/entities/location.entity';
import { LogsDi } from 'src/logs-di/entities/logs-di.entity';
import { Profile } from 'src/profile/entities/profile.entity';

@Schema({ timestamps: true })
export class DiDocument extends Document {
  @Prop()
  _id: string;
  @Prop()
  _idnum: string;
  @Prop()
  // title of DI
  title: string;
  @Prop()
  // description of DI
  description: string;
  @Prop()
  nSerie: string;
  @Prop()
  // repair or not
  can_be_repaired: boolean;
  @Prop()
  // pdr or not
  contain_pdr: boolean;
  @Prop({ type: String, ref: 'Profile' })
  // created by who
  createdBy: Profile;
  @Prop({ type: String, ref: 'Client' })
  // belongs to which client
  client_id: Client;
  @Prop({ type: String, ref: 'Company' })
  // belongs to which company
  company_id: Company;

  @Prop({ type: String, ref: 'DiCategory' })
  // belongs to which category
  di_category_id: DiCategory;
  @Prop({ type: String, ref: 'Location' })
  // belongs to which location
  location_id: Location;
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
  // Drive references keyed by DocType (BC/Devis/BL/Facture/Image):
  // { driveFileId, webViewLink, name }. The webViewLink is also mirrored into
  // the scalar fields above (devis/bon_de_commande/…) so the FE "Voir" link
  // opens Drive directly. Mongo-only (not exposed to GraphQL).
  @Prop({ type: Object, default: {} })
  driveDocs: Record<
    string,
    { driveFileId: string; webViewLink: string; name: string }
  >;
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
  array_composants: Array<ComposantStructure>;
  @Prop(() => [String])
  current_workers_ids: [string];
  @Prop(() => [String])
  current_roles: [string];
  @Prop({ default: false })
  isDeleted: boolean;
  @Prop({ default: 0 })
  ignoreCount: number;
  @Prop({ defaultValue: false })
  isOpenedOnce: boolean;
  @Prop({ defaultValue: false })
  gotComposantFromMagasin: string;
  // confirmation component for magasin and coordinator section
  @Prop({ default: false })
  isConfirmedComponentFromCoordinator: boolean;
  @Prop({ default: false })
  isSentToCoordinator: boolean;

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
  isErrorFromFixtronix: boolean;
  @Prop({
    nullable: true,
    enum: ['DEFAULT', 'IN_COORDINATOR', 'IN_MAGASIN'],
    default: 'IN_COORDINATOR',
  })
  handleSendingNotificationBetweenCoordinatorAndMagasin: string;
  @Prop({ nullable: true })
  remarque_coordinator: string;
  @Prop({ nullable: true })
  confirmationComposant: string;

  @Prop({ default: null })
  pricingRequestSentAt: Date | null;
  @Prop({ type: String, ref: 'Profile', default: null })
  pricingRequestSentBy: string | null;
  @Prop({ default: null })
  componentsConfirmedAt: Date | null;
  @Prop({ type: String, ref: 'Profile', default: null })
  componentsConfirmedBy: string | null;

  // ---- Stagnation tracking ------------------------------------------------
  // Stamped every time `status` changes (via the pre-save / pre-update hooks
  // below). Powers the generic stagnation monitor — `now - statusUpdatedAt`
  // is all the detector needs.
  @Prop({ default: null })
  statusUpdatedAt: Date | null;
  // ------------------------------------------------------------------------

  // Retour (return) tracking — motif + timestamp of the latest retour, shown
  // in the coordinator "Contrôle du Flow" banner.
  @Prop({ default: null })
  retourReason: string | null;
  @Prop({ default: null })
  retourDate: Date | null;

  createdAt: Date;
  updatedAt: Date;
}
export const DiSchema = SchemaFactory.createForClass(DiDocument);
DiSchema.index({ location_id: 1, isDeleted: 1 });
DiSchema.index({ di_category_id: 1, isDeleted: 1 });
// Dashboard analytics — status×createdAt and status×updatedAt cover the
// volume/trend/category/finance aggregations.
DiSchema.index({ status: 1, createdAt: -1 });
DiSchema.index({ status: 1, updatedAt: -1 });
DiSchema.index({ di_category_id: 1, createdAt: -1 });
// Stagnation detector — bounded query against this index.
DiSchema.index({ status: 1, statusUpdatedAt: 1 });
DiSchema.index({ statusUpdatedAt: 1, isDeleted: 1 });

// ---- statusUpdatedAt hooks ------------------------------------------------
// Every path that changes `status` stamps the timestamp automatically so the
// stagnation monitor stays correct without each call site remembering.
DiSchema.pre('save', function (next) {
  // `this` is the document; `isModified` covers creates and direct edits.
  // For a brand-new doc we still want statusUpdatedAt populated.
  if (this.isNew || this.isModified('status')) {
    this.set('statusUpdatedAt', new Date());
  }
  next();
});

// `findOneAndUpdate` / `updateOne` / `updateMany` go through Query middleware.
// We inspect the pending update payload — if `status` is being set, mirror a
// `statusUpdatedAt` set on the same update so a single round-trip persists
// both fields atomically.
function stampStatusUpdatedAtOnQueryUpdate(this: any, next: () => void) {
  const update = this.getUpdate?.();
  if (!update) return next();
  const set = update.$set ?? update;
  if (set && Object.prototype.hasOwnProperty.call(set, 'status')) {
    if (update.$set) {
      update.$set.statusUpdatedAt = new Date();
    } else {
      update.statusUpdatedAt = new Date();
    }
    this.setUpdate(update);
  }
  next();
}
DiSchema.pre('findOneAndUpdate', stampStatusUpdatedAtOnQueryUpdate);
DiSchema.pre('updateOne', stampStatusUpdatedAtOnQueryUpdate);
DiSchema.pre('updateMany', stampStatusUpdatedAtOnQueryUpdate);
// ------------------------------------------------------------------------

@ObjectType()
export class Di {
  @Field({ nullable: true })
  _id: string;
  @Field({ nullable: true })
  _idnum: string;
  @Field({ nullable: true })
  comment: string;
  @Field({ nullable: true })
  title: string;
  @Field({ nullable: true })
  nSerie: string;
  @Field({ nullable: true })
  confirmationComposant: string;
  @Field({ nullable: true })
  pricingRequestSentAt?: Date;
  @Field({ nullable: true })
  pricingRequestSentBy?: string;
  @Field({ nullable: true })
  componentsConfirmedAt?: Date;
  @Field({ nullable: true })
  componentsConfirmedBy?: string;
  @Field({ nullable: true })
  retourReason?: string;
  @Field({ nullable: true })
  retourDate?: Date;
  @Field({ nullable: true })
  description: string;

  //* Booleans
  @Field({ nullable: true })
  can_be_repaired: boolean;
  @Field({ nullable: true })
  contain_pdr: boolean;
  @Field({ defaultValue: false })
  isDeleted: boolean;

  //? ID's
  // Nullable: a CLIENT-type DI has no company_id and vice-versa; legacy rows
  // may have no createdBy. Non-nullable here crashes Apollo on such rows.
  @Field({ nullable: true })
  createdBy: string;
  @Field({ nullable: true })
  client_id: string;
  @Field({ nullable: true })
  company_id: string;
  // Resolved entity (populated by getDiById) so the modal shows the client's /
  // company's contacts without a second round-trip. Nullable: a DI targets
  // exactly one entity, so the other side is null.
  @Field(() => Client, { nullable: true })
  client?: Client;
  @Field(() => Company, { nullable: true })
  company?: Company;
  @Field(() => [String])
  current_workers_ids: [string];
  @Field(() => [String])
  current_roles: [string];
  //* Array of composants
  @Field(() => [ComposantStructure], { nullable: true })
  array_composants: ComposantStructure[];

  //! Remarque entity containing all the Remarques

  //! entity created by admins
  @Field({ nullable: true })
  di_category_id: string;
  //! Location entity ID
  @Field({ nullable: true })
  location_id: string;
  //! entity STATS ID of technicians
  @Field({ nullable: true })
  stats_id: string;
  //!Files
  @Field({ nullable: true })
  image: string;
  @Field({ nullable: true })
  devis: string;
  @Field({ nullable: true })
  facture: string;
  @Field({ nullable: true })
  bon_de_commande: string;
  @Field({ nullable: true })
  bon_de_livraison: string;

  @Field({ nullable: true })
  price: number;
  @Field({ nullable: true })
  final_price: number;
  @Field({ nullable: true })
  discount: number;
  @Field({ nullable: true })
  discount_value: number;

  @Field({ nullable: true })
  type_client: string;

  @Field({ nullable: true })
  service_quality: string;

  @Field({ nullable: true })
  ignoreCount: number;
  @Field({ nullable: true })
  isOpenedOnce: boolean;
  // Magasin sending composants to coordinatrice
  @Field({ defaultValue: false })
  isConfirmedComponentFromCoordinator: boolean;
  @Field({ defaultValue: false })
  isSentToCoordinator: boolean;
  @Field({ defaultValue: false })
  gotComposantFromMagasin: string;
  @Field({ nullable: true })
  status: string;
  @Field({ nullable: true })
  remarque_manager: string;
  @Field({ nullable: true })
  remarque_admin_manager: string;
  @Field({ nullable: true })
  remarque_admin_tech: string;
  @Field({ nullable: true })
  remarque_tech_diagnostic: string;
  @Field({ nullable: true })
  remarque_tech_repair: string;
  @Field({ nullable: true })
  remarque_magasin: string;
  @Field({ nullable: true })
  remarque_coordinator: string;
  @Field({ nullable: true })
  handleSendingNotificationBetweenCoordinatorAndMagasin: string;
  @Field({ nullable: true })
  isErrorFromFixtronix: boolean;

  // ---- Stagnation tracking ------------------------------------------------
  @Field({ nullable: true })
  statusUpdatedAt?: Date;
}

@ObjectType()
export class ComposantStructure {
  @Field({ nullable: true })
  nameComposant: string;
  @Field({ nullable: true })
  quantity: number;
  @Field({ nullable: true, defaultValue: false })
  isUpdated: boolean;
}
@ObjectType()
export class RemarqueDi {
  @Field()
  _id: string;
  @Field()
  remarque_manager: string;
  @Field({ nullable: true })
  remarque_admin_manager: string;
  @Field({ nullable: true })
  remarque_admin_tech: string;
  @Field({ nullable: true })
  remarque_tech_diagnostic: string;
  @Field({ nullable: true })
  remarque_tech_repair: string;
  @Field({ nullable: true })
  remarque_magasin: string;
  @Field({ nullable: true })
  remarque_coordinator: string;
}
@ObjectType()
export class ClientDi {
  @Field()
  _id: string;
  @Field()
  first_name: string;
  @Field()
  last_name: string;
}
@ObjectType()
export class CreatedByDi {
  @Field()
  _id: string;
  @Field()
  firstName: string;
  @Field()
  lastName: string;
}

@ObjectType()
export class LocationDi {
  @Field()
  _id: string;
  @Field()
  location_name: string;
}
@ObjectType()
export class CategoryDi {
  @Field()
  _id: string;
  @Field()
  category_Di: string;
}

@ObjectType()
export class StatusCount {
  @Field()
  status: string;
  @Field()
  count: number;
}
@ObjectType()
export class DiTable {
  @Field({ nullable: true })
  _id: string;
  @Field({ nullable: true })
  _idnum: string;
  @Field({ nullable: true })
  comment: string;
  @Field({ nullable: true })
  title: string;
  @Field({ nullable: true })
  description: string;
  @Field({ nullable: true })
  techRep: string;
  @Field({ nullable: true })
  techDiag: string;
  @Field({ nullable: true })
  can_be_repaired: boolean;
  @Field({ nullable: true })
  devis: string;
  @Field({ nullable: true })
  facture: string;
  @Field({ nullable: true })
  bon_de_commande: string;
  @Field({ nullable: true })
  bon_de_livraison: string;
  @Field({ nullable: true })
  contain_pdr: boolean;
  @Field({ nullable: true })
  status: string;
  @Field({ nullable: true })
  createdAt: string;
  @Field({ nullable: true })
  updatedAt: string;
  @Field(() => [String], { nullable: true })
  current_roles: string[];
  @Field({ nullable: true })
  image: string;
  @Field({ nullable: true })
  company_id: string;
  @Field({ nullable: true })
  client_id: string;
  @Field({ nullable: true })
  createdBy: string;
  @Field({ nullable: true })
  ignoreCount: number;
  @Field({ nullable: true })
  location_id: string;
  /** Display name of the linked emplacement, resolved server-side. */
  @Field({ nullable: true })
  location_name: string;
  @Field({ nullable: true })
  isSentToCoordinator: boolean;
  @Field({ nullable: true, defaultValue: false })
  isConfirmedComponentFromCoordinator: boolean;
  @Field({ nullable: true, defaultValue: false })
  di_category_id: string;
  /** Display name of the linked DI category, resolved server-side. */
  @Field({ nullable: true })
  di_category_name: string;
  @Field(() => [ComposantStructure], { nullable: true })
  array_composants: ComposantStructure[];
  /** remarque section  */
  @Field({ nullable: true })
  remarque_manager: string;
  @Field({ nullable: true })
  remarque_admin_manager: string;
  @Field({ nullable: true })
  remarque_admin_tech: string;
  @Field({ nullable: true })
  remarque_tech_diagnostic: string;
  @Field({ nullable: true })
  remarque_tech_repair: string;
  @Field({ nullable: true })
  remarque_magasin: string;
  @Field({ nullable: true })
  remarque_coordinator: string;
  @Field({ nullable: true })
  isErrorFromFixtronix: boolean;
  @Field(() => [LogsDi], { nullable: true })
  logs: LogsDi[];
  @Field({ nullable: true })
  price: number;
  @Field({ nullable: true })
  handleSendingNotificationBetweenCoordinatorAndMagasin: string;
  @Field({ nullable: true })
  pricingRequestSentAt?: Date;
  @Field({ nullable: true })
  pricingRequestSentBy?: string;
  @Field({ nullable: true })
  componentsConfirmedAt?: Date;
  @Field({ nullable: true })
  componentsConfirmedBy?: string;
  @Field({ nullable: true })
  final_price: number;

  // ---- Stagnation tracking (surfaced on the table view) -------------------
  @Field({ nullable: true })
  statusUpdatedAt?: Date;

  // ---- Retour (return) tracking — motif + date of the latest retour --------
  @Field({ nullable: true })
  retourReason?: string;
  @Field({ nullable: true })
  retourDate?: Date;
}
@ObjectType()
export class DiTableData {
  @Field(() => [DiTable])
  di: DiTable[];

  @Field()
  totalDiCount: number;
}

@ObjectType()
export class UpdateNego {
  @Field()
  price: number;
  @Field()
  final_price: number;
}

@ObjectType()
export class LogsDiData {
  @Field(() => [LogsDi], { nullable: true })
  logsDi?: LogsDi[];
  @Field()
  di: Di;
}
