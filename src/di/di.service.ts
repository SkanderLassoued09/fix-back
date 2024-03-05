import { Injectable } from '@nestjs/common';
import { CreateDiInput } from './dto/create-di.input';

@Injectable()
export class DiService {
  create(createDiInput: CreateDiInput) {
    return 'This action adds a new di';
  }
}
