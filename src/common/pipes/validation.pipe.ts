import { ValidationPipe, type ValidationError } from '@nestjs/common'
import { StructuralValidationError } from '../filters/problem.filter'

const flatten = (errors: ValidationError[], parent = ''): { field: string; message: string }[] =>
  errors.flatMap((e) => {
    const field = parent ? `${parent}.${e.property}` : e.property
    const own = Object.values(e.constraints ?? {}).map((message) => ({ field, message }))
    return [...own, ...flatten(e.children ?? [], field)]
  })

/**
 * Validación ESTRUCTURAL (class-validator): tipos, formatos y longitudes. NO sustituye las reglas de negocio,
 * que viven en los servicios de dominio (prompt §23). Campos desconocidos se rechazan (whitelist + forbidNonWhitelisted).
 */
export const structuralValidationPipe = () =>
  new ValidationPipe({
    whitelist: true,
    forbidNonWhitelisted: true,
    transform: true,
    transformOptions: { enableImplicitConversion: false },
    validationError: { target: false, value: false },
    exceptionFactory: (errors) => new StructuralValidationError(flatten(errors)),
  })
