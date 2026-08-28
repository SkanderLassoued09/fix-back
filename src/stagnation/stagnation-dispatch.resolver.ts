import { Args, Int, Query, Resolver } from '@nestjs/graphql';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import {
  StagnationDispatch,
  StagnationDispatchType,
} from './entities/stagnation-dispatch.entity';

/**
 * Historique des rappels de stagnation d'UNE DI. La collection est cléée par la
 * référence HUMAINE (`_idnum`, ex. « T114 »), pas par `_id` — c'est donc bien
 * `idNum` qu'on interroge ici. Lecture seule : les écritures restent le fait du
 * cron quotidien, qui garde son idempotence `{date, idNum, status}`.
 */
@Resolver(() => StagnationDispatchType)
export class StagnationDispatchResolver {
  constructor(
    @InjectModel(StagnationDispatch.name)
    private readonly dispatchModel: Model<StagnationDispatch>,
  ) {}

  @Query(() => [StagnationDispatchType])
  async diStagnationHistory(
    @Args('idNum') idNum: string,
    @Args('limit', { type: () => Int, nullable: true }) limit?: number,
  ): Promise<StagnationDispatchType[]> {
    if (!idNum) return [];
    const rows = await this.dispatchModel
      .find({ idNum })
      .sort({ date: -1 })
      .limit(Math.min(Math.max(limit ?? 100, 1), 365))
      .lean();
    return (rows as any[]).map((r) => ({
      date: r.date,
      idNum: r.idNum,
      status: r.status,
      ageHours: r.ageHours ?? null,
      sentAt: r.sentAt ?? null,
    }));
  }
}
