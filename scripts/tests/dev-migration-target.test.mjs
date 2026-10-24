import { test } from 'node:test';
import assert from 'node:assert/strict';
import { devMigrationUrl } from '../ops/dev-migration-target.mjs';

const valid = 'postgresql://kalend_dev_migrator:fixture@127.0.0.1:5432/kalend_dev?schema=public';
test('accepts only the dedicated DEV migration destination', () => {
  assert.equal(devMigrationUrl(valid), valid);
  for (const bad of [undefined, '', valid.replace('/kalend_dev?', '/kalend?'),
    valid.replace('kalend_dev_migrator:', 'kalend:'), valid.replace('127.0.0.1', 'prod.kalend.tech'),
    valid.replace(':5432/', ':5433/'), valid + '&options=-c%20role%3Dkalend',
    valid.replace(':fixture@', '@'), valid.replace('schema=public', 'schema=other')]) {
    assert.throws(() => devMigrationUrl(bad));
  }
});
