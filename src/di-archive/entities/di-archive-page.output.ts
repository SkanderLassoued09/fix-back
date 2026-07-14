import { Field, Int, ObjectType } from '@nestjs/graphql';
import { DiArchive } from './di-archive.entity';

/** One page of `/archives` rows + the TOTAL count matching the active filter
 *  (so the UI can show « X DI correspondent » and paginate server-side). */
@ObjectType()
export class DiArchivePage {
  @Field(() => [DiArchive])
  rows: DiArchive[];

  @Field(() => Int)
  totalCount: number;
}
