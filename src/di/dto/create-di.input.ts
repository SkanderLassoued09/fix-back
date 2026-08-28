import { InputType, Field } from '@nestjs/graphql';

@InputType()
export class SearchDiInput {
  @Field()
  field: string;

  @Field()
  value: string;
}

@InputType()
export class CreateDiInput {
  @Field({ nullable: true })
  _id: string;
  @Field({ nullable: true })
  _idnum: string;
  @Field({ nullable: true })
  comment: string;
  @Field({ nullable: true })
  title: string;
  @Field({ nullable: true })
  location: string;
  @Field({ nullable: true })
  description: string;
  @Field({ nullable: true })
  remarqueTech: string;
  @Field({ nullable: true })
  can_be_repaired: boolean;
  @Field({ nullable: true })
  location_id: string;
  @Field({ nullable: true })
  di_category_id: string;
  @Field({ nullable: true })
  contain_pdr: boolean;
  @Field({ nullable: true })
  client_id: string;
  @Field({ nullable: true })
  company_id: string;
  @Field({ nullable: true })
  nSerie: string;
  // « Date de réception » — only set by the bulk .xlsx import (backlog DIs keep
  // their original reception date). Normal creation leaves it undefined.
  @Field({ nullable: true })
  dateReception: Date;
  @Field({ nullable: true })
  price: number;
  @Field({ nullable: true })
  finalPrice: number;
  // Diagnostic payant (défaut true = payant, comportement actuel) + estimation
  // du prix de diagnostic saisie à la création (pré-remplit la tarification).
  @Field({ defaultValue: true })
  diagnosticPayant: boolean;
  @Field({ nullable: true })
  diagnosticEstimate: number;
  @Field({ nullable: true })
  discount_percentage: number;
  @Field({ nullable: true })
  discount_value: number;

  @Field({ nullable: true })
  typeClient: string;
  @Field({ nullable: true })
  createdBy: string;
  @Field({ nullable: true })
  assigned_diagnostic: string;
  @Field({ nullable: true })
  assigned_reperation: string;
  @Field({ nullable: true })
  assigned_retour: string;
  @Field(() => [ComposantStructureInput], { nullable: true })
  array_composants: ComposantStructureInput[];

  //files
  @Field({ nullable: true })
  image: string;
  @Field({ nullable: true })
  Devis: string;
  @Field({ nullable: true })
  facture: string;
  @Field({ nullable: true })
  bon_de_commande: string;
  @Field({ nullable: true })
  bon_de_livraison: string;

  @Field({ nullable: true })
  status: string;

  @Field({ nullable: true })
  isOpenedOnce: boolean;

  @Field({ defaultValue: false })
  gotComposantFromMagasin: boolean;

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
}
@InputType()
export class PaginationConfigDi {
  @Field()
  rows: number;
  @Field()
  first: number;
}
@InputType()
export class FilterConfigDi {
  @Field({ nullable: true })
  startDate?: string;

  @Field({ nullable: true })
  endDate?: string;
}
@InputType()
export class ComposantStructureInput {
  @Field()
  nameComposant: string;
  @Field()
  quantity: number;
  @Field({ nullable: true, defaultValue: false })
  isUpdated: boolean;
}

@InputType()
export class DiagUpdate {
  @Field()
  remarque_tech_diagnostic: string;
  @Field()
  contain_pdr: boolean;
  @Field()
  di_category_id: string;
  @Field({ nullable: true })
  isErrorFromFixtronix: boolean;
  @Field()
  can_be_repaired: boolean;
  @Field(() => [ComposantStructureInput], { nullable: true })
  array_composants: ComposantStructureInput[];
}

/**
 * Partial-update DTO. Only `_id` is required; every other field is
 * optional so reassignment flows (location, DI category) and the legacy
 * full-edit flow share one mutation. The DI service strips `undefined`
 * keys before `$set`, so a request that supplies only `_id + location_id`
 * does NOT clear title/description/remarque.
 */
