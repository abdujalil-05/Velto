import { CanActivate, ExecutionContext, Injectable, UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { Reflector } from '@nestjs/core';
import { IS_PUBLIC_KEY } from '../decorators/public.decorator';
import type { AccessTokenPayload } from './auth.types';

/**
 * First line of defense: verifies the access token's signature and expiry
 * only — cheap, no DB access. Permission/role checks and loading the fresh
 * user record happen in TenantContextInterceptor, which also needs a DB
 * round trip anyway to open the RLS transaction.
 */
@Injectable()
export class JwtAuthGuard implements CanActivate {
  constructor(
    private readonly jwtService: JwtService,
    private readonly reflector: Reflector,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic) {
      return true;
    }

    const request = context.switchToHttp().getRequest();
    const token = this.extractToken(request.headers.authorization);
    if (!token) {
      throw new UnauthorizedException();
    }

    try {
      request.tokenPayload = await this.jwtService.verifyAsync<AccessTokenPayload>(token);
      return true;
    } catch {
      throw new UnauthorizedException();
    }
  }

  private extractToken(header: string | undefined): string | undefined {
    if (!header?.startsWith('Bearer ')) return undefined;
    return header.slice('Bearer '.length);
  }
}
