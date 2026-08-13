import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document } from 'mongoose';

/**
 * Compteur atomique générique (collection `counters`). Un document par séquence,
 * `_id` = nom logique (ex. `di_ref` pour la référence DI `T{n}`). L'atomicité
 * vient du `findOneAndUpdate({ _id }, { $inc: { seq: 1 } })` mono-document :
 * deux créations concurrentes obtiennent deux valeurs distinctes — fin du
 * `max+1` en lecture qui pouvait produire des doublons sous concurrence.
 */
@Schema({ collection: 'counters' })
export class CounterDocument extends Document {
  @Prop()
  _id: string;

  @Prop({ default: 0 })
  seq: number;
}

export const CounterSchema = SchemaFactory.createForClass(CounterDocument);
