import { Resolver, Mutation, Args, Query, Subscription } from '@nestjs/graphql';
import { DiService } from './di.service';
import {
  Di,
  DiTableData,
  LogsDiData,
  StatusCount,
  UpdateNego,
} from './entities/di.entity';
import {
  CreateDiInput,
  DiagUpdate,
  FilterConfigDi,
  PaginationConfigDi,
  SearchDiInput,
  UpdateDi,
} from './dto/create-di.input';
import { User as CurrentUser } from 'src/auth/profile.decorator';
import { Profile } from 'src/profile/entities/profile.entity';
import { UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from 'src/auth/jwt-auth-guard';
import { error, log } from 'console';
import { StatService } from 'src/stat/stat.service';
import { PubSub } from 'graphql-subscriptions';
import { Stat } from 'src/stat/entities/stat.entity';
import { rootCertificates } from 'tls';

@Resolver(() => Di)
export class DiResolver {
  // used to convert from string to number
  timeStringToSeconds(timeString) {
    const [hours, minutes, seconds] = timeString.trim().split(':').map(Number);
    return hours * 3600 + minutes * 60 + seconds;
  }

  // Function to convert seconds to "hh:mm:ss"
  secondsToTimeString(totalSeconds) {
    const hours = Math.floor(totalSeconds / 3600);
    const minutes = Math.floor((totalSeconds % 3600) / 60);
    const seconds = totalSeconds % 60;
    return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(
      2,
      '0',
    )}:${String(seconds).padStart(2, '0')}`;
  }

  constructor(
    private readonly diService: DiService,
    private readonly statService: StatService,
    private readonly pubsub: PubSub,
  ) {}

  @Mutation(() => Di)
  @UseGuards(JwtAuthGuard)
  createDi(
    @Args('createDiInput') createDiInput: CreateDiInput,
    @CurrentUser() profile: Profile,
  ) {
    createDiInput.createdBy = profile._id;
    return this.diService.createDi(createDiInput);
  }

  @Mutation(() => Di)
  addDevis(@Args('_id') _id: string, @Args('pdf') pdf: string) {
    return this.diService.addDevisPDF(_id, pdf);
  }

  @Mutation(() => Di)
  addBl(@Args('_id') _id: string, @Args('pdf') pdf: string) {
    return this.diService.addBlPDF(_id, pdf);
  }
  @Mutation(() => Di)
  addFacture(@Args('_id') _id: string, @Args('pdf') pdf: string) {
    return this.diService.addFacturePDF(_id, pdf);
  }
  @Mutation(() => Di)
  addBC(@Args('_id') _id: string, @Args('pdf') pdf: string) {
    return this.diService.addBCPDF(_id, pdf);
  }

  @Query(() => DiTableData)
  async getAllDi(
    @Args('paginationConfig') paginationConfig: PaginationConfigDi,
    @Args('filterConfig', { nullable: true }) filterConfig?: FilterConfigDi,
  ) {
    return await this.diService.getAllDi(paginationConfig, filterConfig);
  }
  @Query(() => DiTableData)
  async searchDi(
    @Args('paginationConfig') paginationConfig: PaginationConfigDi,
    @Args('search') search: SearchDiInput,
    @Args('filterConfig', { nullable: true }) filterConfig?: FilterConfigDi,
  ) {
    return await this.diService.searchDi(
      paginationConfig,
      search,
      // filterConfig,
    );
  }

  @Query(() => LogsDiData)
  async getDiById(@Args('_id') _id: string) {
    try {
      const diData = await this.diService.getDiById(_id);
      return diData;
    } catch (error) {
      throw new Error(error);
    }
  }

  @Mutation(() => Di)
  async sendComponentToConMagasinForConfirmation(@Args('_id') _id: string) {
    return await this.diService.sendComponentToConMagasinForConfirmation(_id);
  }

  @Mutation(() => Di)
  @UseGuards(JwtAuthGuard)
  async componentConfirmedFromCoordinator(
    @Args('_id') _id: string,
    @CurrentUser() profile: Profile,
  ) {
    return await this.diService.componentConfirmedFromCoordinator(
      _id,
      profile?._id ?? null,
    );
  }

  @Mutation(() => Di)
  @UseGuards(JwtAuthGuard)
  async sendDiToAdminsForPricing(
    @Args('diId') diId: string,
    @CurrentUser() profile: Profile,
  ) {
    return await this.diService.sendDiToAdminsForPricing(
      diId,
      profile?._id ?? null,
    );
  }

  @Mutation(() => Di)
  @UseGuards(JwtAuthGuard)
  async confirmDiComponents(
    @Args('diId') diId: string,
    @CurrentUser() profile: Profile,
  ) {
    return await this.diService.confirmDiComponents(
      diId,
      profile?._id ?? null,
    );
  }

  @Mutation(() => Di)
  async confirmationComposant(
    @Args('_id') _id: string,
    @Args('confirmationState') confirmationState: string,
    @Args('_idNotification', { nullable: true }) _idNotification?: string,
  ) {
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
  }

  @Subscription(() => Di)
  notificationConfirmation() {
    return this.pubsub.asyncIterator('confirmation-composant');
  }

  @Mutation(() => Di)
  async deleteDi(@Args('_id') _id: string) {
    return await this.diService.deleteDi(_id);
  }

  @Mutation(() => Di)
  async updateDi(@Args('UpdateDi') updateDi: UpdateDi) {
    return await this.diService.updateDi(updateDi);
  }

  @Query(() => Di)
  getAllRemarque(@Args('_id') _id: string) {
    return this.diService.getAllRemarque(_id);
  }

  @Query(() => DiTableData)
  async searchCoordinatorDI(
    @Args('paginationConfig') paginationConfig: PaginationConfigDi,
    @Args('search') search: SearchDiInput,
  ) {
    return this.diService.searchCoordinatorDI(paginationConfig, search);
  }

  @Query(() => DiTableData)
  async get_coordinatorDI(
    @Args('paginationConfig') paginationConfig: PaginationConfigDi,
  ) {
    return await this.diService.get_coordinatorDI(paginationConfig);
  }
  @Query(() => DiTableData)
  async getDiForMagasin(
    @Args('paginationConfig') paginationConfig: PaginationConfigDi,
  ) {
    return await this.diService.getDiForMagasin(paginationConfig);
  }

  @Query(() => DiTableData)
  async searchDiForMagasin(
    @Args('paginationConfig') paginationConfig: PaginationConfigDi,
    @Args('search') search: SearchDiInput,
  ) {
    return this.diService.searchDiForMagasin(paginationConfig, search);
  }

  @Mutation(() => Di)
  async setSelectedComponentAsDone(
    @Args('_id') _id: string,
    @Args('nameComposant') nameComposant: string,
  ) {
    return await this.diService.setSelectedComponentAsDone(_id, nameComposant);
  }

  @Mutation(() => Di)
  manager_Pending1(@Args('_id') _id: string) {
    return this.diService.manager_Pending1(_id);
  }

  @Mutation(() => Di)
  addPDFFile(
    @Args('_id') _id: string,
    @Args('facture') facture: string,
    @Args('bl') bl: string,
  ) {
    return this.diService.addPDFFile(_id, facture, bl);
  }
  @Mutation(() => Boolean)
  tech_startDiagnostic(
    @Args('_id') _id: string,
    @Args('diag') diag: DiagUpdate,
  ) {
    const isDiag = this.diService.tech_startDiagnostic(_id, diag);
    if (isDiag) {
      return true;
    } else {
      return false;
    }
  }

  @Mutation(() => Di)
  async markAsSeen(@Args('_id') _id: string) {
    return this.diService.markAsSeen(_id);
  }

  @Query(() => [StatusCount])
  async getStatusCount() {
    return await this.diService.getStatusCount();
  }

  @Mutation(() => Boolean)
  tech_startReperation(@Args('_id') _id: string) {
    const isDiag = this.diService.tech_startReperation(_id);
    if (isDiag) {
      return true;
    } else {
      return false;
    }
  }

  @Mutation(() => Di)
  tech_finishReperation(
    @Args('_id') _id: string,
    @Args('remarque') remarque: string,
  ) {
    return this.diService.tech_finishReperation(_id, remarque);
  }

  @Mutation(() => Di)
  changestatusToFinishReparation(@Args('_id') _id: string) {
    return this.diService.changeStatusTofinsh(_id);
  }

  @Mutation(() => Boolean)
  affectinitialPrice(@Args('_id') _id: string, @Args('price') price: number) {
    const priceaffecting = this.diService.affectinitialPrice(_id, price);
    if (priceaffecting) {
      return true;
    } else {
      return false;
    }
  }
  @Query(() => Number)
  calculateTicketComposantPrice(@Args('_id') _id: string) {
    return this.diService.calculateTicketComposantPrice(_id);
  }

  @Mutation(() => Di)
  magasinTech_Pending2(@Args('_id') _id: string) {
    return this.diService.magasinTech_Pending2(_id);
  }

  @Mutation(() => Di)
  managerAdminManager_Pending3(@Args('_id') _id: string) {
    return this.diService.managerAdminManager_Pending3(_id);
  }

  //Nego1 and Nego2 sending to the Magasin

  @Mutation(() => UpdateNego)
  async managerAdminManager_InMagasin(
    @Args('_id') _id: string,
    @Args('price') price: number,
    @Args('final_price') final_price: number,
  ) {
    let mut = await this.diService.managerAdminManager_InMagasin(
      _id,
      price,
      final_price,
    );
    return mut;
  }

  /**
   * Changing status section
   */
  @Mutation(() => Boolean)
  changeStatusPending1(@Args('_id') _id: string) {
    const isPending = this.diService.changeStatusPending1(_id);
    if (isPending) {
      return true;
    } else {
      return false;
    }
  }
  @Mutation(() => Boolean)
  changeStatusInDiagnostic(@Args('_id') _id: string) {
    const isPending = this.diService.changeStatusInDiagnostic(_id);
    if (isPending) {
      return true;
    } else {
      return false;
    }
  }
  @Mutation(() => Boolean)
  changeStatusInMagasin(@Args('_id') _id: string) {
    const isPending = this.diService.changeStatusInMagasin(_id);
    if (isPending) {
      return true;
    } else {
      return false;
    }
  }
  @Mutation(() => Boolean)
  changeStatusMagasinEstimation(@Args('_id') _id: string) {
    const result = this.diService.changeStatusMagasinEstimation(_id);
    if (result) {
      return true;
    } else {
      return false;
    }
  }

  @Mutation(() => Boolean)
  changeStatusPending2(@Args('_id') _id: string) {
    const isPending = this.diService.changeStatusPending2(_id);
    if (isPending) {
      return true;
    } else {
      return false;
    }
  }
  @Mutation(() => Boolean)
  changeStatusPricing(@Args('_id') _id: string) {
    const isPending = this.diService.changeStatusPricing(_id);
    if (isPending) {
      return true;
    } else {
      return false;
    }
  }
  @Mutation(() => Boolean)
  changeStatusNegociate1(@Args('_id') _id: string) {
    const isPending = this.diService.changeStatusNegociate1(_id);
    if (isPending) {
      return true;
    } else {
      return false;
    }
  }
  @Mutation(() => Boolean)
  changeStatusNegociate2(@Args('_id') _id: string) {
    const isPending = this.diService.changeStatusNegociate2(_id);
    if (isPending) {
      return true;
    } else {
      return false;
    }
  }
  @Mutation(() => Boolean)
  changeStatusPending3(@Args('_id') _id: string) {
    const isPending = this.diService.changeStatusPending3(_id);
    if (isPending) {
      return true;
    } else {
      return false;
    }
  }

  @Mutation(() => Boolean)
  changeStatusRepaire(@Args('_id') _id: string) {
    const isPending = this.diService.changeStatusRepaire(_id);
    if (isPending) {
      return true;
    } else {
      return false;
    }
  }

  @Mutation(() => Boolean)
  async changeStatusInRepair(@Args('_id') _id: string) {
    // TEMP-LOG: trace resume mutation entry to confirm the resolver fires
    // and that the `_id` arrived intact from the GraphQL query.
    console.log('[changeStatusInRepair][resolver] called with _id=', _id);
    try {
      // Properly await the service so any error surfaces to the GraphQL
      // response instead of being swallowed. The previous fire-and-forget
      // shape returned `true` immediately even when the service threw.
      const result = await this.diService.changeStatusInRepair(_id);
      console.log(
        '[changeStatusInRepair][resolver] success status=',
        (result as any)?.status,
      );
      return !!result;
    } catch (err) {
      console.error('[changeStatusInRepair][resolver] error:', err);
      throw err;
    }
  }
  @Mutation(() => Boolean)
  changeStatusRetour1(@Args('_id') _id: string) {
    const pending3 = this.diService.changeDiRetour1(_id);
    if (pending3) {
      return true;
    } else {
      return false;
    }
  }
  @Mutation(() => Boolean)
  changeStatusRetour2(@Args('_id') _id: string) {
    const pending3 = this.diService.changeDiRetour2(_id);
    if (pending3) {
      return true;
    } else {
      return false;
    }
  }
  @Mutation(() => Boolean)
  changeStatusRetour3(@Args('_id') _id: string) {
    const pending3 = this.diService.changeDiRetour3(_id);
    if (pending3) {
      return true;
    } else {
      return false;
    }
  }

  @Mutation(() => Boolean)
  changeToPending1(@Args('_id') _id: string) {
    const pending3 = this.diService.changeToPending1(_id);
    if (pending3) {
      return true;
    } else {
      return false;
    }
  }
  //coordinator_ToDiag
  @Mutation(() => Di)
  async coordinatorSendingDiDiag(@Args('_idDI') _idDI: string) {
    return await this.diService.coordinator_ToDiag(_idDI);
  }
  //Diagnostique in Pause
  @Mutation(() => Di)
  changeToDiagnosticInPause(@Args('_idDI') _idDI: string) {
    return this.diService.changeToDiagnosticInPause(_idDI);
  }

  //Repair in Pause
  @Mutation(() => Di)
  async changeToReparationInPause(@Args('_idDI') _idDI: string) {
    const diRepairPause = await this.diService.changeStateInReparationPause(
      _idDI,
    );

    if (diRepairPause) {
      return diRepairPause;
    } else {
      return error;
    }
  }

  // ignore

  @Mutation(() => Di)
  countIgnore(@Args('_idDI') _idDI: string) {
    return this.diService.countIgnore(_idDI);
  }

  //1.Duree Moyenne Reparation
  // function that return the "Ecart Type"
  @Query(() => Number)
  async getTechStatisticsMoyenneReperation(
    @Args('techRep_id') techRep_id: string,
  ) {
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
  }
  //EcartType Diagnostique
  @Query(() => Number)
  async getTechStatisticsMoyenneDiagnostique(
    @Args('techDiag_id') techDiag_id: string,
  ) {
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
  }
  //2. Taux de reperation reussie for each tech
  // function that give % of success reperation and retour reperation
  @Query(() => Number)
  async getTauxRepReussiteByTech(@Args('techRep_id') techRep_id: string) {
    const data = await this.diService.getTauxRepReussiteByTech(techRep_id);
    let repSuccess = 0;
    let allcounter = data.length;
    data.map((el) =>
      el.status === 'FINISHED' ? (repSuccess = repSuccess + 1) : repSuccess,
    );

    const percentageReussite = (repSuccess / allcounter) * 100;
    return percentageReussite;
  }
  //2. Taux de reperation qui reflete le nombre de carte traite
  @Query(() => Number)
  async getTauxReperationByTech(@Args('techRep_id') techRep_id: string) {
    const data = await this.diService.getTauxReperationByTech(techRep_id);
    let repFinie = 0;
    let allcounter = data.length;
    data.map((el) =>
      el.status === 'FINISHED' ? (repFinie = repFinie + 1) : repFinie,
    );

    const percentageTraiter = (repFinie / allcounter) * 100;
    return percentageTraiter;
  }
  z;
}
