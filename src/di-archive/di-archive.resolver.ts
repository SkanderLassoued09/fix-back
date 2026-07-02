import { Args, Mutation, Query, Resolver } from '@nestjs/graphql';
import { DiArchiveService } from './di-archive.service';
import { DiArchive, DiArchiveDocType } from './entities/di-archive.entity';
import { CreateDiArchiveInput } from './dto/create-di-archive.input';

@Resolver(() => DiArchive)
export class DiArchiveResolver {
  constructor(private readonly diArchiveService: DiArchiveService) {}

  @Mutation(() => DiArchive)
  createDiArchive(
    @Args('createDiArchiveInput') createDiArchiveInput: CreateDiArchiveInput,
  ): Promise<DiArchive> {
    return this.diArchiveService.create(createDiArchiveInput);
  }

  /** Upload one document (base64 data-URL) to Drive + re-derive statutCompletude. */
  @Mutation(() => DiArchive)
  uploadDiArchiveDoc(
    @Args('diArchiveId') diArchiveId: string,
    @Args('docType', { type: () => DiArchiveDocType }) docType: DiArchiveDocType,
    @Args('file') file: string,
  ): Promise<DiArchive> {
    return this.diArchiveService.uploadDoc(diArchiveId, docType, file);
  }

  /** Unlink one document (field → null) + re-derive statutCompletude. */
  @Mutation(() => DiArchive)
  removeDiArchiveDoc(
    @Args('diArchiveId') diArchiveId: string,
    @Args('docType', { type: () => DiArchiveDocType }) docType: DiArchiveDocType,
  ): Promise<DiArchive> {
    return this.diArchiveService.removeDoc(diArchiveId, docType);
  }

  /** Clôture (admin/manager) — COMPLET → CLOTURE (terminal). */
  @Mutation(() => DiArchive)
  clotureDiArchive(
    @Args('diArchiveId') diArchiveId: string,
  ): Promise<DiArchive> {
    return this.diArchiveService.cloture(diArchiveId);
  }

  @Query(() => [DiArchive])
  diArchives(): Promise<DiArchive[]> {
    return this.diArchiveService.findAll();
  }

  @Query(() => DiArchive, { nullable: true })
  diArchive(@Args('id') id: string): Promise<DiArchive | null> {
    return this.diArchiveService.findOne(id);
  }
}
