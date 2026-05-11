import { ObjectType, Field, Int, Float, registerEnumType } from '@nestjs/graphql';

/**
 * Granularity used when bucketizing the weekly-trend chart. Selected by the
 * frontend period filter — 7d/30d → DAY, 3m → WEEK, 12m → MONTH.
 */
export enum TrendGranularity {
  DAY = 'DAY',
  WEEK = 'WEEK',
  MONTH = 'MONTH',
}
registerEnumType(TrendGranularity, { name: 'TrendGranularity' });

// ─── KPI ATELIER (Section A) ────────────────────────────────────────────────
@ObjectType()
export class AtelierKpi {
  @Field(() => Float)
  tauxClotures: number;

  @Field(() => Float)
  tauxEnCours: number;

  /** Currently in-progress count (snapshot, not %). Drives the "DI en cours" knob. */
  @Field(() => Int)
  nbEnCours: number;
}

// ─── KPI DÉLAIS (Section B) ─────────────────────────────────────────────────
@ObjectType()
export class DelaisKpi {
  /** Average end-to-end TAT in days for DIs FINISHED in the period. */
  @Field(() => Float)
  tatMoyenJours: number;

  /** % of currently-open DIs whose status has not changed for > 72h. */
  @Field(() => Float)
  tauxStagnant: number;

  /** Average days an open DI has been sitting in its current status. */
  @Field(() => Float)
  delaiMoyenStatutJours: number;
}

// ─── SATISFACTION (Phase B; Phase A returns empty) ──────────────────────────
@ObjectType()
export class SatisfactionKpi {
  /** Null until DiRating schema lands in Phase B. */
  @Field(() => Float, { nullable: true })
  score: number | null;

  @Field(() => Int, { nullable: true })
  nbReclamations: number | null;
}

// ─── VOLUME & CHARGE (Section C) ────────────────────────────────────────────
@ObjectType()
export class VolumeKpi {
  @Field(() => Int)
  nbRecus: number;

  @Field(() => Int)
  nbClotures: number;

  @Field(() => Int)
  nbEnCours: number;

  @Field(() => Int)
  nbRetours: number;
}

// ─── WEEKLY TREND (Section D) ───────────────────────────────────────────────
@ObjectType()
export class TrendPoint {
  /** Bucket label — "01/02", "S05", "Jan 2025" depending on granularity. */
  @Field()
  label: string;

  /** ISO date for the bucket start (sortable on the FE). */
  @Field()
  bucketStart: Date;

  @Field(() => Int)
  recus: number;

  @Field(() => Int)
  clotures: number;

  @Field(() => Int)
  retours: number;
}

// ─── DI PAR CATÉGORIE (Section E) ───────────────────────────────────────────
@ObjectType()
export class CategorySlice {
  @Field({ nullable: true })
  categoryId: string;

  @Field()
  categoryName: string;

  @Field(() => Int)
  count: number;
}

// ─── TECH LEADERBOARD (Section G) ───────────────────────────────────────────
@ObjectType()
export class TechLeaderRow {
  @Field()
  techId: string;

  @Field()
  techName: string;

  @Field({ nullable: true })
  role: string;

  @Field(() => Int)
  nbDiTraites: number;

  @Field(() => Int)
  nbDiClotures: number;

  /** First Time Right: % of FINISHED DIs that never went into RETOUR (ignoreCount = 0). */
  @Field(() => Float)
  firstTimeRight: number;

  @Field(() => Float)
  tauxRetours: number;

  /** Average days from createdAt to FINISHED for DIs touched by this tech. */
  @Field(() => Float)
  tatMoyenJours: number;

  @Field(() => Float)
  tauxIrreparables: number;
}

// ─── FINANCE (Section H — Phase A subset) ───────────────────────────────────
@ObjectType()
export class FinanceKpi {
  /** % of FINISHED DIs that have a facture PDF attached. */
  @Field(() => Float, { nullable: true })
  tauxFacturation: number | null;

  /** Sum of final_price for FINISHED DIs with a facture in the period. */
  @Field(() => Float, { nullable: true })
  caFacture: number | null;

  /** All metrics below require the Phase B Invoice/Payment schemas. */
  @Field(() => Float, { nullable: true })
  margeBrute: number | null;

  @Field(() => Float, { nullable: true })
  coutHoraire: number | null;

  @Field(() => Float, { nullable: true })
  tauxRecouvrement: number | null;

  @Field(() => Float, { nullable: true })
  creances: number | null;

  @Field(() => Float, { nullable: true })
  facturesGt90: number | null;

  @Field(() => Float, { nullable: true })
  delaiPaiementJours: number | null;
}

@ObjectType()
export class FinanceTrendPoint {
  @Field()
  label: string;

  @Field()
  bucketStart: Date;

  @Field(() => Float)
  caFacture: number;

  @Field(() => Float, { nullable: true })
  tauxFacturation: number | null;
}

// ─── COMPOSITE TOP-LEVEL RESPONSE ───────────────────────────────────────────
@ObjectType()
export class DashboardKpi {
  @Field(() => AtelierKpi)
  atelier: AtelierKpi;

  @Field(() => DelaisKpi)
  delais: DelaisKpi;

  @Field(() => SatisfactionKpi)
  satisfaction: SatisfactionKpi;

  @Field(() => VolumeKpi)
  volume: VolumeKpi;

  @Field(() => FinanceKpi)
  finance: FinanceKpi;
}
