import { Injectable } from '@nestjs/common';
import { CreateRemarqueInput } from './dto/create-remarque.input';
import { withErrorContext } from '../common/error-context';

@Injectable()
export class RemarqueService {
  create(createRemarqueInput: CreateRemarqueInput) {
    try {
      return 'This action adds a new remarque';
    } catch (error) {
      throw withErrorContext(error, 'RemarqueService.create');
    }
  }

  findAll() {
    try {
      return `This action returns all remarque`;
    } catch (error) {
      throw withErrorContext(error, 'RemarqueService.findAll');
    }
  }

  findOne(id: number) {
    try {
      return `This action returns a #${id} remarque`;
    } catch (error) {
      throw withErrorContext(error, 'RemarqueService.findOne');
    }
  }

  remove(id: number) {
    try {
      return `This action removes a #${id} remarque`;
    } catch (error) {
      throw withErrorContext(error, 'RemarqueService.remove');
    }
  }
}
