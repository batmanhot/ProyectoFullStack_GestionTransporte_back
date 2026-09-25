import { Module } from '@nestjs/common'
import { FilesController } from './files.controller'
import { FilesService } from './files.service'
import { LocalObjectStorage, ObjectStorage } from './object-storage'

@Module({
  controllers: [FilesController],
  providers: [FilesService, LocalObjectStorage, { provide: ObjectStorage, useExisting: LocalObjectStorage }],
  exports: [FilesService],
})
export class FilesModule {}
