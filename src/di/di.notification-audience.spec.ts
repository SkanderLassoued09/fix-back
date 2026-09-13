import { rolesForStatus, STATUS_DI } from './di.status';
import { toProfileRoles } from '../notifications/role-mapping';

/**
 * GARDE ANTI-DÉRIVE : « la notification part-elle à qui doit agir ? »
 *
 * Le problème corrigé : l'audience était recopiée À LA MAIN dans la vingtaine
 * d'appels d'`emitDiHandoff`. Rien ne la reliait au statut d'arrivée, et elle
 * avait dérivé — un retour prévenait la coordination et oubliait les trois
 * rôles responsables, dont le technicien qui allait reprendre la pièce ; le
 * dépôt d'un BC déplaçait la DI chez le magasin sans prévenir personne.
 *
 * Ce spec verrouille trois choses :
 *   1. tout statut est DÉCLARÉ (notifiant ou non, avec sa raison) — un statut
 *      ajouté sans décision fait échouer le test ;
 *   2. l'audience d'un statut notifiant contient TOUJOURS ses responsables ;
 *   3. tout rôle cité est résolvable (sinon la notification part au néant).
 *
 * Miroir back du test front `notification-deep-link.spec.ts`.
 */

/**
 * Décision explicite pour CHAQUE statut.
 *   - une chaîne = le type de notification émis en entrant dans ce statut ;
 *   - `'NONE'` = aucune notification VOULUE, avec la raison en commentaire.
 */
const STATUS_NOTIFICATION: Record<string, string | 'NONE'> = {
  // ── Passations entre services : toujours notifiées ───────────────────────
  [STATUS_DI.Pending1.status]: 'DI_PENDING1',
  [STATUS_DI.Pending2.status]: 'DI_PENDING2',
  [STATUS_DI.Pending3.status]: 'DI_PENDING3',
  [STATUS_DI.Diagnostic.status]: 'DI_ASSIGNED_DIAG',
  [STATUS_DI.MagasinEstimation.status]: 'DI_MAGASIN_ESTIMATION',
  [STATUS_DI.InMagasin.status]: 'DI_IN_MAGASIN',
  [STATUS_DI.ConfirmationComposants.status]: 'COMPONENTS_SENT_TO_COORDINATOR',
  [STATUS_DI.MagasinFinalisation.status]: 'COMPONENTS_CONFIRMED_BY_COORDINATOR',
  [STATUS_DI.Pricing.status]: 'DI_PRICING',
  [STATUS_DI.WaitingDevis.status]: 'DI_NEGOTIATION1',
  [STATUS_DI.WaitingBc.status]: 'DI_DOC_BC',
  [STATUS_DI.Negotiation2.status]: 'DI_NEGOTIATION2',
  [STATUS_DI.Reparation.status]: 'DI_ASSIGNED_REP',
  [STATUS_DI.WaitingBl.status]: 'DI_REP_FINISHED',
  [STATUS_DI.WaitingFacture.status]: 'DI_DOC_BL',
  [STATUS_DI.Finished.status]: 'DI_FINISHED',
  [STATUS_DI.Irreparable.status]: 'DI_IRREPARABLE',
  [STATUS_DI.Annuler.status]: 'DI_ANNULEE',
  [STATUS_DI.Retour1.status]: 'DI_RETOUR_1',
  [STATUS_DI.Retour2.status]: 'DI_RETOUR_2',
  [STATUS_DI.Retour3.status]: 'DI_RETOUR_3',

  // ── Sans notification, DÉLIBÉRÉMENT ─────────────────────────────────────
  // La DI vient d'être saisie par son créateur : il la voit, il est devant.
  [STATUS_DI.Created.status]: 'NONE',
  // Le technicien est lui-même l'ACTEUR de ces transitions (il démarre ou met
  // en pause SON propre travail). Se notifier soi-même est du bruit.
  [STATUS_DI.InDiagnostic.status]: 'NONE',
  [STATUS_DI.DiagnosticInPause.status]: 'NONE',
  [STATUS_DI.InReparation.status]: 'NONE',
  [STATUS_DI.ReparationInPause.status]: 'NONE',
};

/**
 * Audiences plus LARGES que les responsables du statut — chacune assumée.
 * Le test n'autorise que des SUR-ensembles : personne ne doit jamais être
 * retiré des responsables, mais informer au-delà reste un choix légitime.
 */
