import {
  GUARDS_METADATA,
  METHOD_METADATA,
  PATH_METADATA,
} from '@nestjs/common/constants';
import { RequestMethod } from '@nestjs/common';
import { AdminGuard } from '../common/admin.guard.js';
import { CompaniesController } from './companies.controller.js';

describe('CompaniesController authorization', () => {
  it('protects every company route with the Super Admin guard', () => {
    expect(Reflect.getMetadata(GUARDS_METADATA, CompaniesController)).toContain(
      AdminGuard,
    );
  });

  it('exposes edit and delete only on an ID path under the guarded controller', () => {
    const prototype = CompaniesController.prototype;
    const update = Object.getOwnPropertyDescriptor(prototype, 'update')?.value;
    const remove = Object.getOwnPropertyDescriptor(prototype, 'remove')?.value;
    expect(Reflect.getMetadata(PATH_METADATA, update)).toBe(':id');
    expect(Reflect.getMetadata(PATH_METADATA, remove)).toBe(':id');
    expect(Reflect.getMetadata(METHOD_METADATA, update)).toBe(
      RequestMethod.PATCH,
    );
    expect(Reflect.getMetadata(METHOD_METADATA, remove)).toBe(
      RequestMethod.DELETE,
    );
    expect(Reflect.getMetadata(GUARDS_METADATA, CompaniesController)).toEqual([
      AdminGuard,
    ]);
  });
});
