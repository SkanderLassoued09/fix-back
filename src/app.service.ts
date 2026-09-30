import { Injectable } from '@nestjs/common';
import { withErrorContext } from './common/error-context';

@Injectable()
export class AppService {
  getHello(): string {
    try {
      return 'Hello World!';
    } catch (error) {
      throw withErrorContext(error, 'AppService.getHello');
    }
  }
}
