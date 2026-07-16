import { registerEnumType } from '@nestjs/graphql';

/**
 * Generic operational alert classification. The system is intentionally
 * status-agnostic — any future operational signal can be added here without
 * touching the alert pipeline. Today's generators are stagnation-driven.
 */
export enum AlertType {
  // Seuil ACTIF : la détection de stagnation n'émet plus qu'à 48h (voir
  // StagnationService.THRESHOLDS). Les trois seuils ci-dessous sont conservés
  // dans l'enum pour que les alertes DÉJÀ en base (24h/72h/7j) restent valides
  // vis-à-vis du schéma (aucune purge) — ils ne sont plus générés.
  DI_STAGNANT_48H = 'DI_STAGNANT_48H',
  DI_STAGNANT_24H = 'DI_STAGNANT_24H',
  DI_STAGNANT_72H = 'DI_STAGNANT_72H',
  DI_STAGNANT_7D = 'DI_STAGNANT_7D',
}

export enum AlertSeverity {
  INFO = 'INFO',
  WARNING = 'WARNING',
  CRITICAL = 'CRITICAL',
}

registerEnumType(AlertType, {
  name: 'AlertType',
  description: 'Operational alert classification.',
});
registerEnumType(AlertSeverity, {
  name: 'AlertSeverity',
  description: 'Operational alert severity level.',
});

export const ALERT_TYPE_VALUES = Object.values(AlertType);
export const ALERT_SEVERITY_VALUES = Object.values(AlertSeverity);