const DELIBERATE_SUPERSETS: Record<string, string[]> = {
  // Clôtures : tout le circuit est informé qu'un dossier se termine.
  DI_FINISHED: ['Coordinator', 'Magasin'],
  DI_IRREPARABLE: ['Coordinator', 'Magasin'],
  // La coordination suit les documents sans en être responsable.
  DI_DOC_BL: ['Coordinator'],
  DI_DOC_BC: ['Admin_Manager'],
  DI_NEGOTIATION1: ['Coordinator', 'Admin_Tech', 'Admin_Manager'],
  DI_REP_FINISHED: ['Coordinator'],
  DI_RETOUR_1: ['Coordinator'],
  DI_RETOUR_2: ['Coordinator'],
  DI_RETOUR_3: ['Coordinator'],
  // L'abandon remonte à l'encadrement en plus de la coordination.
  DI_ABANDONED: ['Admin_Manager', 'Admin_Tech'],
};

describe('Notifications DI — audience = responsabilité', () => {
  it('CHAQUE statut est déclaré : notifiant, ou « NONE » assumé', () => {
    // Un statut ajouté sans décision apparaît ici : il faut dire s'il notifie
    // (et qui), ou pourquoi il ne notifie pas.
    const undeclared = Object.values(STATUS_DI)
      .map((d) => d.status)
      .filter((st) => !(st in STATUS_NOTIFICATION));
    expect(undeclared).toEqual([]);
  });

  it('rolesForStatus rend EXACTEMENT les responsables déclarés', () => {
    const mismatches = Object.values(STATUS_DI)
      .filter(
        (d) => rolesForStatus(d.status).join('|') !== [...d.role].join('|'),
      )
      .map((d) => d.status);
    expect(mismatches).toEqual([]);
  });

  it('un statut inconnu retombe sur la coordination (jamais invisible)', () => {
    // Valeurs LEGACY non migrées : la DI doit rester adressée à quelqu'un.
    expect(rolesForStatus('ATTENTE_BC_DEVIS')).toEqual(['Coordinator']);
    expect(rolesForStatus(undefined)).toEqual(['Coordinator']);
    expect(rolesForStatus(null)).toEqual(['Coordinator']);
  });

  it('TOUT rôle responsable est résolvable vers une valeur profil réelle', () => {
    // Un rôle non traduit = une notification qui part au néant, en silence.
    const broken = Object.values(STATUS_DI)
      .map((d) => ({
        status: d.status,
        unresolved: toProfileRoles([...d.role]).unresolved,
      }))
      .filter((r) => r.unresolved.length);
    expect(broken).toEqual([]);
  });

  it('les sur-ensembles déclarés n’ajoutent que des rôles réels', () => {
    const broken = Object.entries(DELIBERATE_SUPERSETS)
      .map(([type, extra]) => ({
        type,
        unresolved: toProfileRoles(extra).unresolved,
      }))
      .filter((r) => r.unresolved.length);
    expect(broken).toEqual([]);
  });

  it('aucun sur-ensemble ne RETIRE un responsable', () => {
    // Élargir est permis ; rétrécir ne l'est pas. On vérifie que chaque type
    // élargi correspond bien à un statut déclaré (donc que sa base est les
    // responsables de ce statut, auxquels s'ajoute la liste ci-dessus).
    const declaredTypes = new Set(
      Object.values(STATUS_NOTIFICATION).filter((v) => v !== 'NONE'),
    );
    const orphans = Object.keys(DELIBERATE_SUPERSETS).filter(
      // DI_ABANDONED n'est pas une entrée en statut (retour en PENDING1) mais
      // un événement à part entière : il est légitimement hors de la table.
      (t) => !declaredTypes.has(t) && t !== 'DI_ABANDONED',
    );
    expect(orphans).toEqual([]);
  });

  it('le vocabulaire des statuts et celui des notifications sont le MÊME', () => {
    // C'est l'invariant qui autorise `notify.roles = rolesForStatus(status)`
    // sans traduction. S'il tombe, toute la dérivation d'audience est caduque.
    const statusVocab = new Set(
      Object.values(STATUS_DI).flatMap((d) => [...d.role]),
    );
    expect(toProfileRoles([...statusVocab]).unresolved).toEqual([]);
  });
});
