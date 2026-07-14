import { Field, InputType, Int } from '@nestjs/graphql';
import {
  DiArchiveDocType,
  StatutCompletude,
} from '../entities/di-archive.entity';

/**
 * Filters for the `/archives` list — ALL cumulative (AND). `missingDocs` uses
 * the registry-side « manquant » rule ([[di-archive-filter.util]] · isDocMissing):
 * selecting Facture + BL returns rows missing BOTH. Text fields are
 * case-insensitive "contains"; the enum fields are multi-select ($in).
 */
@InputType()
export class DiArchivesFilterInput {
  @Field(() => [DiArchiveDocType], { nullable: true })
  missingDocs?: DiArchiveDocType[];

  // Free-text columns (case-insensitive contains).
  @Field({ nullable: true }) refOrigine?: string;
  @Field({ nullable: true }) title?: string;
  @Field({ nullable: true }) numSerie?: string;
  /** Matches clientNom OR societeNom (one column in the UI). */
  @Field({ nullable: true }) client?: string;
  @Field({ nullable: true }) arrangement?: string;
  @Field({ nullable: true }) validClient?: string;

  // Enumerated columns (multi-select dropdowns).
  @Field(() => [StatutCompletude], { nullable: true })
  statutCompletude?: StatutCompletude[];
  @Field(() => [String], { nullable: true })
  statutHistorique?: string[];
}

/**
 * Pagination + sort for the `/archives` list. `page` is 1-based; `sortField` is
 * validated against a whitelist server-side (default createdAt DESC).
 */
@InputType()
export class DiArchivesPageInput {
  @Field(() => Int, { nullable: true, defaultValue: 1 })
  page?: number;
  @Field(() => Int, { nullable: true, defaultValue: 12 })
  limit?: number;
  @Field({ nullable: true })
  sortField?: string;
  @Field(() => Int, { nullable: true })
  sortOrder?: number; // 1 asc, -1 desc
}
