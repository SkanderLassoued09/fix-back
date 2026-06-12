import { Injectable, Logger } from '@nestjs/common';
import { GraphQLError } from 'graphql';
import { GoogleDriveService } from '../google-drive/google-drive.service';
import { OperationalErrorService } from '../operational-error/operational-error.service';

/** Clean GraphQL "not found" error (code NOT_FOUND) — avoids both the
 *  non-nullable-field crash and Nest's HttpException showing as
 *  INTERNAL_SERVER_ERROR in the GraphQL response. */
function notFound(_id: string): GraphQLError {
  return new GraphQLError(`Company with ID '${_id}' not found.`, {
    extensions: { code: 'NOT_FOUND' },
  });
}

/** Business duplicate (raison sociale / MF already in use). `field` names the
 *  offending DTO property so the front can surface the error inline on it. */
function conflict(field: 'raisonSociale' | 'mf', message: string): GraphQLError {
  return new GraphQLError(message, {
    extensions: { code: 'CONFLICT', field },
  });
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
import {
  CreateCompanyInput,
  PaginationConfig,
  UpdateCompanyInput,
} from './dto/create-company.input';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { Company, CompanyTableData } from './entities/company.entity';
import { v4 as uuidv4 } from 'uuid';
@Injectable()
export class CompanysService {
  private readonly logger = new Logger(CompanysService.name);

  constructor(
    @InjectModel('Company') private CompanyModel: Model<Company>,
    private readonly driveService: GoogleDriveService,
    private readonly opError: OperationalErrorService,
  ) {}

  /**
   * Best-effort: create the client's Google Drive folder and store its
   * id/url on the company. NEVER blocks the company flow — on failure it logs
   * and leaves `driveFolderId` null (repairable via `ensureClientFolder`).
   * Idempotent: a no-op when `driveFolderId` is already set.
   */
  private async attachDriveFolder(society: any): Promise<void> {
    if (!society || society.driveFolderId) return;
    try {
      const folder = await this.driveService.createClientFolder(
        society.raisonSociale || society.name,
        society.createdAt ?? new Date(),
      );
      society.driveFolderId = folder.id;
      society.driveFolderUrl = folder.webViewLink;
      await society.save();
      this.logger.log(
        `Linked Drive folder ${folder.id} to company ${society._id}`,
      );
    } catch (err) {
      // log + notify via the project's central helper. A *misconfiguration*
      // (Drive not set up) is EXPECTED → log only, no Discord. A real API/Drive
      // failure is OPERATIONAL → Discord (deduped). PII-free payload (ids only).
      const message = (err as Error)?.message ?? String(err);
      const misconfigured = /GOOGLE_DRIVE_PARENT_FOLDER_ID|credentials missing/i.test(
        message,
      );
      await this.opError.capture({
        module: 'company',
        submodule: 'drive',
        method: 'ATTACH_DRIVE_FOLDER',
        severity: misconfigured ? 'LOW' : 'MEDIUM',
        error: 'Client Drive folder not created',
        message,
        notify: !misconfigured,
        payload: { companyId: society?._id },
      });
    }
  }

  /**
   * Repair path: (re)create the Drive folder for a company only when it has
   * none. The single (re)creation entry point outside `createcompany`.
   */
  async ensureClientFolder(companyId: string): Promise<Company> {
    const company = await this.CompanyModel.findById(companyId);
    if (!company) {
      throw notFound(companyId);
    }
    if ((company as any).driveFolderId) {
      return company; // idempotent — already has a folder
    }
    await this.attachDriveFolder(company);
    return company;
  }

  async generateCompanyId(): Promise<number> {
    let indexCompany = 0;
    const lastCompany = await this.CompanyModel.findOne(
      {},
      {},
      { sort: { createdAt: -1 } },
    );

    if (lastCompany) {
      indexCompany = +lastCompany._id.substring(1);
      return indexCompany + 1;
    }
    return indexCompany;
  }

  async createcompany(
    createCompanyInput: CreateCompanyInput,
  ): Promise<Company> {
    createCompanyInput._id = uuidv4(); //Societe
    await this.assertNoDuplicate(
      createCompanyInput.raisonSociale,
      createCompanyInput.mf,
    );
    // Do NOT swallow the error and return it as if it were a Company — that
    // masked DB failures (e.g. duplicate key) as a malformed "success". Let it
    // propagate so the client gets a real error.
    let society;
    try {
      society = await new this.CompanyModel(createCompanyInput).save();
    } catch (err: any) {
      throw this.asConflictIfDuplicateKey(err);
    }
    // After persistence: auto-create the client's Drive folder (best-effort —
    // never blocks creation; repairable via ensureClientFolder if Drive fails).
    await this.attachDriveFolder(society);
    return society;
  }

  /**
   * Duplicate guard among ACTIVE companies (soft-deleted ones never block a
   * re-creation). The schema has NO unique index (`autoIndex: false`), so this
   * service-level check is the only protection — `raisonSociale` is matched
   * case-insensitively, `mf` only when provided. `excludeId` lets an update
   * keep its own values.
   */
  private async assertNoDuplicate(
    raisonSociale?: string,
    mf?: string,
    excludeId?: string,
  ): Promise<void> {
    const or: any[] = [];
    const rs = raisonSociale?.trim();
    const taxId = mf?.trim();
    if (rs) {
      or.push({
        raisonSociale: { $regex: `^${escapeRegex(rs)}$`, $options: 'i' },
      });
    }
    if (taxId) or.push({ mf: taxId });
    if (!or.length) return;
    const dup: any = await this.CompanyModel.findOne({
      isDeleted: { $ne: true },
      ...(excludeId ? { _id: { $ne: excludeId } } : {}),
      $or: or,
    }).lean();
    if (!dup) return;
    if (rs && dup.raisonSociale?.toLowerCase() === rs.toLowerCase()) {
      throw conflict(
        'raisonSociale',
        `Une société avec cette raison sociale existe déjà (« ${dup.raisonSociale} »).`,
      );
    }
    throw conflict(
      'mf',
      `Une société avec ce matricule fiscal existe déjà (MF ${dup.mf}).`,
    );
  }

  /** Map a Mongo duplicate-key error (E11000 — would only appear if a unique
   *  index is added someday) to a clean business CONFLICT instead of an
   *  INTERNAL_SERVER_ERROR. Any other error is returned unchanged. */
  private asConflictIfDuplicateKey(err: any): any {
    if (err?.code !== 11000) return err;
    const key = Object.keys(err.keyPattern ?? err.keyValue ?? {})[0];
    return conflict(
      key === 'mf' ? 'mf' : 'raisonSociale',
      key === 'mf'
        ? 'Une société avec ce matricule fiscal existe déjà.'
        : 'Une société avec cette raison sociale existe déjà.',
    );
  }
  /**
 * 
it should be soft delete ya nezih change it 
 */
  async removeCompany(_id: string): Promise<Company> {
    // Soft-delete. Return the updated doc; a missing id must be a clean 404,
    // not a null bubbling up into the non-nullable `Company` field (which
    // produced an INTERNAL_SERVER_ERROR + leaked stack trace).
    const updated = await this.CompanyModel.findOneAndUpdate(
      { _id, isDeleted: { $ne: true } },
      { $set: { isDeleted: true } },
      { new: true },
    );
    if (!updated) {
      throw notFound(_id);
    }
    return updated;
  }

  async findAllCompanys(
    paginationConfig: PaginationConfig,
  ): Promise<CompanyTableData> {
    const { first, rows } = paginationConfig;

    // Exclude soft-deleted companies (removeCompany sets isDeleted: true) so
    // deleted rows don't keep showing in the list.
    const filter = { isDeleted: { $ne: true } };
    const companyRecords = await this.CompanyModel.find(filter)
      .limit(rows)
      .skip(first)
      .exec();
    const totalCompanyRecord = await this.CompanyModel.countDocuments(
      filter,
    ).exec();
    return { companyRecords, totalCompanyRecord };
  }

  async searchCompany(
    paginationConfig: PaginationConfig,
    search: { field: string; value: string },
  ): Promise<CompanyTableData> {
    const { first, rows } = paginationConfig;
    const { field, value } = search;

    // Base filter
    const filter: any = {};

    // Only apply search if value has 2+ characters
    if (field && value && value.trim().length >= 2) {
      const trimmedValue = value.trim();
      const regex = { $regex: `${trimmedValue}`, $options: 'i' };

      switch (field) {
        case 'name':
        case 'region':
        case 'address':
        case 'email':
        case 'raisonSociale':
        case 'exoneration':
        case 'fax':
        case 'activitePrincipale':
        case 'activiteSecondaire':
        case 'webSiteLink':
          filter[field] = regex;
          break;

        // Search in nested service objects
        case 'serviceAchat':
          filter.$or = [
            { 'serviceAchat.name': regex },
            { 'serviceAchat.email': regex },
            { 'serviceAchat.phone': regex },
          ];
          break;

        case 'serviceFinancier':
          filter.$or = [
            { 'serviceFinancier.name': regex },
            { 'serviceFinancier.email': regex },
            { 'serviceFinancier.phone': regex },
          ];
          break;

        case 'serviceTechnique':
          filter.$or = [
            { 'serviceTechnique.name': regex },
            { 'serviceTechnique.email': regex },
            { 'serviceTechnique.phone': regex },
          ];
          break;
      }
    }

    // COUNT
    const totalCompanyRecord = await this.CompanyModel.countDocuments(filter);

    // FETCH
    const companyRecords = await this.CompanyModel.find(filter)
      .sort({ createdAt: -1 })
      .limit(rows)
      .skip(first)
      .exec();

    return { companyRecords, totalCompanyRecord };
  }

  async getAllComapnyforDropDown() {
    return await this.CompanyModel.find({}).exec();
  }

  async findOneCompany(_id: string): Promise<Company> {
    try {
      const Company = await this.CompanyModel.findById(_id).lean();

      if (!Company) {
        throw notFound(_id);
      }
      return Company;
    } catch (error) {
      throw error;
    }
  }

  async updateCompany(payload: UpdateCompanyInput) {
    // Renaming into another active company's raison sociale / MF is the same
    // business conflict as on create (the doc itself is excluded).
    await this.assertNoDuplicate(payload.raisonSociale, payload.mf, payload._id);
    const updated = await this.CompanyModel.findOneAndUpdate(
      { _id: payload._id },
      {
        $set: {
          name: payload.name,
          region: payload.region,
          address: payload.address,
          email: payload.email,
          Exoneration: payload.Exoneration,
          fax: payload.fax,
          phone: payload.phone,
          raisonSociale: payload.raisonSociale,
          webSiteLink: payload.webSiteLink,
          rne: payload.rne,
          mf: payload.mf,
          activitePrincipale: payload.activitePrincipale,
          activiteSecondaire: payload.activiteSecondaire,
          serviceAchat: payload.serviceAchat,
          serviceTechnique: payload.serviceTechnique,
          serviceFinancier: payload.serviceFinancier,
        },
      },
      { new: true },
    );
    // A missing id must be a clean 404, not null → non-nullable field crash.
    if (!updated) {
      throw notFound(payload._id);
    }
    return updated;
  }

  async searchCompanies(name: string): Promise<any[]> {
    if (!name || name.trim().length < 2) {
      return [];
    }

    return this.CompanyModel.find({
      company_name: { $regex: name, $options: 'i' },
      isDeleted: false,
    })
      .select('_id company_name')
      .limit(20)
      .lean();
  }
}
