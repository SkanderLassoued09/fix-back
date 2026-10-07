import {
  Resolver,
  Mutation,
  Args,
  Query,
  Subscription,
  Float,
  Int,
} from '@nestjs/graphql';
import { DiService } from './di.service';
import {
  ComposantPhaseCost,
  Di,
  DiTable,
  DiTableData,
  LogsDiData,
  RepairPriceBreakdown,
  StatusCount,
  UpdateNego,
  RetourResult,
} from './entities/di.entity';
import {
  AdminTechUpdateDiInput,
  CreateDiInput,
  DiagUpdate,
  FilterConfigDi,
  PaginationConfigDi,
  SearchDiInput,
  UpdateDi,
  UpdateDiInfoInput,
} from './dto/create-di.input';
import { AnnulerDiInput } from './dto/annuler-di.input';
import { AbandonDiInput } from './dto/abandon-di.input';
import { User as CurrentUser } from 'src/auth/profile.decorator';
import { Profile } from 'src/profile/entities/profile.entity';
import { ProfileService } from 'src/profile/profile.service';
import { UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from 'src/auth/jwt-auth-guard';
import { RolesGuard } from 'src/auth/role-guard';
import { Roles, Role } from 'src/profile/role-decorator';
import { GraphQLError } from 'graphql';
import { error, log } from 'console';
import { StatService } from 'src/stat/stat.service';
import { PubSub } from 'graphql-subscriptions';
import { Stat } from 'src/stat/entities/stat.entity';
import { rootCertificates } from 'tls';
import { withErrorContext, reportCatchError } from '../common/error-context';

@Resolver(() => Di)
export class DiResolver {
  // used to convert from string to number
  timeStringToSeconds(timeString) {
    try {
      const [hours, minutes, seconds] = timeString.trim().split(':').map(Number);
      return hours * 3600 + minutes * 60 + seconds;
    } catch (error) {
      throw withErrorContext(error, 'DiResolver.timeStringToSeconds');
    }
  }

  // Function to convert seconds to "hh:mm:ss"
  secondsToTimeString(totalSeconds) {
    try {
      const hours = Math.floor(totalSeconds / 3600);
      const minutes = Math.floor((totalSeconds % 3600) / 60);
      const seconds = totalSeconds % 60;
      return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(
      2,
      '0',
    )}:${String(seconds).padStart(2, '0')}`;
    } catch (error) {
      throw withErrorContext(error, 'DiResolver.secondsToTimeString');
    }
  }

  constructor(
    private readonly diService: DiService,
    private readonly statService: StatService,
    private readonly pubsub: PubSub,
    private readonly profileService: ProfileService,
  ) {}

  /**
   * Annulation d'une DI par le coordinateur, CONFIRMÉE PAR MOT DE PASSE.
   * Authentifiée (`@CurrentUser`) — on sait ainsi CONTRE QUI vérifier le mot de
   * passe et QUI a annulé. Le mot de passe est vérifié côté serveur contre le
   * hash de l'utilisateur courant puis jeté (jamais loggué/stocké/renvoyé) ; un
   * échec ⇒ erreur claire, AUCUNE modification de la DI.
   */
  @Mutation(() => Di)
  @UseGuards(JwtAuthGuard)
  async annulerDi(
    @Args('AnnulerDiInput') input: AnnulerDiInput,
    @CurrentUser() profile: Profile,
  ) {
    try {
      const ok = await this.profileService.verifyPassword(
        profile.username,
        input.password,
      );
      if (!ok) {
        throw new GraphQLError('Mot de passe incorrect.', {
          extensions: { code: 'UNAUTHENTICATED' },
        });
      }
      return await this.diService.annulerDi(input.diId, {
        parClient: input.parClient,
        motif: input.motif,
        motifAutre: input.motifAutre,
        commentaire: input.commentaire,
        // `username` (lisible) plutôt que `_id` → affichage direct « par … » dans
        // le modal détail, sans résolution id→nom dans les mappers de liste.
        annulePar: profile.username,
      });
    } catch (error) {
      throw withErrorContext(error, 'DiResolver.annulerDi');
    }
  }

  /** RÉACTIVATION d'une DI annulée → statut précédent (lu dans statusHistory).
   *  Gouvernance : coordinatrice + admins (rôle TECH EXCLU), garde de rôle BACK
   *  réelle (pas un bouton masqué). Auteur tracé (Audit) via `@CurrentUser`.
   *  Refus back : non annulée / sans statut précédent / origine post-document
   *  (BL·facture émis) / déjà réactivée une fois. */
  @Mutation(() => Di)
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(Role.COORDIANTOR, Role.ADMIN_MANAGER, Role.ADMIN_TECH)
  async reactiverDi(
    @Args('diId') diId: string,
    @CurrentUser() profile: Profile,
  ) {
    try {
      return await this.diService.reactiverDi(diId, { username: profile?.username });
    } catch (error) {
      throw withErrorContext(error, 'DiResolver.reactiverDi');
    }
  }

  /**
   * ABANDON du diagnostic par un technicien. AUTHENTIFIÉE (`@CurrentUser`) — on
   * sait ainsi QUI abandonne (`abandonedBy`). La DI retourne en PENDING1 pour
   * réaffectation ; l'abandon est tracé (motif/qui/quand) dans l'historique.
   */
  @Mutation(() => Di)
  @UseGuards(JwtAuthGuard)
  async abandonDi(
    @Args('AbandonDiInput') input: AbandonDiInput,
    @CurrentUser() profile: Profile,
  ) {
    try {
      return await this.diService.abandonDi(input.diId, {
        motif: input.motif,
        motifAutre: input.motifAutre,
        abandonedBy: profile.username,
      });
    } catch (error) {
      throw withErrorContext(error, 'DiResolver.abandonDi');
    }
  }

  @Mutation(() => Di)
  @UseGuards(JwtAuthGuard)
  async createDi(
    @Args('createDiInput') createDiInput: CreateDiInput,
    @CurrentUser() profile: Profile,
  ) {
    try {
      createDiInput.createdBy = profile._id;
      return await this.diService.createDi(createDiInput);
    } catch (error) {
      throw withErrorContext(error, 'DiResolver.createDi');
    }
  }

  @Mutation(() => Di)
  async addDevis(@Args('_id') _id: string, @Args('pdf') pdf: string) {
    try {
      return await this.diService.addDevisPDF(_id, pdf);
    } catch (error) {
      throw withErrorContext(error, 'DiResolver.addDevis');
    }
  }

  @Mutation(() => Di)
  async addBl(@Args('_id') _id: string, @Args('pdf') pdf: string) {
    try {
      return await this.diService.addBlPDF(_id, pdf);
    } catch (error) {
      throw withErrorContext(error, 'DiResolver.addBl');
    }
  }
  @Mutation(() => Di)
  async addFacture(@Args('_id') _id: string, @Args('pdf') pdf: string) {
    try {
      return await this.diService.addFacturePDF(_id, pdf);
    } catch (error) {
      throw withErrorContext(error, 'DiResolver.addFacture');
    }
  }
  @Mutation(() => Di)
  async addBC(@Args('_id') _id: string, @Args('pdf') pdf: string) {
    try {
      return await this.diService.addBCPDF(_id, pdf);
    } catch (error) {
      throw withErrorContext(error, 'DiResolver.addBC');
    }
  }

  /**
   * Migration: wipe stale `driveFolderId` on every company + client so their
   * Drive folders are recreated (under the new OAuth account) on the next
   * upload. Run once after switching Drive auth from service account → OAuth.
   */
  @Mutation(() => String)
  async resetAllDriveFolders() {
    try {
      const r = await this.diService.resetAllDriveFolders();
      return `Drive folders reset — companies: ${r.companies}, clients: ${r.clients}`;
    } catch (error) {
      throw withErrorContext(error, 'DiResolver.resetAllDriveFolders');
    }
  }

  @Query(() => DiTableData)
  async getAllDi(
    @Args('paginationConfig') paginationConfig: PaginationConfigDi,
    @Args('filterConfig', { nullable: true }) filterConfig?: FilterConfigDi,
  ) {
    try {
      return await this.diService.getAllDi(paginationConfig, filterConfig);
    } catch (error) {
      throw withErrorContext(error, 'DiResolver.getAllDi');
    }
  }
  @Query(() => DiTableData)
  async searchDi(
    @Args('paginationConfig') paginationConfig: PaginationConfigDi,
    // Liste : filtres de colonnes cumulatifs (un objet seul reste accepté).
    @Args('search', { type: () => [SearchDiInput] }) search: SearchDiInput[],
    @Args('filterConfig', { nullable: true }) filterConfig?: FilterConfigDi,
  ) {
    try {
      return await this.diService.searchDi(
        paginationConfig,
        search,
        // filterConfig,
      );
    } catch (error) {
      throw withErrorContext(error, 'DiResolver.searchDi');
    }
  }

  @Query(() => LogsDiData)
  async getDiById(@Args('_id') _id: string) {
    try {
      const diData = await this.diService.getDiById(_id);
      return diData;
    } catch (error) {
      reportCatchError(error, 'DiResolver.getDiById');
      throw new Error(error);
    }
  }

  /** Détail d'UNE DI (même projection que la liste coordinatrice) pour le modal
   *  détail partagé ouvert au clic d'une notification (deep-link). */
  @Query(() => DiTable, { nullable: true })
  async getDiDetail(@Args('_id') _id: string) {
    try {
      return await this.diService.getDiDetailById(_id);
    } catch (error) {
      throw withErrorContext(error, 'DiResolver.getDiDetail');
    }
  }

  @Mutation(() => Di)
  async sendComponentToConMagasinForConfirmation(@Args('_id') _id: string) {
    try {
      return await this.diService.sendComponentToConMagasinForConfirmation(_id);
    } catch (error) {
      throw withErrorContext(error, 'DiResolver.sendComponentToConMagasinForConfirmation');
    }
  }

  @Mutation(() => Di)
  @UseGuards(JwtAuthGuard)
  async componentConfirmedFromCoordinator(
    @Args('_id') _id: string,
    @CurrentUser() profile: Profile,
  ) {
    try {
      return await this.diService.componentConfirmedFromCoordinator(
        _id,
        profile?._id ?? null,
      );
    } catch (error) {
      throw withErrorContext(error, 'DiResolver.componentConfirmedFromCoordinator');
    }
  }

  @Mutation(() => Di)
  @UseGuards(JwtAuthGuard)
  async sendDiToAdminsForPricing(
    @Args('diId') diId: string,
    @CurrentUser() profile: Profile,
  ) {
    try {
      return await this.diService.sendDiToAdminsForPricing(
        diId,
        profile?._id ?? null,
      );
    } catch (error) {
      throw withErrorContext(error, 'DiResolver.sendDiToAdminsForPricing');
    }
  }

  @Mutation(() => Di)
  @UseGuards(JwtAuthGuard)
  async confirmDiComponents(
    @Args('diId') diId: string,
    @CurrentUser() profile: Profile,
  ) {
    try {
      return await this.diService.confirmDiComponents(
        diId,
        profile?._id ?? null,
      );
    } catch (error) {
      throw withErrorContext(error, 'DiResolver.confirmDiComponents');
    }
  }

  @Mutation(() => Di)
  async confirmationComposant(
    @Args('_id') _id: string,
    @Args('confirmationState') confirmationState: string,
    @Args('_idNotification', { nullable: true }) _idNotification?: string,
  ) {
    try {
      this.pubsub.publish('confirmation-composant', {
        notificationConfirmation: {
          _id,
        },
      });
      return await this.diService.confirmationBetweenMagasinAndCoordinator(
        _id,
        confirmationState,
        _idNotification,
      );
    } catch (error) {
      throw withErrorContext(error, 'DiResolver.confirmationComposant');
    }
  }

  @Subscription(() => Di)
  notificationConfirmation() {
    try {
      return this.pubsub.asyncIterator('confirmation-composant');
    } catch (error) {
      throw withErrorContext(error, 'DiResolver.notificationConfirmation');
    }
  }

  @Mutation(() => Di)
  async deleteDi(@Args('_id') _id: string) {
    try {
      return await this.diService.deleteDi(_id);
    } catch (error) {
      throw withErrorContext(error, 'DiResolver.deleteDi');
    }
  }

  // AUTHENTIFIÉE (comme `createDi`) : sans ça, le back ignore QUI modifie une DI
  // → traçabilité impossible. `@CurrentUser` expose l'identité de l'acteur pour
  // la future journalisation des modifications (édition de référence, etc.).
  // Tous les appelants front passent par Apollo (lien `setContext` global qui
  // attache `Authorization: Bearer <token>` depuis `localStorage`).
  @Mutation(() => Di)
  @UseGuards(JwtAuthGuard)
  async updateDi(
    @Args('UpdateDi') updateDi: UpdateDi,
    @CurrentUser() profile: Profile,
  ) {
    try {
      return await this.diService.updateDi(updateDi);
    } catch (error) {
      throw withErrorContext(error, 'DiResolver.updateDi');
    }
  }

  /**
   * Édition administrative du dossier — RÉSERVÉE à `ADMIN_TECH`.
   *
   * Mutation DISTINCTE de `updateDi` à dessein : `updateDi` est appelée par
   * l'assistant de réparation du technicien (`saveRepairParts`), donc y ajouter
   * une garde de rôle serait une régression. Ici la garde est stricte, et
   * l'édition est journalisée (`SystemEvent DI_EDITED`) avec son acteur.
   */
  @Mutation(() => Di)
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(Role.ADMIN_TECH)
  async adminTechUpdateDi(
    @Args('input') input: AdminTechUpdateDiInput,
    @CurrentUser() profile: Profile,
  ) {
    try {
      return await this.diService.adminTechUpdateDi(input, {
        id: (profile as any)?._id ?? null,
        role: (profile as any)?.role ?? null,
      });
    } catch (error) {
      throw withErrorContext(error, 'DiResolver.adminTechUpdateDi');
    }
  }

  /**
   * Modal « Modifier la DI » du tableau des interventions : infos saisies à la
   * création. Rôles = ceux qui accèdent à cette page (`role-routes.ts` front).
   *
   * DISTINCTE de `updateDi` (non gardée) pour la même raison
   * qu'`adminTechUpdateDi` : client/société et photo ne doivent pas devenir
   * modifiables par un technicien. Statut, cohérence client/société et verrou
   * de tarification sont gardés dans le service ; l'édition est journalisée.
   */
  @Mutation(() => Di)
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(Role.MANAGER, Role.ADMIN_MANAGER, Role.ADMIN_TECH)
  async updateDiInfo(
    @Args('input') input: UpdateDiInfoInput,
    @CurrentUser() profile: Profile,
  ) {
    try {
      return await this.diService.updateDiInfo(input, {
        id: (profile as any)?._id ?? null,
        role: (profile as any)?.role ?? null,
      });
    } catch (error) {
      throw withErrorContext(error, 'DiResolver.updateDiInfo');
    }
  }

  @Query(() => Di)
  async getAllRemarque(@Args('_id') _id: string) {
    try {
      return await this.diService.getAllRemarque(_id);
    } catch (error) {
      throw withErrorContext(error, 'DiResolver.getAllRemarque');
    }
  }

  @Query(() => DiTableData)
  async searchCoordinatorDI(
    @Args('paginationConfig') paginationConfig: PaginationConfigDi,
    // Liste : filtres de colonnes cumulatifs (un objet seul reste accepté).
    @Args('search', { type: () => [SearchDiInput] }) search: SearchDiInput[],
  ) {
    try {
      return await this.diService.searchCoordinatorDI(paginationConfig, search);
    } catch (error) {
      throw withErrorContext(error, 'DiResolver.searchCoordinatorDI');
    }
  }

  @Query(() => DiTableData)
  async get_coordinatorDI(
    @Args('paginationConfig') paginationConfig: PaginationConfigDi,
  ) {
    try {
      return await this.diService.get_coordinatorDI(paginationConfig);
    } catch (error) {
      throw withErrorContext(error, 'DiResolver.get_coordinatorDI');
    }
  }
  @Query(() => DiTableData)
  async getDiForMagasin(
    @Args('paginationConfig') paginationConfig: PaginationConfigDi,
  ) {
    try {
      return await this.diService.getDiForMagasin(paginationConfig);
    } catch (error) {
      throw withErrorContext(error, 'DiResolver.getDiForMagasin');
    }
  }

  @Query(() => DiTableData)
  async searchDiForMagasin(
    @Args('paginationConfig') paginationConfig: PaginationConfigDi,
    // Liste : filtres de colonnes cumulatifs. La coercition GraphQL accepte
    // encore un objet seul (liste d'un élément).
    @Args('search', { type: () => [SearchDiInput] }) search: SearchDiInput[],
  ) {
    try {
      return await this.diService.searchDiForMagasin(paginationConfig, search);
    } catch (error) {
      throw withErrorContext(error, 'DiResolver.searchDiForMagasin');
    }
  }

  @Mutation(() => Di)
  async setSelectedComponentAsDone(
    @Args('_id') _id: string,
    @Args('nameComposant') nameComposant: string,
  ) {
    try {
      return await this.diService.setSelectedComponentAsDone(_id, nameComposant);
    } catch (error) {
      throw withErrorContext(error, 'DiResolver.setSelectedComponentAsDone');
    }
  }

  @Mutation(() => Di)
  async manager_Pending1(@Args('_id') _id: string) {
    try {
      return await this.diService.manager_Pending1(_id);
    } catch (error) {
      throw withErrorContext(error, 'DiResolver.manager_Pending1');
    }
  }

  // `addPDFFile` SUPPRIME. C'etait la seule ecriture de documents SANS aucune
  // branche de cycle : elle posait facture + BL et `driveDocs` directement sur
  // la DI, ecrasant donc les fichiers du cycle 0 depuis un cycle retour. Morte
  // cote UI (`sendFilePdf()` n'avait aucun appelant) : l'interface enregistre
  // via `addBL` + `addFacture`, qui passent par le chemin unique par cycle.
  @Mutation(() => Boolean)
  @UseGuards(JwtAuthGuard)
  async tech_startDiagnostic(
    @CurrentUser() user: Profile,
    @Args('_id') _id: string,
    @Args('diag') diag: DiagUpdate,
  ) {
    try {
      // Only the technician the DI is assigned to (diagnostic) may start it.
      await this.statService.assertTechOwnsDi(_id, user, 'diag');
      // `await` OBLIGATOIRE : sans lui la promesse FLOTTE. Une erreur métier
      // (GraphQLError) devient alors un « unhandled rejection » et Node ABAT LE
      // PROCESSUS — l'API entière tombe. Et `if (promesse)` est toujours vrai, donc
      // la mutation répondait `true` même quand l'écriture avait échoué.
      await this.diService.tech_startDiagnostic(_id, diag);
      return true;
    } catch (error) {
      throw withErrorContext(error, 'DiResolver.tech_startDiagnostic');
    }
  }

  @Mutation(() => Di)
  async markAsSeen(@Args('_id') _id: string) {
    try {
      return await this.diService.markAsSeen(_id);
    } catch (error) {
      throw withErrorContext(error, 'DiResolver.markAsSeen');
    }
  }

  @Query(() => [StatusCount])
  async getStatusCount() {
    try {
      return await this.diService.getStatusCount();
    } catch (error) {
      throw withErrorContext(error, 'DiResolver.getStatusCount');
    }
  }

  @Mutation(() => Boolean)
  @UseGuards(JwtAuthGuard)
  async tech_startReperation(
    @CurrentUser() user: Profile,
    @Args('_id') _id: string,
  ) {
    try {
      // Only the technician the DI is assigned to (réparation) may start it.
      await this.statService.assertTechOwnsDi(_id, user, 'rep');
      // `await` OBLIGATOIRE : sans lui la promesse FLOTTE. Une erreur métier
      // (GraphQLError) devient alors un « unhandled rejection » et Node ABAT LE
      // PROCESSUS — l'API entière tombe. Et `if (promesse)` est toujours vrai, donc
      // la mutation répondait `true` même quand l'écriture avait échoué.
      await this.diService.tech_startReperation(_id);
      return true;
    } catch (error) {
      throw withErrorContext(error, 'DiResolver.tech_startReperation');
    }
  }

  @Mutation(() => Di)
  @UseGuards(JwtAuthGuard)
  async tech_finishReperation(
    @CurrentUser() user: Profile,
    @Args('_id') _id: string,
    @Args('remarque') remarque: string,
    @Args('repairSuccess', { type: () => Boolean, nullable: true })
    repairSuccess?: boolean,
    @Args('testsValidated', { type: () => Boolean, nullable: true })
    testsValidated?: boolean,
  ) {
    try {
      await this.statService.assertTechOwnsDi(_id, user, 'rep');
      return await this.diService.tech_finishReperation(_id, remarque, {
        repairSuccess,
        testsValidated,
      });
    } catch (error) {
      throw withErrorContext(error, 'DiResolver.tech_finishReperation');
    }
  }

  @Mutation(() => Di)
  async changestatusToFinishReparation(@Args('_id') _id: string) {
    try {
      return await this.diService.changeStatusTofinsh(_id);
    } catch (error) {
      throw withErrorContext(error, 'DiResolver.changestatusToFinishReparation');
    }
  }

  // « Renvoyer au diagnostic » — bounce a DI being priced back to the
  // coordinator (PRICING → PENDING1) so a technician is re-assigned.
  @Mutation(() => Di)
  async sendDiBackToDiagnostic(@Args('_id') _id: string) {
    try {
      return await this.diService.sendDiBackToDiagnostic(_id);
    } catch (error) {
      throw withErrorContext(error, 'DiResolver.sendDiBackToDiagnostic');
    }
  }

  @Mutation(() => Boolean)
  async affectinitialPrice(
    @Args('_id') _id: string,
    @Args('price') price: number,
  ) {
    try {
      // `await` OBLIGATOIRE : sans lui la promesse FLOTTE. Une erreur métier
      // (GraphQLError) devient alors un « unhandled rejection » et Node ABAT LE
      // PROCESSUS — l'API entière tombe. Et `if (promesse)` est toujours vrai, donc
      // la mutation répondait `true` même quand l'écriture avait échoué.
      // Reproduction : saisir un prix de diagnostic nul/négatif faisait remonter
      // « Prix du diagnostic invalide » hors du cycle de vie GraphQL → crash.
      await this.diService.affectinitialPrice(_id, price);
      return true;
    } catch (error) {
      throw withErrorContext(error, 'DiResolver.affectinitialPrice');
    }
  }
  @Query(() => Number)
  async calculateTicketComposantPrice(
    @Args('_id') _id: string,
    // Cycle demandé (modal « Dossier ») ; absent = cycle courant de la DI.
    @Args('idIgnore', { type: () => Int, nullable: true }) idIgnore?: number,
  ) {
    try {
      return await this.diService.calculateTicketComposantPrice(_id, idIgnore);
    } catch (error) {
      throw withErrorContext(error, 'DiResolver.calculateTicketComposantPrice');
    }
  }

  /** Composants du cycle valorisés par phase : prix figés au diagnostic et en
   *  fin de réparation, repli sur le prix catalogue actuel (DI antérieures). */
  @Query(() => ComposantPhaseCost)
  async calculateTicketComposantPriceByPhase(
    @Args('_id') _id: string,
    @Args('idIgnore', { type: () => Int, nullable: true }) idIgnore?: number,
  ) {
    try {
      return await this.diService.calculateTicketComposantPriceByPhase(_id, idIgnore);
    } catch (error) {
      throw withErrorContext(error, 'DiResolver.calculateTicketComposantPriceByPhase');
    }
  }

  @Mutation(() => Di)
  async magasinTech_Pending2(@Args('_id') _id: string) {
    try {
      return await this.diService.magasinTech_Pending2(_id);
    } catch (error) {
      throw withErrorContext(error, 'DiResolver.magasinTech_Pending2');
    }
  }

  @Mutation(() => Di)
  async managerAdminManager_Pending3(@Args('_id') _id: string) {
    try {
      return await this.diService.managerAdminManager_Pending3(_id);
    } catch (error) {
      throw withErrorContext(error, 'DiResolver.managerAdminManager_Pending3');
    }
  }

  //Nego1 and Nego2 sending to the Magasin

  @Mutation(() => UpdateNego)
  async managerAdminManager_InMagasin(
    @Args('_id') _id: string,
    @Args('price') price: number,
    @Args('final_price') final_price: number,
  ) {
    try {
      let mut = await this.diService.managerAdminManager_InMagasin(
        _id,
        price,
        final_price,
      );
      return mut;
    } catch (error) {
      throw withErrorContext(error, 'DiResolver.managerAdminManager_InMagasin');
    }
  }

  /**
   * Changing status section
   */
  // NOTE: these previously did `const x = this.diService.changeStatusX(_id)`
  // (a Promise, always truthy) and returned `true` WITHOUT awaiting — so the
  // service ran fire-and-forget. With the M1 transition guard a rejected
  // service promise became an UNHANDLED rejection that crashed the process.
  // Awaiting lets a guard refusal surface as a clean GraphQL BAD_REQUEST.
  @Mutation(() => Boolean)
  async changeStatusPending1(@Args('_id') _id: string) {
    try {
      await this.diService.changeStatusPending1(_id);
      return true;
    } catch (error) {
      throw withErrorContext(error, 'DiResolver.changeStatusPending1');
    }
  }
  @Mutation(() => Boolean)
  @UseGuards(JwtAuthGuard)
  async changeStatusInDiagnostic(
    @CurrentUser() user: Profile,
    @Args('_id') _id: string,
  ) {
    try {
      // Resume-into-diagnostic is a tech work-action → assignee only.
      await this.statService.assertTechOwnsDi(_id, user, 'diag');
      await this.diService.changeStatusInDiagnostic(_id);
      return true;
    } catch (error) {
      throw withErrorContext(error, 'DiResolver.changeStatusInDiagnostic');
    }
  }
  @Mutation(() => Boolean)
  async changeStatusInMagasin(@Args('_id') _id: string) {
    try {
      await this.diService.changeStatusInMagasin(_id);
      return true;
    } catch (error) {
      throw withErrorContext(error, 'DiResolver.changeStatusInMagasin');
    }
  }
  @Mutation(() => Boolean)
  async changeStatusMagasinEstimation(@Args('_id') _id: string) {
    try {
      await this.diService.changeStatusMagasinEstimation(_id);
      return true;
    } catch (error) {
      throw withErrorContext(error, 'DiResolver.changeStatusMagasinEstimation');
    }
  }

  @Mutation(() => Boolean)
  async changeStatusPending2(@Args('_id') _id: string) {
    try {
      await this.diService.changeStatusPending2(_id);
      return true;
    } catch (error) {
      throw withErrorContext(error, 'DiResolver.changeStatusPending2');
    }
  }
  @Mutation(() => Boolean)
  async changeStatusPricing(@Args('_id') _id: string) {
    try {
      await this.diService.changeStatusPricing(_id);
      return true;
    } catch (error) {
      throw withErrorContext(error, 'DiResolver.changeStatusPricing');
    }
  }

  /** Persist the « Estimation prix réparation » entered in the price-initial
   *  modal. Dedicated field on the DI (not price/final_price). */
  @Mutation(() => Boolean)
  async setRepairEstimate(
    @Args('_id') _id: string,
    @Args('estimate', { type: () => Float }) estimate: number,
  ) {
    try {
      await this.diService.setRepairEstimate(_id, estimate);
      return true;
    } catch (error) {
      throw withErrorContext(error, 'DiResolver.setRepairEstimate');
    }
  }

  /** Cas diagnostic NON PAYANT : l'admin saisit UNIQUEMENT le prix de réparation ;
   *  le serveur calcule + persiste le prix final
   *  (final = prix_réparation + main-d'œuvre diagnostic + pièces) et renvoie le
   *  détail. Server-authoritative : main-d'œuvre et pièces ne viennent pas du front. */
  @Mutation(() => RepairPriceBreakdown)
  async setRepairFinalPrice(
    @Args('_id') _id: string,
    @Args('repairPrice', { type: () => Float }) repairPrice: number,
  ) {
    try {
      return await this.diService.setRepairFinalPrice(_id, repairPrice);
    } catch (error) {
      throw withErrorContext(error, 'DiResolver.setRepairFinalPrice');
    }
  }

  /** Gouvernance COORDINATRICE — bascule « Diagnostic payant » (verrouillé une
   *  fois la tarification faite). Rôle TECH refusé (appel API direct compris). */
  @Mutation(() => Boolean)
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(Role.COORDIANTOR, Role.ADMIN_MANAGER, Role.ADMIN_TECH)
  async setDiagnosticPayant(
    @Args('diId') diId: string,
    @Args('payant') payant: boolean,
  ) {
    try {
      return await this.diService.setDiagnosticPayant(diId, payant);
    } catch (error) {
      throw withErrorContext(error, 'DiResolver.setDiagnosticPayant');
    }
  }

  @Mutation(() => Boolean)
  async changeStatusNegociate1(@Args('_id') _id: string) {
    try {
      await this.diService.changeStatusNegociate1(_id);
      return true;
    } catch (error) {
      throw withErrorContext(error, 'DiResolver.changeStatusNegociate1');
    }
  }
  // Cas PAYANT irréparable : « Valider le prix » clôture en IRREPARABLE au lieu
  // d'entrer dans l'Approval (voir DiService.changeStatusIrreparableFromPricing).
  @Mutation(() => Boolean)
  async changeStatusIrreparableFromPricing(@Args('_id') _id: string) {
    try {
      await this.diService.changeStatusIrreparableFromPricing(_id);
      return true;
    } catch (error) {
      throw withErrorContext(error, 'DiResolver.changeStatusIrreparableFromPricing');
    }
  }
  @Mutation(() => Boolean)
  async changeStatusNegociate2(@Args('_id') _id: string) {
    try {
      await this.diService.changeStatusNegociate2(_id);
      return true;
    } catch (error) {
      throw withErrorContext(error, 'DiResolver.changeStatusNegociate2');
    }
  }
  @Mutation(() => Boolean)
  async changeStatusPending3(@Args('_id') _id: string) {
    try {
      await this.diService.changeStatusPending3(_id);
      return true;
    } catch (error) {
      throw withErrorContext(error, 'DiResolver.changeStatusPending3');
    }
  }

  @Mutation(() => Boolean)
  async changeStatusRepaire(@Args('_id') _id: string) {
    try {
      await this.diService.changeStatusRepaire(_id);
      return true;
    } catch (error) {
      throw withErrorContext(error, 'DiResolver.changeStatusRepaire');
    }
  }

  /** Envoi en réparation par la COORDINATRICE avec devis OBLIGATOIRE — « un seul
   *  geste » du raccourci « retour sans pièces » (PENDING3). Joint le devis
   *  (routé sur le bon cycle), affecte le tech réparateur, passe en réparation.
   *  Réservé à la coordination : rôle TECH refusé (appel API direct compris). */
  @Mutation(() => Boolean)
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(Role.COORDIANTOR, Role.ADMIN_MANAGER, Role.ADMIN_TECH)
  async coordinatorSendToRepairWithDevis(
    @Args('_id') _id: string,
    @Args('repTechId') repTechId: string,
    @Args('pdf') pdf: string,
  ) {
    try {
      await this.diService.coordinatorSendToRepairWithDevis(_id, repTechId, pdf);
      return true;
    } catch (error) {
      throw withErrorContext(error, 'DiResolver.coordinatorSendToRepairWithDevis');
    }
  }

  @Mutation(() => Boolean)
  @UseGuards(JwtAuthGuard)
  async changeStatusInRepair(
    @CurrentUser() user: Profile,
    @Args('_id') _id: string,
  ) {
    try {
      // Resume-into-repair is a tech work-action → assignee only.
      await this.statService.assertTechOwnsDi(_id, user, 'rep');
      try {
        // Properly await the service so any error surfaces to the GraphQL
        // response instead of being swallowed. The previous fire-and-forget
        // shape returned `true` immediately even when the service threw.
        const result = await this.diService.changeStatusInRepair(_id);
        return !!result;
      } catch (err) {
        reportCatchError(err, 'DiResolver.changeStatusInRepair');
        console.error('[changeStatusInRepair][resolver] error:', err);
        throw err;
      }
    } catch (error) {
      throw withErrorContext(error, 'DiResolver.changeStatusInRepair');
    }
  }
  /**
   * Entree UNIQUE du retour : revendique le niveau atomiquement et applique la
   * transition. Le front n'a plus a enchainer `countIgnore` puis
   * `changeStatusRetourN` — c'est ce decoupage en deux mutations client qui
   * laissait, en cas d'echec de la seconde, une DI au compteur incremente mais
   * au statut inchange (constate en base sur 3 DI).
   */
  @Mutation(() => RetourResult)
  @UseGuards(JwtAuthGuard)
  async changeStatusRetour(
    @Args('_id') _id: string,
    @Args('reason', { nullable: true }) reason?: string,
  ) {
    try {
      return await this.diService.openRetourCycle(_id, reason);
    } catch (error) {
      throw withErrorContext(error, 'DiResolver.changeStatusRetour');
    }
  }

  // Compatibilite : les trois mutations historiques delegent toutes a
  // `openRetourCycle`, qui determine le niveau lui-meme. Le suffixe 1/2/3 est
  // ignore — un front non encore deploye reste donc correct.
  @Mutation(() => Boolean)
  @UseGuards(JwtAuthGuard)
  async changeStatusRetour1(
    @Args('_id') _id: string,
    @Args('reason', { nullable: true }) reason?: string,
  ) {
    try {
      const updated = await this.diService.changeDiRetour1(_id, reason);
      return !!updated;
    } catch (error) {
      throw withErrorContext(error, 'DiResolver.changeStatusRetour1');
    }
  }
  @Mutation(() => Boolean)
  @UseGuards(JwtAuthGuard)
  async changeStatusRetour2(
    @Args('_id') _id: string,
    @Args('reason', { nullable: true }) reason?: string,
  ) {
    try {
      const updated = await this.diService.changeDiRetour2(_id, reason);
      return !!updated;
    } catch (error) {
      throw withErrorContext(error, 'DiResolver.changeStatusRetour2');
    }
  }
  @Mutation(() => Boolean)
  @UseGuards(JwtAuthGuard)
  async changeStatusRetour3(
    @Args('_id') _id: string,
    @Args('reason', { nullable: true }) reason?: string,
  ) {
    try {
      const updated = await this.diService.changeDiRetour3(_id, reason);
      return !!updated;
    } catch (error) {
      throw withErrorContext(error, 'DiResolver.changeStatusRetour3');
    }
  }

  @Mutation(() => Boolean)
  changeToPending1(@Args('_id') _id: string) {
    try {
      const pending3 = this.diService.changeToPending1(_id);
      if (pending3) {
        return true;
      } else {
        return false;
      }
    } catch (error) {
      throw withErrorContext(error, 'DiResolver.changeToPending1');
    }
  }
  //coordinator_ToDiag
  @Mutation(() => Di)
  async coordinatorSendingDiDiag(@Args('_idDI') _idDI: string) {
    try {
      return await this.diService.coordinator_ToDiag(_idDI);
    } catch (error) {
      throw withErrorContext(error, 'DiResolver.coordinatorSendingDiDiag');
    }
  }
  //Diagnostique in Pause
  @Mutation(() => Di)
  @UseGuards(JwtAuthGuard)
  async changeToDiagnosticInPause(
    @CurrentUser() user: Profile,
    @Args('_idDI') _idDI: string,
  ) {
    try {
      // Pausing the diagnostic is a tech work-action → assignee only.
      await this.statService.assertTechOwnsDi(_idDI, user, 'diag');
      return await this.diService.changeToDiagnosticInPause(_idDI);
    } catch (error) {
      throw withErrorContext(error, 'DiResolver.changeToDiagnosticInPause');
    }
  }

  //Repair in Pause
  @Mutation(() => Di)
  @UseGuards(JwtAuthGuard)
  async changeToReparationInPause(
    @CurrentUser() user: Profile,
    @Args('_idDI') _idDI: string,
  ) {
    try {
      // Pausing the repair is a tech work-action → assignee only.
      await this.statService.assertTechOwnsDi(_idDI, user, 'rep');
      const diRepairPause = await this.diService.changeStateInReparationPause(
        _idDI,
      );

      if (diRepairPause) {
        return diRepairPause;
      } else {
        return error;
      }
    } catch (error) {
      throw withErrorContext(error, 'DiResolver.changeToReparationInPause');
    }
  }

  // ignore

  /**
   * DEPRECIE — n'incremente PLUS rien. Le compteur de cycle est desormais
   * revendique atomiquement par `openRetourCycle`, a l'interieur de la
   * transition de retour.
   *
   * On renvoie le niveau QUI SERA reclame (et non le compteur inchange) :
   * l'ancien front lit `data.countIgnore.ignoreCount` pour choisir sa branche
   * `changeStatusRetour1/2/3` ; avec le compteur inchange il lirait `0` sur une
   * DI jamais retournee et n'appellerait aucune transition.
   */
  @Mutation(() => Di)
  @UseGuards(JwtAuthGuard)
  async countIgnore(@Args('_idDI') _idDI: string) {
    try {
      return await this.diService.countIgnore(_idDI);
    } catch (error) {
      throw withErrorContext(error, 'DiResolver.countIgnore');
    }
  }

  //1.Duree Moyenne Reparation
  // function that return the "Ecart Type"
  @Query(() => Number)
  async getTechStatisticsMoyenneReperation(
    @Args('techRep_id') techRep_id: string,
  ) {
    try {
      const data = await this.diService.getTechStatisticsMoyenneReperation(
        techRep_id,
      );
      const countNumberReperation = data.filter(
        (element) => element.rep_time,
      ).length;
      const totalRepTimeInSeconds = data
        .map((element) => this.timeStringToSeconds(element.rep_time))
        .reduce((acc, curr) => acc + curr, 0);
      let moyRep = totalRepTimeInSeconds / countNumberReperation;

      const sumDureeMinusDureeMoyenne = data
        .map((element) =>
          Math.pow(this.timeStringToSeconds(element.rep_time) - moyRep, 2),
        )
        .reduce((acc, curr) => acc + curr, 0);

      const ecartType = Math.sqrt(
        sumDureeMinusDureeMoyenne / countNumberReperation,
      );

      return ecartType;
    } catch (error) {
      throw withErrorContext(error, 'DiResolver.getTechStatisticsMoyenneReperation');
    }
  }
  //EcartType Diagnostique
  @Query(() => Number)
  async getTechStatisticsMoyenneDiagnostique(
    @Args('techDiag_id') techDiag_id: string,
  ) {
    try {
      const data = await this.diService.getTechStatisticsMoyenneDiagnostique(
        techDiag_id,
      );
      const countNumberDiagnostique = data.filter(
        (element) => element.diag_time,
      ).length;
      const totalDiagTimeInSeconds = data
        .map((element) => this.timeStringToSeconds(element.diag_time))
        .reduce((acc, curr) => acc + curr, 0);
      let moyDiag = totalDiagTimeInSeconds / countNumberDiagnostique;

      const sumDureeMinusDureeMoyenne = data
        .map((element) =>
          Math.pow(this.timeStringToSeconds(element.diag_time) - moyDiag, 2),
        )
        .reduce((acc, curr) => acc + curr, 0);

      const ecartType = Math.sqrt(
        sumDureeMinusDureeMoyenne / countNumberDiagnostique,
      );

      return ecartType;
    } catch (error) {
      throw withErrorContext(error, 'DiResolver.getTechStatisticsMoyenneDiagnostique');
    }
  }
  //2. Taux de reperation reussie for each tech
  // function that give % of success reperation and retour reperation
  @Query(() => Number)
  async getTauxRepReussiteByTech(@Args('techRep_id') techRep_id: string) {
    try {
      const data = await this.diService.getTauxRepReussiteByTech(techRep_id);
      let repSuccess = 0;
      let allcounter = data.length;
      data.map((el) =>
        el.status === 'FINISHED' ? (repSuccess = repSuccess + 1) : repSuccess,
      );

      const percentageReussite = (repSuccess / allcounter) * 100;
      return percentageReussite;
    } catch (error) {
      throw withErrorContext(error, 'DiResolver.getTauxRepReussiteByTech');
    }
  }
  //2. Taux de reperation qui reflete le nombre de carte traite
  @Query(() => Number)
  async getTauxReperationByTech(@Args('techRep_id') techRep_id: string) {
    try {
      const data = await this.diService.getTauxReperationByTech(techRep_id);
      let repFinie = 0;
      let allcounter = data.length;
      data.map((el) =>
        el.status === 'FINISHED' ? (repFinie = repFinie + 1) : repFinie,
      );

      const percentageTraiter = (repFinie / allcounter) * 100;
      return percentageTraiter;
    } catch (error) {
      throw withErrorContext(error, 'DiResolver.getTauxReperationByTech');
    }
  }
  z;
}
