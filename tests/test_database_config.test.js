'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const {
    resolveTestDatabaseConfig,
    assertDisposableTestDatabase
} = require('../scripts/lib/test-database-config');

describe('Development test database configuration', () => {
    it('accepts both supported disposable regression database prefixes', () => {
        for (const database of ['ui_audit_example', 'spark_disp_ent_20261011']) {
            assert.equal(assertDisposableTestDatabase({ NODE_ENV: 'test', DATABASE_NAME: database,
                DATABASE_HOST: 'localhost', DATABASE_USER: 'test-user' }).database, database);
        }
    });

    it('refuses production mode, arbitrary databases, protected names and URL conflicts', () => {
        const values = { NODE_ENV: 'test', DATABASE_NAME: 'ui_audit_example', DATABASE_USER: 'test-user' };
        for (const override of [{ NODE_ENV: 'production' }, { DATABASE_NAME: 'customer_records' },
            { DATABASE_NAME: 'admin' }, { DATABASE_URL: 'mysql://test-user@localhost/other_database' }]) {
            assert.throws(() => assertDisposableTestDatabase({ ...values, ...override }));
        }
    });
    it('uses the configured test database instead of the development database', () => {
        const config = resolveTestDatabaseConfig({
            DATABASE_HOST: 'localhost',
            DATABASE_PORT: '3306',
            DATABASE_USER: 'test-user',
            DATABASE_PASSWORD: 'test@password',
            DATABASE_NAME: 'spark_test_disposable'
        });

        assert.equal(config.database, 'spark_test_disposable');
        assert.equal(config.databaseUrl, 'mysql://test-user:test%40password@localhost:3306/spark_test_disposable');
    });

    it('derives missing test connection fields from the configured URL', () => {
        const config = resolveTestDatabaseConfig({
            DATABASE_URL: 'mysql://test-user:test%40password@localhost:3307/spark_test_disposable'
        });

        assert.equal(config.host, 'localhost');
        assert.equal(config.port, '3307');
        assert.equal(config.user, 'test-user');
        assert.equal(config.password, 'test@password');
        assert.equal(config.database, 'spark_test_disposable');
    });

    it('rejects protected test database targets', () => {
        assert.throws(
            () => resolveTestDatabaseConfig({
                DATABASE_NAME: 'spark_admin_test',
                DATABASE_HOST: 'localhost',
                DATABASE_USER: 'root'
            }),
            /protected database/
        );
    });

    it('rejects conflicting explicit database name and URL', () => {
        assert.throws(
            () => resolveTestDatabaseConfig({
                DATABASE_NAME: 'spark_test_disposable',
                DATABASE_URL: 'mysql://test-user:secret@localhost:3306/another_database'
            }),
            /does not match DATABASE_NAME/
        );
    });
});