@InputType()
export class UpdateDi {
  @Field()
  _id: string;
  @Field({ nullable: true })
  title?: string;
  @Field({ nullable: true })
  description?: string;
  @Field({ nullable: true })
  remarque_manager?: string;
  @Field({ nullable: true })
  location_id?: string;
  @Field({ nullable: true })
  di_category_id?: string;
  // Repair-close fields — the wizard's « Fin réparation » persists the tech's
  // repair note + the used parts via `saveRepairParts` (an updateDi). These were
  // missing from the input type, so that mutation failed GraphQL validation
  // (the masked error behind the double toast). `updateDi` $sets any provided
  // field, so adding them here is enough — no service change.
  @Field({ nullable: true })
  remarque_tech_repair?: string;
  @Field(() => [ComposantStructureInput], { nullable: true })
  array_composants?: ComposantStructureInput[];
}

/**
 * Édition ADMINISTRATIVE d'une DI — réservée au rôle `ADMIN_TECH` (garde de
 * rôle sur la mutation `adminTechUpdateDi`).
 *
 * Volontairement SÉPARÉ de `UpdateDi` : ce dernier est utilisé par l'assistant
 * de réparation du technicien (`saveRepairParts`), donc y poser une garde de
 * rôle casserait le flux tech. Ici on ouvre l'ensemble des champs DESCRIPTIFS
 * et COMMERCIAUX du dossier.
 *
 * Ce que cet input n'expose PAS, délibérément : `status` / `statusHistory`
 * (les transitions passent par `assertDiTransition` — les éditer directement
 * contournerait la garde de workflow), les temps `Stat`, et les horodatages.
 * L'intégrité de la piste d'audit prime sur la commodité d'édition.
 */
@InputType()
export class AdminTechUpdateDiInput {
  @Field()
  _id: string;

  // ── Identification ────────────────────────────────────────────────────────
  @Field({ nullable: true })
  title?: string;
  @Field({ nullable: true })
  description?: string;
  @Field({ nullable: true })
  nSerie?: string;
  @Field({ nullable: true })
  comment?: string;
  @Field(() => Date, { nullable: true })
  dateReception?: Date;
  @Field({ nullable: true })
  di_category_id?: string;
  @Field({ nullable: true })
  location_id?: string;

  // ── Verdict diagnostic ────────────────────────────────────────────────────
  @Field({ nullable: true })
  can_be_repaired?: boolean;
  @Field({ nullable: true })
  contain_pdr?: boolean;
  @Field({ nullable: true })
  isErrorFromFixtronix?: boolean;
  @Field({ nullable: true })
  needsDevisBeforeRepair?: boolean;
  @Field({ nullable: true })
  retourReason?: string;
  @Field(() => [ComposantStructureInput], { nullable: true })
  array_composants?: ComposantStructureInput[];

  // ── Remarques (les 7) ─────────────────────────────────────────────────────
  @Field({ nullable: true })
  remarque_manager?: string;
  @Field({ nullable: true })
  remarque_admin_manager?: string;
  @Field({ nullable: true })
  remarque_admin_tech?: string;
  @Field({ nullable: true })
  remarque_tech_diagnostic?: string;
  @Field({ nullable: true })
  remarque_tech_repair?: string;
  @Field({ nullable: true })
  remarque_magasin?: string;
  @Field({ nullable: true })
  remarque_coordinator?: string;

  // ── Finances ──────────────────────────────────────────────────────────────
  @Field({ nullable: true })
  price?: number;
  @Field({ nullable: true })
  final_price?: number;
  @Field({ nullable: true })
  repairEstimate?: number;
  @Field({ nullable: true })
  diagnosticEstimate?: number;
  @Field({ nullable: true })
  diagnosticPayant?: boolean;
  @Field({ nullable: true })
  discount?: number;
  @Field({ nullable: true })
  discount_value?: number;
  @Field({ nullable: true })
  type_client?: string;
  @Field({ nullable: true })
  service_quality?: string;
}
