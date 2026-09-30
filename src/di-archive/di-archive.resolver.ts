import { Args, Mutation, Query, Resolver } from '@nestjs/graphql';
import { DiArchiveService } from './di-archive.service';
import { DiArchive, DiArchiveDocType } from './entities/di-archive.entity';
import { DiArchivePage } from './entities/di-archive-page.output';
import { CreateDiArchiveInput } from './dto/create-di-archive.input';
import {
  DiArchivesFilterInput,
  DiArchivesPageInput,
} from './dto/di-archives-filter.input';
import { withErrorContext } from '../common/error-context';

@Resolver(() => DiArchive)
export class DiArchiveResolver {
  constructor(private readonly diArchiveService: DiArchiveService) {}

  @Mutation(() => DiArchive)
  async createDiArchive(
    @Args('createDiArchiveInput') createDiArchiveInput: CreateDiArchiveInput,
  ): Promise<DiArchive> {
    try {
      return await this.diArchiveService.create(createDiArchiveInput);
    } catch (error) {
      throw withErrorContext(error, 'DiArchiveResolver.createDiArchive');
    }
  }

  /** Upload one document (base64 data-URL) to Drive + re-derive statutCompletude. */
  @Mutation(() => DiArchive)
  async uploadDiArchiveDoc(
    @Args('diArchiveId') diArchiveId: string,
    @Args('docType', { type: () => DiArchiveDocType }) docType: DiArchiveDocType,
    @Args('file') file: string,
  ): Promise<DiArchive> {
    try {
      return await this.diArchiveService.uploadDoc(diArchiveId, docType, file);
    } catch (error) {
      throw withErrorContext(error, 'DiArchiveResolver.uploadDiArchiveDoc');
    }
  }

  /** Unlink one document (field → null) + re-derive statutCompletude. */
  @Mutation(() => DiArchive)
  async removeDiArchiveDoc(
    @Args('diArchiveId') diArchiveId: string,
    @Args('docType', { type: () => DiArchiveDocType }) docType: DiArchiveDocType,
  ): Promise<DiArchive> {
    try {
      return await this.diArchiveService.removeDoc(diArchiveId, docType);
    } catch (error) {
      throw withErrorContext(error, 'DiArchiveResolver.removeDiArchiveDoc');
    }
  }

  /** Clôture (admin/manager) — COMPLET → CLOTURE (terminal). */
  @Mutation(() => DiArchive)
  async clotureDiArchive(
    @Args('diArchiveId') diArchiveId: string,
  ): Promise<DiArchive> {
    try {
      return await this.diArchiveService.cloture(diArchiveId);
    } catch (error) {
      throw withErrorContext(error, 'DiArchiveResolver.clotureDiArchive');
    }
  }

  /**
   * Paginated + filtered `/archives` list. All filter criteria are cumulative
   * (AND) and applied SERVER-SIDE (the collection is never fully loaded).
   * Returns the page rows + the total count matching the filter.
   */
  @Query(() => DiArchivePage)
  async diArchives(
    @Args('filter', { type: () => DiArchivesFilterInput, nullable: true })
    filter?: DiArchivesFilterInput,
    @Args('page', { type: () => DiArchivesPageInput, nullable: true })
    page?: DiArchivesPageInput,
  ): Promise<DiArchivePage> {
    try {
      return await this.diArchiveService.findPage(filter, page);
    } catch (error) {
      throw withErrorContext(error, 'DiArchiveResolver.diArchives');
    }
  }

  /** Distinct historical-status values — options for the « Statut » dropdown. */
  @Query(() => [String])
  async diArchiveStatuts(): Promise<string[]> {
    try {
      return await this.diArchiveService.distinctStatutsHistorique();
    } catch (error) {
      throw withErrorContext(error, 'DiArchiveResolver.diArchiveStatuts');
    }
  }

  @Query(() => DiArchive, { nullable: true })
  async diArchive(@Args('id') id: string): Promise<DiArchive | null> {
    try {
      return await this.diArchiveService.findOne(id);
    } catch (error) {
      throw withErrorContext(error, 'DiArchiveResolver.diArchive');
    }
  }
}
