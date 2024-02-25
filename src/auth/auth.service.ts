import {
  HttpException,
  HttpStatus,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { CreateAuthInput, LoginAuthInput } from './dto/create-auth.input';
import { UpdateAuthInput } from './dto/update-auth.input';
import { ProfileService } from 'src/profile/profile.service';
import * as bcrypt from 'bcrypt';
import { JwtService } from '@nestjs/jwt';
@Injectable()
export class AuthService {
  constructor(
    private profileService: ProfileService,
    private jwtService: JwtService,
  ) {}

  async validateUser(username: string, password: string): Promise<any> {
    let user = await this.profileService.findOneForAuth(username);

    if (!user) {
      // throw new HttpException(
      //   `${email} n'existe pas dans notre base de données`,
      // );
      throw new HttpException(
        `Nom d'utilisateur inexistant`,
        HttpStatus.UNAUTHORIZED,
      );
    }
    const matchPassword = await bcrypt.compare(password, user.password);
    if (!matchPassword) {
      // throw new UnauthorizedException(
      //   `Le mot de passe que vous avez saisi ne correspond pas à nos données`,
      // );
      throw new HttpException(
        'Mot de passe est incorrect',
        HttpStatus.UNAUTHORIZED,
      );
    }

    if (user) {
      const matchpassword = await bcrypt.compare(password, user.password);
      if (matchpassword) {
        const { password, ...result } = user;

        return result;
      }
    }
    // return null;
  }

  async login(loginAuthInput: LoginAuthInput) {
    const user = await this.profileService.findOneForAuth(
      loginAuthInput.username,
    );

    const { password, ...result } = user;

    return {
      access_token: this.jwtService.sign({
        email: user.email,
        username: user.username,
        role: user.role,
      }),
      user,
    };
  }
}
