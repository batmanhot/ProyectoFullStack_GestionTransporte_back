import { Inject, Injectable } from '@nestjs/common'
import * as bcrypt from 'bcrypt'
import { APP_CONFIG, type AppConfig } from '../../config/app-config'

/** Abstracción de hashing (prompt §5): el algoritmo se puede cambiar sin tocar los casos de uso. */
export abstract class PasswordHasher {
  abstract hash(plain: string): Promise<string>
  abstract verify(plain: string, hash: string): Promise<boolean>
}

@Injectable()
export class BcryptPasswordHasher extends PasswordHasher {
  constructor(@Inject(APP_CONFIG) private readonly config: AppConfig) {
    super()
  }
  hash(plain: string): Promise<string> {
    return bcrypt.hash(plain, this.config.auth.bcryptCost)
  }
  verify(plain: string, hash: string): Promise<boolean> {
    return bcrypt.compare(plain, hash)
  }
}

/**
 * Política mínima de contraseñas (SUPUESTO TÉCNICO: DOC-A no la define; DOC-G-SEC puede endurecerla, p. ej. MFA para roles
 * sensibles). ≥ 8 caracteres, con letras y números, sin espacios al inicio/fin.
 */
export function passwordProblems(pw: string): string | null {
  if (pw.length < 8) return 'La contraseña debe tener al menos 8 caracteres.'
  if (pw.length > 128) return 'La contraseña admite hasta 128 caracteres.'
  if (pw.trim() !== pw) return 'La contraseña no puede empezar ni terminar con espacios.'
  if (!/[A-Za-z]/.test(pw) || !/\d/.test(pw)) return 'La contraseña debe combinar letras y números.'
  return null
}
