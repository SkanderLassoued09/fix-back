import {
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { nanoid } from 'nanoid';
import { DiImportJobStatus } from './entities/di-import-job.entity';

/**
 * Cycle de vie d'un job d'import DI en bloc, persisté dans `di_import_jobs`.
 *
 *   create() → PENDING
 *   markRunning() → RUNNING
 *   incrementProgress() …  (atomique, $inc, par lot)
 *   complete(report) → COMPLETED   |   fail(error) → FAILED
 *
 * Le job survit à la fermeture d'onglet (l'exécution vit côté serveur — étape 2)
 * et reste consultable via `getForUser` (sécurité : propriétaire uniquement).
 */
@Injectable()
export class DiImportJobService {
  constructor(
    @InjectModel('DiImportJob') private readonly jobModel: Model<any>,
  ) {}

  /** Crée un job PENDING avec un `jobId` unique (nanoid). `total` = nombre de
   *  lignes validées à traiter. `createdBy` = propriétaire (profile _id). */
  async create(input: { createdBy?: string; total: number }): Promise<any> {
    const jobId = `IMPORT_${nanoid(12)}`;
    return this.jobModel.create({
      jobId,
      createdBy: input.createdBy,
      total: Math.max(0, input.total ?? 0),
      done: 0,
      status: 'PENDING' as DiImportJobStatus,
    });
  }

  /** Lecture brute (sans contrôle d'accès) — usage interne/serveur. */
  async getById(jobId: string): Promise<any | null> {
    return this.jobModel.findOne({ jobId }).lean();
  }

  /**
   * Lecture SÉCURISÉE : seul le créateur du job y accède. `allowAny` (rôle
   * autorisé, ex. admin) court-circuite le contrôle. Lève NotFound si absent,
   * Forbidden si le job appartient à un autre utilisateur.
   */
  async getForUser(
    jobId: string,
    userId?: string,
    allowAny = false,
  ): Promise<any> {
    const job = await this.jobModel.findOne({ jobId }).lean();
    if (!job) {
      throw new NotFoundException(`Job d'import « ${jobId} » introuvable.`);
    }
    const owner = (job as any).createdBy;
    if (!allowAny && owner && owner !== userId) {
      throw new ForbiddenException(
        "Accès refusé : ce job d'import appartient à un autre utilisateur.",
      );
    }
    return job;
  }

  /** Jobs d'un utilisateur (récupération après reconnexion), plus récents d'abord. */
  async listForUser(userId: string): Promise<any[]> {
    return this.jobModel
      .find({ createdBy: userId })
      .sort({ createdAt: -1 })
      .lean();
  }

  async markRunning(jobId: string): Promise<any> {
    return this.jobModel.findOneAndUpdate(
      { jobId },
      { $set: { status: 'RUNNING' as DiImportJobStatus } },
      { new: true },
    );
  }

  /** Avance ATOMIQUE de la progression (mono-document `$inc`) — appelée après
   *  chaque lot. `currentRef` = dernière référence traitée (affichage). */
  async incrementProgress(
    jobId: string,
    delta: number,
    currentRef?: string,
  ): Promise<any> {
    const set: Record<string, any> = {};
    if (currentRef != null) set.currentRef = currentRef;
    return this.jobModel.findOneAndUpdate(
      { jobId },
      { $inc: { done: Math.max(0, delta) }, $set: set },
      { new: true },
    );
  }

  async complete(jobId: string, report: any): Promise<any> {
    return this.jobModel.findOneAndUpdate(
      { jobId },
      {
        $set: {
          status: 'COMPLETED' as DiImportJobStatus,
          report,
          currentRef: null,
        },
      },
      { new: true },
    );
  }

  async fail(jobId: string, error: string, report?: any): Promise<any> {
    const set: Record<string, any> = {
      status: 'FAILED' as DiImportJobStatus,
      error,
    };
    if (report !== undefined) set.report = report;
    return this.jobModel.findOneAndUpdate(
      { jobId },
      { $set: set },
      { new: true },
    );
  }
}
